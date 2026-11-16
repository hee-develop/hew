import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HewError } from "../src/core/errors.js";
import { readEvents } from "../src/core/events.js";
import { HEW_ROOT, runPaths } from "../src/core/paths.js";
import { computeRevision } from "../src/core/revision.js";
import { loadRun } from "../src/core/run.js";
import { buildSpawnPlan, parseClaudeResult, runLoop } from "../src/core/runner.js";
import { roleConfig } from "../src/core/roles.js";
import { setupRun } from "./analysis-fixtures.js";
import { makeRun, useTempRunsDir } from "./helpers.js";
import { EXAMPLE_DOC, FAKE_HEKA, exampleUnits, makeFakeClaude, readCalls, tempDir } from "./runner-helpers.js";

const runs = useTempRunsDir();
const fakeClaude = makeFakeClaude();

function fakeEnv(mode: string, extra: Record<string, string> = {}): { env: NodeJS.ProcessEnv; log: string } {
  const log = tempDir("hew-fake-log-");
  return {
    log,
    env: {
      ...process.env,
      HEW_RUNS_DIR: runs.dir,
      HEW_CLAUDE_BIN: fakeClaude,
      HEW_HEKA_BIN: FAKE_HEKA,
      FAKE_CLAUDE_MODE: mode,
      FAKE_CLAUDE_LOG: log,
      FAKE_CLAUDE_DOC: EXAMPLE_DOC,
      ...extra,
    },
  };
}

const lines = (file: string): Record<string, any>[] =>
  readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);

