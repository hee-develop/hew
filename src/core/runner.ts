/** 에이전트 실행기: 상태를 보고 다음 역할을 claude 자식 프로세스로 띄우고, 상태 변화를 확인하며 되풀이한다. */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ProducedBy } from "./envelope.js";
import { HewError, usageError } from "./errors.js";
import { loadCollectConfig } from "./collect/config.js";
import { appendEvent } from "./events.js";
import { readJsonFile, writeJsonAtomic } from "./fsx.js";
import { nextAction, type NextAction } from "./next.js";
import { buildPacket, hewBinPath, planPacket, type Purpose } from "./packet.js";
import { HEW_ROOT, findingsBatchPath, findingsPath, runPaths } from "./paths.js";
import { roleConfig, type RoleConfig, type RoleName } from "./roles.js";
import { loadRun, type Run } from "./run.js";
import { createPlan } from "./sasu/plan.js";
import type { SasuTarget } from "./sasu/types.js";
import { currentRound, isBatchSubmitted, loadPlan, pendingBatches } from "./sasu/store.js";
import { RUN_STATES, type RunState } from "./state-machine.js";

/** 같은 일을 시도하는 총 횟수(처음 1회 + 재시도 2회). */
export const MAX_ATTEMPTS = 3;
export const DEFAULT_MAX_STEPS = 40;
const RESULT_LIMIT = 2000;
const KILL_GRACE_MS = 3000;
const GUARD_MATCHER = "Read|Write|Edit|NotebookEdit|Bash|Task|Agent|WebFetch|WebSearch|Skill|mcp__.*";
const COLLECTOR_GUARD_MATCHER = `${GUARD_MATCHER}|ToolSearch`;
const RECORD_MATCHER = "mcp__.*";
const FIXED_PROMPT_TAIL = "를 읽고 그대로 수행하라. 끝까지 진행하고, 제출이 통과하면 한 문단으로 보고하라.";

export interface RunnerOptions {
  runDir: string;
  until?: string;
  maxSteps?: number;
  dry?: boolean;
  env?: NodeJS.ProcessEnv;
  /** 역할 설정의 제한 시간을 덮어쓴다(밀리초). */
  timeoutMs?: number;
}

export interface SpawnPlan {
  bin: string;
  args: string[];
  cwd: string;
  /** 부모 환경에 더해 자식에게 주는 환경 변수. */
  env: Record<string, string>;
  role: RoleName;
  purpose: Purpose;
  model: string;
  effort: string | null;
  packet: string;
  work_dir: string;
  settings: string;
  timeout_ms: number;
}

export interface StepRecord {
  role: RoleName;
  purpose: Purpose;
  attempt: number;
  packet: string;
  exit_code: number | null;
  timed_out: boolean;
  session_id: string | null;
  cost_usd: number | null;
  progressed: boolean;
}

export type RunOutcome =
  | "until_reached"
  | "stopped"
  | "max_steps"
  | "role_missing"
  | "dry";

export interface RunnerResult {
  outcome: RunOutcome;
  state: RunState;
  next: NextAction;
  steps: StepRecord[];
  launches: number;
  message: string;
  dry: SpawnPlan | null;
}

interface ClaudeResult {
  total_cost_usd: number | null;
  num_turns: number | null;
  session_id: string | null;
  is_error: boolean | null;
  duration_ms: number | null;
  result: string | null;
}

interface ExecOutcome {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  startedAt: string;
  endedAt: string;
  spawnError: string | null;
}

const claudeBin = (env: NodeJS.ProcessEnv): string => (env.HEW_CLAUDE_BIN && env.HEW_CLAUDE_BIN.length > 0 ? env.HEW_CLAUDE_BIN : "claude");

/** 역할 정의 파일의 마지막 커밋 SHA. 알 수 없으면 null. */
export function roleSha(role: string): string | null {
  const r = spawnSync("git", ["log", "-1", "--format=%H", "--", `agents/${role}.md`], { cwd: HEW_ROOT, encoding: "utf8" });
  const sha = r.status === 0 ? r.stdout.trim() : "";
  return sha.length > 0 ? sha : null;
}

const expandHome = (p: string): string => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** claude 에 넘길 인자와 환경 변수를 만든다. 파일은 쓰지 않는다. */
export function buildSpawnPlan(
  runDir: string,
  run: Run,
  role: RoleName,
  purpose: Purpose,
  config: RoleConfig,
  packet: { path: string; workDir: string },
  env: NodeJS.ProcessEnv,
  timeoutMs?: number,
): SpawnPlan {
  const settings = join(packet.workDir, "settings.json");
  const args = [
    "-p", `${packet.path}${FIXED_PROMPT_TAIL}`,
    "--agent", `hew:${role}`,
    "--plugin-dir", HEW_ROOT,
    "--model", config.model,
    ...(config.effort !== null ? ["--effort", config.effort] : []),
    "--permission-mode", "dontAsk",
    "--settings", settings,
    "--output-format", "json",
    ...(config.isolated ? ["--setting-sources", "project,local", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'] : []),
  ];
  const sasu = role === "manager-sasu" || role === "ticket-sasu";
  const collector = role === "collector";
  const collect = collector ? loadCollectConfig() : null;
  if (collect !== null) {
    const names = collect.mcp_allow.filter((n) => /^[A-Za-z0-9_-]+$/.test(n));
    args.push("--allowedTools", ["ToolSearch", ...names].join(","));
  }
  const readRoots = [
    runDir,
    ...(!sasu && !collector && run.repo.path !== null ? [resolve(expandHome(run.repo.path))] : []),
    join(HEW_ROOT, "refs"),
    ...(role === "ticket-maker" ? [join(HEW_ROOT, "rules")] : []),
  ];
  const producedBy: ProducedBy = { role, model: config.model, effort: config.effort, role_sha: roleSha(role), session_id: null };
  return {
    bin: claudeBin(env),
    args,
    cwd: runDir,
    env: {
      HEW_GUARD_READ_ROOTS: readRoots.join(":"),
      HEW_GUARD_WRITE_ROOTS: packet.workDir,
      HEW_GUARD_RUN_DIR: runDir,
      HEW_GUARD_HEW_BIN: hewBinPath(),
      HEW_GUARD_LOG: join(packet.workDir, "guard.jsonl"),
      HEW_PRODUCED_BY: JSON.stringify(producedBy),
      ...(collect === null
        ? {}
        : {
            HEW_RECORD_DIR: join(packet.workDir, "calls"),
            HEW_GUARD_PROFILE: "collector",
            HEW_GUARD_MODE: run.mode,
            HEW_GUARD_BLOCK: JSON.stringify({ jira_keys: run.case_info?.block.jira_keys ?? [], pr_numbers: run.case_info?.block.pr_numbers ?? [] }),
            HEW_GUARD_MCP_ALLOW: collect.mcp_allow.join(","),
            HEW_GUARD_CURL_HOSTS: collect.curl_hosts.join(","),
          }),
    },
    role,
    purpose,
    model: config.model,
    effort: config.effort,
    packet: packet.path,
    work_dir: packet.workDir,
    settings,
    timeout_ms: timeoutMs ?? Math.round(config.timeout_minutes * 60_000),
  };
}

/** 실행용 설정 파일을 쓴다. PreToolUse(범위 훅)를 넣고, 수집 역할에는 도구 결과를 받아 적는 PostToolUse 도 넣는다. */
function writeSettings(path: string, role: RoleName): void {
  const guard = `node "${join(HEW_ROOT, "hooks", "guard.mjs")}"`;
  const collector = role === "collector";
  const hooks: Record<string, unknown> = {
    PreToolUse: [{ matcher: collector ? COLLECTOR_GUARD_MATCHER : GUARD_MATCHER, hooks: [{ type: "command", command: guard }] }],
  };
  if (collector) hooks.PostToolUse = [{ matcher: RECORD_MATCHER, hooks: [{ type: "command", command: `node "${join(HEW_ROOT, "hooks", "record.mjs")}"` }] }];
  writeJsonAtomic(path, { hooks });
}

function execClaude(plan: SpawnPlan, parentEnv: NodeJS.ProcessEnv): Promise<ExecOutcome> {
  return new Promise((done) => {
    const startedAt = new Date().toISOString();
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let spawnError: string | null = null;
    const child = spawn(plan.bin, plan.args, { cwd: plan.cwd, env: { ...parentEnv, ...plan.env }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    }, plan.timeout_ms);
    const finish = (code: number | null, signal: string | null): void => {
      clearTimeout(timer);
      done({
        code,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
        startedAt,
        endedAt: new Date().toISOString(),
        spawnError,
      });
    };
    child.on("error", (e) => {
      spawnError = e.message;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** claude 의 JSON 출력에서 비용·세션 정보를 읽는다. 읽을 수 없으면 null 칸으로 채운다. */
export function parseClaudeResult(stdout: string): ClaudeResult {
  const empty: ClaudeResult = { total_cost_usd: null, num_turns: null, session_id: null, is_error: null, duration_ms: null, result: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return empty;
  }
  const obj = Array.isArray(parsed)
    ? [...parsed].reverse().find((e) => e !== null && typeof e === "object" && (e as Record<string, unknown>).type === "result")
    : parsed;
  if (obj === null || typeof obj !== "object") return empty;
  const r = obj as Record<string, unknown>;
  return {
    total_cost_usd: num(r.total_cost_usd),
    num_turns: num(r.num_turns),
    session_id: typeof r.session_id === "string" ? r.session_id : null,
    is_error: typeof r.is_error === "boolean" ? r.is_error : null,
    duration_ms: num(r.duration_ms),
    result: typeof r.result === "string" ? r.result.slice(0, RESULT_LIMIT) : null,
  };
}

const progressKey = (run: Run): string => JSON.stringify({ state: run.state, submissions: run.submissions });

/** 이번 실행 전후로 제출 기록이 바뀐 정본 파일 경로들. */
function changedDocs(runDir: string, before: Run, after: Run): string[] {
  const p = runPaths(runDir);
  const out: string[] = [];
  const keys = ["analysis", "scenarios", "plan", "findings_analysis", "findings_plan"] as const;
  for (const key of keys) {
    const a = after.submissions[key];
    if (a === undefined || JSON.stringify(a) === JSON.stringify(before.submissions[key])) continue;
    if (key === "analysis") out.push(p.analysis);
    else if (key === "scenarios") out.push(p.scenarios);
    else if (key === "plan") out.push(p.plan);
    else out.push(findingsPath(p, key === "findings_plan" ? "plan" : "analysis", a.attempt));
  }
  return out;
}

/** 정본 틀의 produced_by.session_id 와 cost 를 채워 다시 쓴다(revision 계산에 들어가지 않는 칸). */
function fillProvenance(files: string[], base: SpawnPlan, sessionId: string | null, usd: number | null, durationMs: number | null): void {
  for (const file of files) {
    if (!existsSync(file)) continue;
    const doc = readJsonFile(file) as Record<string, unknown>;
    const existing = doc.produced_by !== null && typeof doc.produced_by === "object" ? (doc.produced_by as Record<string, unknown>) : null;
    const fallback = JSON.parse(base.env.HEW_PRODUCED_BY ?? "{}") as Record<string, unknown>;
    doc.produced_by = { ...(existing ?? fallback), session_id: sessionId };
    doc.cost = { usd, duration_ms: durationMs };
    writeJsonAtomic(file, doc);
  }
}

const sum = (values: (number | null)[]): number | null => {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
};

function describeStop(next: NextAction): string {
  switch (next.action) {
    case "sasu": return next.for === "plan" ? "분해안 사수 단계입니다" : "분석 사수 단계입니다";
    case "publish_gate": return `게이트(${next.phase}) 게시 차례입니다`;
    case "wait_human": return `사람의 ${next.for === "answers" ? "답" : "승인"}을 기다립니다`;
    case "done": return "끝났습니다";
    case "spawn": return `${next.role} 를 띄울 차례입니다`;
  }
}

/** 다음 일이 사람 차례이거나 이 조각 밖이면 되풀이를 멈추고 돌려준다. */
export async function runLoop(opts: RunnerOptions): Promise<RunnerResult> {
  const env = opts.env ?? process.env;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  if (opts.until !== undefined && !(RUN_STATES as readonly string[]).includes(opts.until)) {
    throw usageError(`--until 은 ${RUN_STATES.join("|")} 중 하나여야 합니다: ${opts.until}`);
  }
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw usageError("--max-steps 는 1 이상의 정수여야 합니다");
  const paths = runPaths(opts.runDir);
  const steps: StepRecord[] = [];
  let launches = 0;

  const result = (outcome: RunOutcome, run: Run, next: NextAction, message: string, dry: SpawnPlan | null = null): RunnerResult => ({
    outcome, state: run.state, next, steps, launches, message, dry,
  });

  /** 역할 하나를 새 세션으로 한 번 띄우고 비용·이벤트·단계 기록을 남긴다. */
  const launchOnce = async (
    role: RoleName,
    purpose: Purpose,
    config: RoleConfig,
    attemptNo: number,
    progressedOf: (before: Run, after: Run) => boolean,
    batch?: number,
  ): Promise<{ plan: SpawnPlan; parsed: ClaudeResult; progressed: boolean; timedOut: boolean }> => {
    launches += 1;
    const before = loadRun(opts.runDir);
    const packet = buildPacket({ runDir: opts.runDir, role, purpose, env, batch });
    mkdirSync(packet.workDir, { recursive: true });
    const plan = buildSpawnPlan(opts.runDir, before, role, purpose, config, packet, env, opts.timeoutMs);
    writeSettings(plan.settings, role);
    const exec = await execClaude(plan, env);
    writeFileSync(join(packet.workDir, "stdout.json"), exec.stdout, "utf8");
    writeFileSync(join(packet.workDir, "stderr.txt"), exec.spawnError !== null ? `${exec.stderr}${exec.spawnError}\n` : exec.stderr, "utf8");
    const parsed = parseClaudeResult(exec.stdout);
    const after = loadRun(opts.runDir);
    const progressed = progressedOf(before, after);
    appendFileSync(
      paths.costs,
      `${JSON.stringify({
        role, purpose, model: config.model, effort: config.effort, attempt: attemptNo, packet: packet.path,
        ...(batch !== undefined ? { batch } : {}),
        started_at: exec.startedAt, ended_at: exec.endedAt, exit_code: exec.code, timed_out: exec.timedOut,
        total_cost_usd: parsed.total_cost_usd, num_turns: parsed.num_turns, session_id: parsed.session_id,
        is_error: parsed.is_error, duration_ms: parsed.duration_ms, result: parsed.result,
      })}\n`,
      "utf8",
    );
    appendEvent(paths.events, "agent_finished", {
      role, purpose, attempt: attemptNo, packet: packet.path, ...(batch !== undefined ? { batch } : {}), exit_code: exec.code,
      timed_out: exec.timedOut, session_id: parsed.session_id, total_cost_usd: parsed.total_cost_usd, is_error: parsed.is_error,
      progressed, from: before.state, to: after.state,
    });
    steps.push({
      role, purpose, attempt: attemptNo, packet: packet.path, exit_code: exec.code, timed_out: exec.timedOut,
      session_id: parsed.session_id, cost_usd: parsed.total_cost_usd, progressed,
    });
    return { plan, parsed, progressed, timedOut: exec.timedOut };
  };

  /** 이번 회차의 사수 묶음을 순서대로 하나씩 띄운다. 모든 묶음이 끝나면 회차 완료 처리로 상태가 바뀐다. */
  const runSasuRound = async (target: SasuTarget): Promise<"done" | "max_steps"> => {
    const role: RoleName = target === "analysis" ? "manager-sasu" : "ticket-sasu";
    const config = roleConfig(role, env);
    const created = createPlan(opts.runDir, target, new Date(), null);
    if (created.completed !== null) return "done";
    const round = created.plan.round;
    const costs: (number | null)[] = [];
    const durations: (number | null)[] = [];
    let lastPlan: SpawnPlan | null = null;
    let lastSession: string | null = null;
    for (const batch of pendingBatches(opts.runDir, created.plan)) {
      let submitted = false;
      let attemptsMade = 0;
      let timedOut = false;
      while (attemptsMade < MAX_ATTEMPTS && !submitted) {
        if (launches >= maxSteps) return "max_steps";
        attemptsMade += 1;
        const r = await launchOnce(role, "first", config, attemptsMade, () => isBatchSubmitted(opts.runDir, round, batch.k, target), batch.k);
        costs.push(r.parsed.total_cost_usd);
        durations.push(r.parsed.duration_ms);
        lastPlan = r.plan;
        lastSession = r.parsed.session_id;
        timedOut = r.timedOut;
        submitted = r.progressed;
        if (submitted) {
          fillProvenance([findingsBatchPath(paths, target, round, batch.k)], r.plan, r.parsed.session_id, r.parsed.total_cost_usd, r.parsed.duration_ms);
        }
      }
      if (!submitted) {
        appendEvent(paths.events, "agent_failed", { role, purpose: "first", batch: batch.k, attempts: attemptsMade });
        const why = timedOut ? "시간 제한 초과" : "묶음 제출이 없음";
        throw new HewError("external", `${role} 묶음 ${batch.k} 실행이 ${attemptsMade}회 모두 실패했습니다(마지막 사유: ${why}). 작업 폴더의 stdout.json·stderr.txt 를 확인하세요: ${lastPlan?.work_dir ?? ""}`);
      }
    }
    if (lastPlan !== null) fillProvenance([findingsPath(paths, target, round)], lastPlan, lastSession, sum(costs), sum(durations));
    return "done";
  };

  for (;;) {
    const run = loadRun(opts.runDir);
    const next = nextAction(run.state, { rework: run.rework, progress: run.progress });
    if (opts.until !== undefined && run.state === opts.until) return result("until_reached", run, next, `상태 ${run.state} 에 닿아 멈춥니다`);
    if (next.action === "sasu") {
      const target = next.for;
      const sasuRole: RoleName = target === "analysis" ? "manager-sasu" : "ticket-sasu";
      if (!existsSync(join(HEW_ROOT, "agents", `${sasuRole}.md`))) {
        return result("role_missing", run, next, `역할 정의 파일(agents/${sasuRole}.md)이 없어 ${sasuRole} 를 띄울 수 없습니다`);
      }
      if (opts.dry === true) {
        const plan = loadPlan(opts.runDir, currentRound(run, target), target);
        const pending = plan === null ? [] : pendingBatches(opts.runDir, plan);
        const first = pending[0];
        if (first === undefined) return result("dry", run, next, `사수 계획이 아직 없습니다. hew sasu plan --for ${target} 로 만든 뒤 다시 보세요`);
        const config = roleConfig(sasuRole, env);
        const planned = planPacket(opts.runDir, sasuRole);
        const dry = buildSpawnPlan(opts.runDir, run, sasuRole, "first", config, planned, env, opts.timeoutMs);
        return result("dry", run, next, `${sasuRole}(묶음 ${first.k}) 를 띄울 명령을 출력만 합니다`, dry);
      }
      if ((await runSasuRound(target)) === "max_steps") return result("max_steps", loadRun(opts.runDir), next, `띄우는 횟수 상한(${maxSteps})에 닿아 멈춥니다`);
      continue;
    }
    if (next.action !== "spawn") return result("stopped", run, next, describeStop(next));
    const role = next.role;
    if (!existsSync(join(HEW_ROOT, "agents", `${role}.md`))) {
      return result("role_missing", run, next, `역할 정의 파일(agents/${role}.md)이 없어 ${role} 를 띄울 수 없습니다`);
    }
    const config = roleConfig(role, env);
    const purpose = next.purpose;

    if (opts.dry === true) {
      const plan = planPacket(opts.runDir, role);
      const dry = buildSpawnPlan(opts.runDir, run, role, purpose, config, plan, env, opts.timeoutMs);
      return result("dry", run, next, `${role} 를 띄울 명령을 출력만 합니다`, dry);
    }

    let attemptsMade = 0;
    let progressedRun: Run | null = null;
    const attemptCosts: (number | null)[] = [];
    const attemptDurations: (number | null)[] = [];
    let lastPlan: SpawnPlan | null = null;
    let lastSession: string | null = null;

    while (attemptsMade < MAX_ATTEMPTS) {
      if (launches >= maxSteps) return result("max_steps", loadRun(opts.runDir), next, `띄우는 횟수 상한(${maxSteps})에 닿아 멈춥니다`);
      attemptsMade += 1;
      const before = loadRun(opts.runDir);
      const r = await launchOnce(role, purpose, config, attemptsMade, (b, a) => progressKey(b) !== progressKey(a));
      attemptCosts.push(r.parsed.total_cost_usd);
      attemptDurations.push(r.parsed.duration_ms);
      lastPlan = r.plan;
      lastSession = r.parsed.session_id;
      if (r.progressed) {
        const after = loadRun(opts.runDir);
        progressedRun = after;
        fillProvenance(changedDocs(opts.runDir, before, after), r.plan, lastSession, sum(attemptCosts), sum(attemptDurations));
        break;
      }
    }

    if (progressedRun === null) {
      appendEvent(paths.events, "agent_failed", { role, purpose, attempts: attemptsMade });
      const last = steps[steps.length - 1];
      const why = last?.timed_out ? "시간 제한 초과" : "상태와 제출 기록이 바뀌지 않음";
      throw new HewError("external", `${role} 실행이 ${attemptsMade}회 모두 실패했습니다(마지막 사유: ${why}). 작업 폴더의 stdout.json·stderr.txt 를 확인하세요: ${lastPlan?.work_dir ?? ""}`);
    }
  }
}