describe("실행기: 가짜 claude 로 collected → analyzed", () => {
  it("(a) 제출이 통과해 analyzed 가 되고 costs·이벤트·produced_by 가 채워진다", async () => {
    const { dir } = setupRun({ units: exampleUnits() });
    const { env, log } = fakeEnv("submit");
    const result = await runLoop({ runDir: dir, until: "analyzed", env });
    expect(result).toMatchObject({ outcome: "until_reached", state: "analyzed", launches: 1 });
    expect(loadRun(dir).state).toBe("analyzed");

    const p = runPaths(dir);
    const costs = lines(p.costs);
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({
      role: "technical-manager", purpose: "first", model: "claude-opus-5-5", effort: "high", attempt: 1,
      exit_code: 0, timed_out: false, total_cost_usd: 0.0123, num_turns: 3, session_id: "sess-1", is_error: false, duration_ms: 1234, result: "완료",
    });
    expect(costs[0]?.packet).toBe(join(p.packets, "technical-manager-1.md"));
    expect(costs[0]?.started_at).toBeTruthy();
    expect(costs[0]?.ended_at).toBeTruthy();

    const finished = readEvents(p.events).filter((e) => e.type === "agent_finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]?.data).toMatchObject({ role: "technical-manager", session_id: "sess-1", progressed: true, from: "collected", to: "analyzed" });

    const doc = JSON.parse(readFileSync(p.analysis, "utf8")) as Record<string, any>;
    expect(doc.produced_by).toMatchObject({ role: "technical-manager", model: "claude-opus-5-5", effort: "high", session_id: "sess-1" });
    expect(doc.produced_by.role_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(doc.cost).toEqual({ usd: 0.0123, duration_ms: 1234 });

    const work = join(p.work, "technical-manager-1");
    expect(readFileSync(join(work, "stdout.json"), "utf8")).toContain("sess-1");
    expect(existsSync(join(work, "stderr.txt"))).toBe(true);
    expect(existsSync(join(work, "analysis.json"))).toBe(true);
    expect(readCalls(log)).toHaveLength(1);
  });

  it("session_id·cost 를 다시 써도 revision 은 변하지 않는다", async () => {
    const { dir } = setupRun({ units: exampleUnits() });
    const { env } = fakeEnv("submit");
    await runLoop({ runDir: dir, until: "analyzed", env });
    const doc = JSON.parse(readFileSync(runPaths(dir).analysis, "utf8")) as Record<string, any>;
    expect(doc.produced_by.session_id).toBe("sess-1");
    expect(loadRun(dir).revision).toBe(computeRevision(dir));
  });

  it("자식에게 넘긴 인자와 환경 변수(훅 설정, produced_by)가 기록된다", async () => {
    const repoDir = tempDir("hew-repo-");
    const { dir } = setupRun({ units: exampleUnits(), repoPath: repoDir });
    const { env, log } = fakeEnv("submit");
    await runLoop({ runDir: dir, until: "analyzed", env });
    const call = readCalls(log)[0];
    expect(call).toBeDefined();
    const argv = call?.argv ?? [];
    const p = runPaths(dir);
    expect(argv[0]).toBe("-p");
    expect(argv[1]).toBe(`${join(p.packets, "technical-manager-1.md")}를 읽고 그대로 수행하라. 끝까지 진행하고, 제출이 통과하면 한 문단으로 보고하라.`);
    const flag = (name: string): string | undefined => argv[argv.indexOf(name) + 1];
    expect(flag("--agent")).toBe("hew:technical-manager");
    expect(flag("--plugin-dir")).toBe(HEW_ROOT);
    expect(flag("--model")).toBe("claude-opus-5-5");
    expect(flag("--effort")).toBe("high");
    expect(flag("--permission-mode")).toBe("dontAsk");
    expect(flag("--output-format")).toBe("json");
    expect(flag("--setting-sources")).toBe("project,local");
    expect(argv).toContain("--strict-mcp-config");
    expect(flag("--mcp-config")).toBe('{"mcpServers":{}}');
    const settings = flag("--settings") ?? "";
    expect(settings).toBe(join(p.work, "technical-manager-1", "settings.json"));
    const hook = (JSON.parse(readFileSync(settings, "utf8")) as any).hooks.PreToolUse[0];
    expect(hook.matcher).toBe("Read|Write|Edit|NotebookEdit|Bash|Task|Agent|WebFetch|WebSearch|Skill|mcp__.*");
    expect(hook.hooks[0].command).toContain(join(HEW_ROOT, "hooks", "guard.mjs"));
    expect(call?.cwd.endsWith(dir.split("/").pop() ?? "")).toBe(true);
    expect(call?.env.HEW_GUARD_READ_ROOTS).toBe([dir, repoDir, join(HEW_ROOT, "refs")].join(":"));
    expect(call?.env.HEW_GUARD_WRITE_ROOTS).toBe(join(p.work, "technical-manager-1"));
    expect(call?.env.HEW_GUARD_RUN_DIR).toBe(dir);
    expect(call?.env.HEW_GUARD_HEW_BIN).toBe(join(HEW_ROOT, "bin", "hew"));
    expect(JSON.parse(call?.env.HEW_PRODUCED_BY ?? "{}")).toMatchObject({ role: "technical-manager", model: "claude-opus-5-5", effort: "high", session_id: null });
  });

  it("(b) 아무것도 제출하지 않으면 3회 시도 뒤 종료 5 로 멈춘다", async () => {
    const { dir } = setupRun({ units: exampleUnits() });
    const { env, log } = fakeEnv("noop");
    const error = await runLoop({ runDir: dir, env }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HewError);
    expect((error as HewError).exitCode).toBe(5);
    expect(readCalls(log)).toHaveLength(3);
    expect(lines(runPaths(dir).costs)).toHaveLength(3);
    expect(loadRun(dir).state).toBe("collected");
    expect(readEvents(runPaths(dir).events).some((e) => e.type === "agent_failed")).toBe(true);
    expect(readdirSync(runPaths(dir).packets).sort()).toEqual(["technical-manager-1.md", "technical-manager-2.md", "technical-manager-3.md"]);
  });

  it("(c) 처음 한 번 실패하고 두 번째에 제출하면 재시도로 성공한다", async () => {
    const { dir } = setupRun({ units: exampleUnits() });
    const { env, log } = fakeEnv("fail_once");
    const result = await runLoop({ runDir: dir, until: "analyzed", env });
    expect(result).toMatchObject({ outcome: "until_reached", state: "analyzed", launches: 2 });
    expect(readCalls(log)).toHaveLength(2);
    const costs = lines(runPaths(dir).costs);
    expect(costs.map((c) => [c.attempt, c.exit_code])).toEqual([[1, 1], [2, 0]]);
    expect(result.steps.map((s) => s.progressed)).toEqual([false, true]);
  });

  it("(d) 시간 제한을 넘기면 프로세스를 끝내고 실패로 친다", async () => {
    const { dir } = setupRun({ units: exampleUnits() });
    const { env } = fakeEnv("timeout");
    const error = await runLoop({ runDir: dir, env, timeoutMs: 300 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HewError);
    expect((error as HewError).message).toContain("시간 제한 초과");
    const costs = lines(runPaths(dir).costs);
    expect(costs).toHaveLength(3);
    expect(costs.every((c) => c.timed_out === true)).toBe(true);
    expect(loadRun(dir).state).toBe("collected");
  }, 30000);

  it("--max-steps 에 닿으면 멈춘다", async () => {
    const { dir } = setupRun({ units: exampleUnits() });
    const { env, log } = fakeEnv("noop");
    const result = await runLoop({ runDir: dir, env, maxSteps: 1 });
    expect(result.outcome).toBe("max_steps");
    expect(readCalls(log)).toHaveLength(1);
  });

  it("--max-steps 가 정수가 아니면 사용법 오류", async () => {
    const { dir } = setupRun({ units: exampleUnits() });
    await expect(runLoop({ runDir: dir, maxSteps: 0 })).rejects.toThrow(/--max-steps/);
  });
});

describe("실행기: 인자 구성", () => {
  let planCount = 0;
  const plan = (role: Parameters<typeof roleConfig>[0], env: NodeJS.ProcessEnv = {}) => {
    const { dir, run } = makeRun("collected", {}, `plan-${++planCount}`);
    return buildSpawnPlan(dir, run, role as any, "first", roleConfig(role, env), { path: "/p/x.md", workDir: "/w/x" }, { HEW_CLAUDE_BIN: "/bin/claude" }, undefined);
  };

  it("isolated 역할은 사용자 설정 없이 띄우는 인자를 붙인다", () => {
    const a = plan("technical-manager");
    expect(a.bin).toBe("/bin/claude");
    expect(a.args).toContain("--strict-mcp-config");
    expect(a.args).toContain("--setting-sources");
    expect(a.timeout_ms).toBe(90 * 60_000);
  });

  it("isolated 가 아닌 역할(collector)은 그 인자를 붙이지 않는다", () => {
    const a = plan("collector");
    for (const f of ["--setting-sources", "--strict-mcp-config", "--mcp-config"]) expect(a.args).not.toContain(f);
    expect(a.args).toContain("--effort");
  });

  it("effort 가 없는 역할은 --effort 를 붙이지 않는다", () => {
    expect(plan("manager-sasu").args).not.toContain("--effort");
    expect(plan("manager-sasu", { HEW_EFFORT_MANAGER_SASU: "low" }).args).toContain("low");
  });

  it("HEW_MODEL_·HEW_EFFORT_ 환경 변수가 모델·effort 를 덮어쓴다", () => {
    const a = plan("technical-manager", { HEW_MODEL_TECHNICAL_MANAGER: "claude-fable-5-2", HEW_EFFORT_TECHNICAL_MANAGER: "medium" });
    expect(a.args[a.args.indexOf("--model") + 1]).toBe("claude-fable-5-2");
    expect(a.args[a.args.indexOf("--effort") + 1]).toBe("medium");
    expect(JSON.parse(a.env.HEW_PRODUCED_BY ?? "{}")).toMatchObject({ model: "claude-fable-5-2", effort: "medium" });
  });

  it("claude 결과 JSON 을 읽는다(객체, 배열, 깨진 출력)", () => {
    expect(parseClaudeResult('{"total_cost_usd":1.5,"num_turns":2,"session_id":"s","is_error":true,"duration_ms":9,"result":"x"}')).toMatchObject({ total_cost_usd: 1.5, session_id: "s", is_error: true });
    expect(parseClaudeResult('[{"type":"system"},{"type":"result","session_id":"z","total_cost_usd":0.1}]').session_id).toBe("z");
    expect(parseClaudeResult("garbage")).toMatchObject({ total_cost_usd: null, session_id: null, result: null });
    expect(parseClaudeResult(JSON.stringify({ result: "가".repeat(3000) })).result).toHaveLength(2000);
  });
});

describe("실행기: --dry, --until, 멈추는 곳", () => {
  it("--dry 는 띄우지 않고 인자 배열과 환경 변수만 돌려준다", async () => {
    const { dir } = setupRun({ units: exampleUnits() });
    const { env, log } = fakeEnv("submit");
    const result = await runLoop({ runDir: dir, dry: true, env });
    expect(result.outcome).toBe("dry");
    expect(result.dry?.args.slice(0, 2)).toEqual(["-p", `${join(runPaths(dir).packets, "technical-manager-1.md")}를 읽고 그대로 수행하라. 끝까지 진행하고, 제출이 통과하면 한 문단으로 보고하라.`]);
    expect(result.dry?.env.HEW_GUARD_RUN_DIR).toBe(dir);
    expect(existsSync(log) ? readdirSync(log) : []).toEqual([]);
    expect(readdirSync(runPaths(dir).packets)).toEqual([]);
    expect(readFileSync(runPaths(dir).costs, "utf8")).toBe("");
    expect(loadRun(dir).state).toBe("collected");
  });

  it("--until 상태에 이미 있으면 아무것도 띄우지 않고 멈춘다", async () => {
    const { dir } = setupRun({ units: exampleUnits() });
    const { env, log } = fakeEnv("submit");
    const result = await runLoop({ runDir: dir, until: "collected", env });
    expect(result).toMatchObject({ outcome: "until_reached", launches: 0 });
    expect(existsSync(log) ? readdirSync(log) : []).toEqual([]);
  });

  it("알 수 없는 --until 은 사용법 오류", async () => {
    const { dir } = makeRun("collected");
    await expect(runLoop({ runDir: dir, until: "nope" })).rejects.toThrow(/--until/);
  });

  it("init 은 수집이 필요하다며 멈춘다", async () => {
    const { dir } = makeRun("init");
    const { env, log } = fakeEnv("submit");
    const result = await runLoop({ runDir: dir, until: "analyzed", env });
    expect(result.outcome).toBe("collection_needed");
    expect(existsSync(log) ? readdirSync(log) : []).toEqual([]);
  });

  it.each([
    ["checked", "publish_gate"],
    ["gate_answering", "wait_human"],
    ["plan_checked", "publish_gate"],
    ["gate_plan_review", "wait_human"],
    ["approved", "done"],
  ] as const)("%s 에서는 %s 로 멈추고 종료 0 에 해당하는 결과를 돌려준다", async (state, action) => {
    const { dir } = makeRun(state);
    const { env, log } = fakeEnv("submit");
    const result = await runLoop({ runDir: dir, env });
    expect(result).toMatchObject({ outcome: "stopped", state, launches: 0 });
    expect(result.next.action).toBe(action);
    expect(existsSync(log) ? readdirSync(log) : []).toEqual([]);
  });

  it("역할 정의 파일이 있는 역할(ticket-maker)은 --dry 에서 띄울 명령을 만든다", async () => {
    const { dir } = makeRun("answers_applied");
    const { env } = fakeEnv("submit");
    const result = await runLoop({ runDir: dir, env, dry: true });
    expect(result.outcome).toBe("dry");
    expect(result.dry?.args).toContain("hew:ticket-maker");
  });
});

describe("hew run 명령(자식 프로세스)", () => {
  const hew = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(join(HEW_ROOT, "bin", "hew"), args, { env, encoding: "utf8" });

  it("가짜 claude 로 --until analyzed 가 종료 0, 상태 analyzed", () => {
    const { dir } = setupRun({ units: exampleUnits() });
    const { env } = fakeEnv("submit");
    const r = hew(["--json", "run", "--run", dir, "--until", "analyzed"], env);
    expect(r.status).toBe(0);
    const body = JSON.parse(r.stdout) as { ok: boolean; data: { outcome: string; state: string } };
    expect(body).toMatchObject({ ok: true, data: { outcome: "until_reached", state: "analyzed" } });
    const status = JSON.parse(hew(["--json", "status", "--run", dir], env).stdout) as { data: { state: string } };
    expect(status.data.state).toBe("analyzed");
  }, 30000);

  it("제출이 없으면 종료 5", () => {
    const { dir } = setupRun({ units: exampleUnits() });
    const { env } = fakeEnv("noop");
    const r = hew(["--json", "run", "--run", dir], env);
    expect(r.status).toBe(5);
    expect((JSON.parse(r.stdout) as { ok: boolean }).ok).toBe(false);
  }, 30000);

  it("--dry 출력에 인자 배열이 있다", () => {
    const { dir } = setupRun({ units: exampleUnits() });
    const { env } = fakeEnv("submit");
    const r = hew(["--json", "run", "--run", dir, "--dry"], env);
    expect(r.status).toBe(0);
    const body = JSON.parse(r.stdout) as { data: { outcome: string; dry: { args: string[] } } };
    expect(body.data.outcome).toBe("dry");
    expect(body.data.dry.args).toContain("hew:technical-manager");
  });
});
