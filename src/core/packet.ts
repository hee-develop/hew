/** 역할 패킷(packets/<역할>-<n>.md) 생성: 읽을 파일, 이번 일의 범위, 따를 규칙, 쓰는 곳과 제출 방법. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadCollectConfig } from "./collect/config.js";
import { computePlan, type PlanItem } from "./collect/plan.js";
import { usageError, type Issue } from "./errors.js";
import { groupDuplicateFindings } from "./findings/group.js";
import { readJsonFile } from "./fsx.js";
import { HEW_ROOT, findingsPath, resolveRunDir, runPaths } from "./paths.js";
import { loadAnswers } from "./analysis/answers.js";
import { nextAction } from "./next.js";
import { loadRun, type Run } from "./run.js";
import { isRoleName, roleConfig, type RoleName } from "./roles.js";
import { currentRound, isBatchSubmitted, loadPlan } from "./sasu/store.js";
import { BatchFileSchema, type BatchFile, type SasuTarget } from "./sasu/types.js";

export const PURPOSES = ["first", "rework", "apply_answers"] as const;
export type Purpose = (typeof PURPOSES)[number];

/** heka 노트 본문을 패킷에 싣는 최대 글자 수. */
export const HEKA_BODY_LIMIT = 1500;

/** 에이전트가 쓸 수 있는 Bash 명령 목록(훅의 허용 목록과 같다). */
export const BASH_ALLOWED = [
  "rg", "grep", "ls", "find", "cat", "head", "tail", "wc", "jq", "sort", "uniq", "cut", "tr", "paste", "column", "nl", "sips", "file", "stat",
  "basename", "dirname", "echo", "true", "test", "[", "pwd", "cd(맨 앞에서, 읽을 수 있는 폴더로만)", "sed -n(줄 범위 보기만)", "mkdir -p(작업 폴더 안에서만)",
  "git(읽기 전용 하위 명령만)", "hew(아래 제출·답변 명령과 check·status·next·units·source list·source request)",
] as const;

export interface PacketPlan {
  n: number;
  path: string;
  workDir: string;
}

export interface PacketResult extends PacketPlan {
  role: RoleName;
  purpose: Purpose;
  warnings: Issue[];
}

export interface PacketOptions {
  runDir: string;
  role: string;
  purpose?: string;
  env?: NodeJS.ProcessEnv;
  /** 사수 패킷(manager-sasu·ticket-sasu)이 다룰 묶음 번호. 생략하면 이번 회차에서 아직 제출되지 않은 첫 묶음. */
  batch?: number;
}

const expandHome = (p: string): string => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** 이 역할의 몇 번째 패킷인지와 그 경로·작업 폴더를 정한다. 아무것도 쓰지 않는다. */
export function planPacket(runDir: string, role: string): PacketPlan {
  const paths = runPaths(runDir);
  const pattern = new RegExp(`^${role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)\\.md$`);
  let max = 0;
  if (existsSync(paths.packets)) {
    for (const name of readdirSync(paths.packets)) {
      const m = pattern.exec(name);
      if (m?.[1] !== undefined) max = Math.max(max, Number(m[1]));
    }
  }
  const n = max + 1;
  return { n, path: join(paths.packets, `${role}-${n}.md`), workDir: join(paths.work, `${role}-${n}`) };
}

/** 이 상태에서 이 역할이 띄워질 때의 목적. 해당하지 않으면 first. */
export function defaultPurpose(run: Run, role: string): Purpose {
  const next = nextAction(run.state, { rework: run.rework, progress: run.progress });
  return next.action === "spawn" && next.role === role ? next.purpose : "first";
}

/** hew 실행 파일의 절대 경로. */
export const hewBinPath = (): string => join(HEW_ROOT, "bin", "hew");

const cell = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
};

const table = (head: string[], rows: unknown[][]): string[] => [
  `| ${head.join(" | ")} |`,
  `|${head.map(() => "---").join("|")}|`,
  ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
];

interface HekaNote {
  id: string;
  title: string | null;
  body: string | null;
  error: string | null;
}

/** heka 명령줄 도구로 노트 하나를 읽는다. 실패하면 error 에 사유를 담는다. */
function readHekaNote(bin: string, id: string, env: NodeJS.ProcessEnv): HekaNote {
  const fail = (error: string): HekaNote => ({ id, title: null, body: null, error });
  if (!existsSync(bin)) return fail(`heka 도구가 없습니다: ${bin}`);
  const r = spawnSync(process.execPath, [bin, "expand", id, "--level", "2"], { encoding: "utf8", timeout: 15000, env });
  if (r.error !== undefined) return fail(`heka 도구 실행 실패: ${r.error.message}`);
  if (r.status !== 0) return fail(`heka 도구가 종료 ${r.status} 로 끝났습니다`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return fail("heka 출력이 JSON 이 아닙니다(노트가 없을 수 있음)");
  }
  const rec = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  if (typeof rec.body !== "string") return fail("heka 출력에 body 가 없습니다");
  return {
    id,
    title: typeof rec.title === "string" ? rec.title : null,
    body: rec.body,
    error: null,
  };
}

function rulesSection(ids: string[], run: Run, env: NodeJS.ProcessEnv, warnings: Issue[]): string[] {
  if (ids.length === 0) return ["이 역할에 따로 지정된 규칙이 없습니다."];
  const home = env.HOME ?? homedir();
  const bin = env.HEW_HEKA_BIN && env.HEW_HEKA_BIN.length > 0 ? env.HEW_HEKA_BIN : join(home, "heka", "bin", "heka.js");
  const blocked = new Set(run.case_info?.block.heka_ids ?? []);
  const out: string[] = [];
  for (const id of ids) {
    if (blocked.has(id)) {
      out.push(`### ${id}`, "", "사례의 차단 목록에 있어 제외", "");
      continue;
    }
    const note = readHekaNote(bin, id, env);
    if (note.error !== null) {
      warnings.push({ code: "heka_unreadable", severity: "warn", ref: id, message: `규칙 ${id} 의 본문을 읽지 못했습니다: ${note.error}` });
      out.push(`### ${id}`, "", "본문을 읽지 못함", "");
      continue;
    }
    const body = note.body ?? "";
    const clipped = body.length > HEKA_BODY_LIMIT ? `${body.slice(0, HEKA_BODY_LIMIT)}…(이하 생략)` : body;
    out.push(`### ${id} — ${note.title ?? "(제목 없음)"}`, "", clipped, "");
  }
  return out;
}

const PURPOSE_TEXT: Record<Purpose, string> = {
  first: "처음 만든다. 앞 단계 정본과 원천을 읽고 이 역할의 산출물을 처음부터 작성한다.",
  rework: "반송이다. 사수가 낸 지적을 읽고, 지적마다 원문을 다시 확인해 산출물을 고쳐 다시 제출한다.",
  apply_answers: "답 반영이다. 사람이 게이트에서 낸 답·결정·가정 확인을 반영해 산출물을 고쳐 다시 제출한다.",
};

const MODE_TEXT: Record<Run["mode"], string> = {
  live: "live — 현재 버전의 원천으로 실제 일감을 처리한다.",
  replay: "replay — 사례가 정한 과거 시점의 원천만 쓴다. 외부 쓰기는 없다.",
  shadow: "shadow — 현재 버전의 원천으로 돌리되 외부 쓰기는 없다.",
};

interface Submit {
  line: string;
  file: string;
}

function submitFor(role: RoleName, hew: string, runDir: string, workDir: string, batch?: number): Submit | null {
  const make = (name: string, args: string): Submit => ({
    file: join(workDir, name),
    line: `${hew} --json ${args} --run ${runDir} --file ${join(workDir, name)}`,
  });
  if ((role === "manager-sasu" || role === "ticket-sasu") && batch === undefined) throw usageError(`${role} 패킷에는 묶음 번호가 필요합니다`);
  switch (role) {
    case "technical-manager": return { ...make("analysis.json", "submit analysis") };
    case "qa-designer": return { ...make("scenarios.json", "submit scenarios") };
    case "ticket-maker": return { ...make("plan.json", "submit plan") };
    case "manager-sasu": return { ...make("findings.json", `submit findings --for analysis --batch ${batch}`) };
    case "ticket-sasu": return { ...make("findings.json", `submit findings --for plan --batch ${batch}`) };
    case "collector": return null;
  }
}

function latestFindings(runDir: string, target: "analysis" | "plan", run: Run): string | null {
  const key = target === "analysis" ? run.submissions.findings_analysis : run.submissions.findings_plan;
  if (key === undefined) return null;
  const path = findingsPath(runPaths(runDir), target, key.attempt);
  return existsSync(path) ? path : null;
}

function evidenceCell(evidence: unknown): string {
  if (evidence === null || typeof evidence !== "object") return "";
  const e = evidence as Record<string, unknown>;
  if (typeof e.quote === "string") return `${typeof e.unit_id === "string" ? `${e.unit_id}: ` : ""}${e.quote}`;
  return typeof e.image === "string" ? e.image : "";
}

interface ReturnedFinding {
  id: string;
  work: string;
  kind: string;
  claim: string;
  evidence: unknown;
  action: string;
}

/** 반송 대상 지적: 차단 지적 전체(fix·ask·drop). 차단 표시가 없는 옛 지적은 issue 면 싣는다. */
function returnedFindings(file: string): ReturnedFinding[] {
  const doc = readJsonFile(file) as { items?: { findings?: unknown } } | null;
  const findings = doc?.items?.findings;
  if (!Array.isArray(findings)) return [];
  const out: ReturnedFinding[] = [];
  for (const f of findings) {
    if (f === null || typeof f !== "object") continue;
    const rec = f as Record<string, unknown>;
    if (rec.verdict !== "issue" || rec.blocking === false) continue;
    const text = (v: unknown): string => (typeof v === "string" ? v : "");
    out.push({ id: text(rec.id), work: text(rec.work), kind: text(rec.kind), claim: text(rec.claim), evidence: rec.evidence, action: text(rec.action) });
  }
  return out;
}

/** 반송 지적 표의 행. 종류·주장이 같은 지적은 한 줄로 묶고 id·대상은 한 칸에 모두 적는다. */
function issueRows(file: string): unknown[][] {
  return groupDuplicateFindings(returnedFindings(file)).map((group) => {
    const first = group[0] as ReturnedFinding;
    const join_ = (values: string[]): string => values.join(", ");
    return [
      join_(group.map((f) => f.id)),
      join_(group.map((f) => f.work)),
      first.kind,
      first.claim,
      evidenceCell(first.evidence),
      join_([...new Set(group.map((f) => f.action))]),
    ];
  });
}

/** 반송 패킷에서 지적 표 아래에 두는 답변 안내. */
function respondGuide(runDir: string, workDir: string, hew: string, target: SasuTarget): string[] {
  const file = join(workDir, "responses.json");
  const plan = target === "plan";
  const example = {
    responses: [
      { finding: "F-n", response: "fixed", reason: "무엇을 어떻게 고쳤는지" },
      {
        finding: "F-n",
        response: "rejected",
        reason: "왜 지적이 틀렸는지",
        evidence: { unit_id: plan ? "Tn" : "U-n", quote: plan ? "티켓 본문이나 요구 문장에서 글자 그대로 옮긴 문장" : "원문에서 글자 그대로 옮긴 문장" },
      },
      { finding: "F-n", response: "asked", reason: plan ? "요구만으로 정할 수 없어 사람의 확인이 필요하다" : "원문만으로 정할 수 없어 질문으로 올렸다" },
    ],
  };
  return [
    `지적마다 고쳤는지(\`fixed\`), 근거를 들어 그대로 두는지(\`rejected\`), ${plan ? "사람의 확인이 필요하다고 남기는지" : "사람에게 물을 질문으로 올렸는지"}(\`asked\`)를 \`hew sasu respond\` 로 낸 뒤 ${plan ? "분해안을" : "분석 문서를"} 다시 제출한다. \`finding\` 에는 표의 지적 id(\`F-n\`)를 쓰고, 한 줄에 id 가 여럿이면 각각에 답을 낸다.`,
    "",
    `답변 명령: \`${hew} --json sasu respond --for ${target} --run ${runDir} --file ${file}\``,
    "",
    plan
      ? "- `rejected` 는 `reason` 이 필수다. `evidence.quote` 는 그 지적 단위(티켓)의 제목·본문과 요구 문장에서 글자 그대로 옮긴다(없으면 거부된다). `evidence.unit_id` 에는 티켓 id 를 쓰되 대조에는 쓰이지 않는다."
      : "- `rejected` 는 `reason` 이 필수다. `evidence.quote` 는 `evidence.unit_id` 원문 단위 본문에서 글자 그대로 옮긴다(원문에 없으면 거부된다).",
    "- 답변은 다음 회차 사수가 읽고 지적이 풀렸는지 다시 판정한다. 같은 지적에 다시 내면 덮어쓴다.",
    "",
    "```json",
    JSON.stringify(example, null, 2),
    "```",
    "",
  ];
}

function answerRows(file: string): unknown[][] {
  const doc = readJsonFile(file) as Record<string, Record<string, Record<string, unknown>> | undefined> | null;
  const rows: unknown[][] = [];
  for (const [id, a] of Object.entries(doc?.answers ?? {})) rows.push(["질문 답", id, a.option ?? a.text ?? "", a.text !== undefined && a.option !== undefined ? a.text : ""]);
  for (const [id, a] of Object.entries(doc?.scope ?? {})) rows.push(["차이 결정", id, a.decision ?? "", a.note ?? ""]);
  for (const [id, a] of Object.entries(doc?.assumptions ?? {})) rows.push(["가정 확인", id, a.status ?? "", a.note ?? ""]);
  return rows;
}

/** 사람이 낸 분해안 수정 요청이 있는가. */
function hasPlanRequests(runDir: string): boolean {
  return loadAnswers(runDir).plan_requests.length > 0;
}

function hasFiles(dir: string, predicate: (name: string) => boolean = () => true): boolean {
  return existsSync(dir) && readdirSync(dir).some(predicate);
}

/** 읽을 파일 목록(절대 경로, 설명 포함). */
function readList(runDir: string, role: RoleName, purpose: Purpose, run: Run, refs: string[]): string[] {
  const p = runPaths(runDir);
  const out: string[] = [];
  const add = (path: string, note: string): void => void out.push(`- \`${path}\` — ${note}`);
  add(runDir, "실행 폴더");
  add(p.manifest, "원천 목록(manifest)");
  add(p.units, "원문 단위 목록");
  if (existsSync(p.inventory)) add(p.inventory, "Figma 프레임 목록");
  const figmaDir = join(p.sources, "figma");
  if (hasFiles(figmaDir, (n) => /\.(png|jpe?g|webp)$/i.test(n))) add(figmaDir, "스크린샷 폴더");
  const openapi = join(p.sources, "openapi");
  if (hasFiles(openapi)) add(openapi, "환경별 OpenAPI");
  if (run.repo.path !== null) {
    add(resolve(expandHome(run.repo.path)), "대상 저장소");
    out.push(`- 기준 브랜치/SHA(base): ${run.repo.base ?? "지정되지 않음"}`);
  }
  const prior: [string, string, string][] = [];
  if (role === "qa-designer" || role === "ticket-maker") prior.push([p.analysis, "분석 정본", "analysis"]);
  if (role === "ticket-maker") prior.push([p.scenarios, "시나리오 정본", "scenarios"], [p.answers, "사람의 답과 결정(차이 결정, 수정 요청 포함)", "answers"]);
  if (role === "technical-manager" && purpose !== "first") prior.push([p.analysis, "지금의 분석 정본(고칠 대상)", "analysis"]);
  if (role === "qa-designer" && purpose === "apply_answers") prior.push([p.scenarios, "지금의 시나리오 정본(고칠 대상)", "scenarios"]);
  if (role === "ticket-maker" && (purpose === "rework" || hasPlanRequests(runDir))) prior.push([p.plan, "지금의 분해안 정본(고칠 대상)", "plan"]);
  for (const [path, note] of prior) if (existsSync(path)) add(path, note);
  for (const ref of refs) add(join(HEW_ROOT, ref), ref.startsWith("rules/") ? "분해 규칙" : "형식 안내");
  return out;
}

/** 사수 패킷이 다룰 묶음을 정한다. */
function sasuBatch(runDir: string, run: Run, wanted: number | undefined, target: SasuTarget): { k: number; path: string; file: BatchFile } {
  const round = currentRound(run, target);
  const plan = loadPlan(runDir, round, target);
  if (plan === null) throw usageError(`이 회차의 사수 계획이 없습니다. 먼저 hew sasu plan --for ${target} 을 실행하세요`);
  const entry = wanted !== undefined ? plan.batches.find((b) => b.k === wanted) : plan.batches.find((b) => !isBatchSubmitted(runDir, round, b.k, target));
  if (entry === undefined) throw usageError(wanted !== undefined ? `계획에 묶음 ${wanted} 이(가) 없습니다` : "제출되지 않은 묶음이 없습니다");
  return { k: entry.k, path: entry.path, file: BatchFileSchema.parse(readJsonFile(entry.path)) };
}

function renderSasuPacket(
  opts: PacketOptions & { plan: PacketPlan },
  run: Run,
  role: "manager-sasu" | "ticket-sasu",
): { text: string; purpose: Purpose; role: RoleName; warnings: Issue[] } {
  const env = opts.env ?? process.env;
  const config = roleConfig(role, env);
  const hew = hewBinPath();
  const warnings: Issue[] = [];
  const target: SasuTarget = role === "manager-sasu" ? "analysis" : "plan";
  const batch = sasuBatch(opts.runDir, run, opts.batch, target);
  const lines: string[] = [];
  lines.push(`# 패킷: ${role} ${opts.plan.n}번째`, "");
  lines.push("## 이번 일", "");
  lines.push(
    `- 역할: ${role}`,
    `- 목적: first — 작업 묶음 파일의 단위마다 판정을 하나씩 내어 지적(findings)으로 제출한다.`,
    `- 대상: ${target === "analysis" ? "분석 문서" : "분해안"}, 회차 ${batch.file.round}, 묶음 ${batch.k} (종류 ${batch.file.code}, 단위 ${batch.file.units.length}개)`,
    `- 이 종류가 묻는 것: ${batch.file.question}`,
    `- 실행 모드: ${MODE_TEXT[run.mode]}`,
    `- 실행 id: ${run.run_id}`,
    `- 현재 상태: ${run.state}`,
    "",
  );
  lines.push("## 읽을 것", "", "읽을 수 있는 곳은 아래 경로와 그 아래뿐이다. 목록에 없는 곳은 찾아 읽지 않는다.", "");
  lines.push(`- \`${batch.path}\` — 작업 묶음 파일(이 파일의 단위만 판정한다)`);
  if (batch.file.code === "W7") lines.push("- 묶음 파일의 `as_is`·`to_be` 는 이미지 경로다. Read 로 직접 열어 본다.");
  for (const ref of config.refs) lines.push(`- \`${join(HEW_ROOT, ref)}\` — 형식 안내`);
  lines.push(`- \`${opts.runDir}\` — 실행 폴더`, "");
  lines.push("## 따를 규칙", "", ...rulesSection(config.heka, run, env, warnings));
  lines.push("## 쓰는 곳과 제출", "");
  lines.push(`- 작업 폴더(여기에만 쓸 수 있다): \`${opts.plan.workDir}\``);
  lines.push(`- hew 실행 파일: \`${hew}\``);
  const submit = submitFor(role, hew, opts.runDir, opts.plan.workDir, batch.k) as Submit;
  lines.push(`- 초안 파일: \`${submit.file}\``, "", "제출 명령:", "", "```sh", submit.line, "```", "");
  lines.push("제출이 거부되면(종료 3) 출력된 오류를 읽고 초안을 고쳐 같은 명령으로 다시 낸다. 통과할 때까지 반복한다.", "");
  lines.push("쓸 수 있는 Bash 명령:", "", ...BASH_ALLOWED.map((c) => `- ${c}`), "");
  lines.push("파이프(`|`), `&&`, `||`, `;` 로 이은 명령은 조각마다 위 목록에 있어야 한다. 쉘 치환(`$(...)`, 백틱), 변수 참조, 목록에 없는 명령은 거부된다.", "");
  return { text: `${lines.join("\n")}\n`, purpose: "first", role, warnings };
}


/** 계획 항목의 등록 값을 `hew source add` 인자로 쓴다(제목은 싣지 않는다). */
function registerArgs(item: PlanItem): string {
  const r = item.register;
  return [`--kind ${r.kind}`, `--ref ${r.ref}`, ...(r.version === undefined ? [] : [`--version ${r.version}`]), ...(r.node === undefined ? [] : [`--node ${r.node}`])].join(" ");
}

/** 수집 역할 패킷: 실행 폴더, 모드, 지금의 수집 계획, 쓸 명령, 읽기 도구, 차단 목록. */
function renderCollectorPacket(opts: PacketOptions & { plan: PacketPlan }, run: Run): { text: string; purpose: Purpose; role: RoleName; warnings: Issue[] } {
  const env = opts.env ?? process.env;
  const config = roleConfig("collector", env);
  const collect = loadCollectConfig();
  const hew = hewBinPath();
  const warnings: Issue[] = [];
  const plan = computePlan(opts.runDir, collect);
  const base = `${hew} --json source`;
  const shots = join(opts.plan.workDir, "shots");
  const lines: string[] = [];

  lines.push(`# 패킷: collector ${opts.plan.n}번째`, "");
  lines.push("## 이번 일", "");
  lines.push(
    "- 역할: collector",
    "- 목적: first — 수집 계획의 항목을 읽기 도구로 가져와 원천으로 등록한다. 내용을 요약하거나 분석하지 않는다.",
    `- 실행 모드: ${MODE_TEXT[run.mode]}`,
    `- 실행 id: ${run.run_id}`,
    `- 현재 상태: ${run.state}`,
    `- 실행 폴더: \`${opts.runDir}\``,
    `- 입력: ${run.input.kind === "prd" ? "PRD" : "Jira 티켓"} ${run.input.url}`,
    "",
  );

  lines.push("## 수집 계획", "", "지금 계산된 계획이다. 항목을 등록하거나 실패로 남길 때마다 `hew source plan` 으로 다시 본다(문서를 등록하면 새 항목이 생길 수 있다).", "");
  const rows = plan.items.map((i) => [i.id, i.skip === true ? "건너뜀" : "가져옴", i.what, i.tool_hint, registerArgs(i), i.note ?? ""]);
  lines.push(...table(["항목 id", "처리", "무엇", "도구", "등록 값", "비고"], rows), "");
  if (plan.failed.length > 0) lines.push("실패로 빠진 항목(다시 시도하지 않는다):", "", ...table(["항목 id", "무엇", "횟수", "사유"], plan.failed.map((f) => [f.id, f.what, f.attempts, f.reasons.join("; ")])), "");
  if (plan.blocked.length > 0) lines.push("막힌 일:", "", ...plan.blocked.map((b) => `- ${b}`), "");
  if (plan.notes.length > 0) lines.push(...plan.notes.map((n) => `- ${n}`), "");

  lines.push("## 쓸 명령", "");
  lines.push(
    `- 계획 보기: \`${base} plan --run ${opts.runDir}\``,
    `- 받아 적힌 도구 결과 보기(번호, 도구, 입력, 크기, 등록 여부): \`${base} calls --run ${opts.runDir}\``,
    `- 도구 결과를 원천으로 등록: \`${base} add --run ${opts.runDir} <등록 값> --from-call <번호>\``,
    `- 내려받은 이미지를 원천으로 등록: \`${base} add --run ${opts.runDir} <등록 값> --file ${shots}/<이름>.png\``,
    `- 실패 기록(두 번까지 시도한 뒤): \`${base} fail --run ${opts.runDir} --item <항목 id> --reason "<사유>"\``,
    `- 수집 끝 확인: \`${base} done --run ${opts.runDir}\``,
    "",
    "예시:",
    "",
    "```sh",
    `${base} add --run ${opts.runDir} --kind prd --ref 123456 --version 22 --from-call 1`,
    `${base} add --run ${opts.runDir} --kind figma_shot --ref <파일 키> --node 12:34 --file ${shots}/12-34.png`,
    `${base} fail --run ${opts.runDir} --item related:98765 --reason "권한 없음"`,
    "```",
    "",
    "등록 값(`--kind`, `--ref`, `--version`, `--node`)은 계획 표의 값을 그대로 쓴다. 호출 번호는 방금 부른 도구의 번호를 `calls` 로 확인해서 쓴다. 본문을 직접 타이핑해 파일을 만들지 않는다.",
    "`done` 이 종료 3 으로 거부되면 출력된 항목을 가져와 등록하거나 실패로 남긴다.",
    "",
  );

  lines.push("## 읽기 도구", "");
  lines.push(
    `- cloudId: \`${collect.atlassian_cloud_id}\``,
    "- Confluence 현재 버전: `getConfluencePage`(cloudId, pageId, contentFormat: markdown)",
    "- Confluence 지정 버전: `executeRead` 로 `getConfluenceContentVersion`(contentId, versionNumber, content_format: markdown). `responseFields` 를 주지 않는다(주면 빈 값이 온다)",
    "- Jira: `getJiraIssue`(cloudId, issueIdOrKey)",
    "- Figma: `ToolSearch` 로 `get_metadata`·`get_screenshot` 을 찾은 뒤 부른다. `get_metadata`(fileKey, nodeId), `get_screenshot`(fileKey, nodeId, maxDimension). 호출 한도 응답이 오면 같은 호출을 한 번 다시 시도한다",
    "- 검색 도구(JQL·CQL 검색 등)와 쓰기 도구는 거부된다.",
    "",
    "스크린샷은 도구가 돌려준 주소를 `curl` 로 작업 폴더에 내려받는다. 형식은 이것만 허용된다(옵션은 `-s` `-S` `-L` `-f` `-o` `--max-time <초>` 뿐):",
    "",
    "```sh",
    `mkdir -p ${shots}`,
    `curl -sS -L -f --max-time 60 -o ${shots}/12-34.png "https://<주소>"`,
    "```",
    "",
  );

  const block = run.case_info?.block;
  if (block !== undefined && (block.jira_keys.length > 0 || block.pr_numbers.length > 0)) {
    lines.push("## 읽지 않을 것", "", "아래는 이 실행의 평가를 위해 차단돼 있다. 도구 입력에 들어 있으면 거부된다. 계획에 없는 것을 따라가지 않는다.", "");
    lines.push(...table(["종류", "값"], [...block.jira_keys.map((k) => ["Jira", k]), ...block.pr_numbers.map((n) => ["PR", `#${n}`])]), "");
  }

  lines.push("## 따를 규칙", "", ...rulesSection(config.heka, run, env, warnings));
  lines.push("## 쓰는 곳", "");
  lines.push(`- 작업 폴더(여기에만 쓸 수 있다): \`${opts.plan.workDir}\``, `- 도구 결과 받아 적는 곳(훅이 쓴다. 읽을 수 있다): \`${join(opts.plan.workDir, "calls")}\``, `- hew 실행 파일: \`${hew}\``, "");
  lines.push(
    "쓸 수 있는 Bash 명령: `hew source plan|calls|add|fail|done|list|request`(위 형식), 위 `curl` 형식, 그리고 목록·보기 명령(`ls`, `cat`, `head`, `wc`, `jq`, `file`, `stat`, `mkdir -p`(작업 폴더 안에서만)).",
    "",
  );
  return { text: `${lines.join("\n")}\n`, purpose: "first", role: "collector", warnings };
}

/** 패킷 본문과 경고를 만든다. 파일은 쓰지 않는다. */
export function renderPacket(opts: PacketOptions & { plan: PacketPlan }): { text: string; purpose: Purpose; role: RoleName; warnings: Issue[] } {
  if (!isRoleName(opts.role)) throw usageError(`알 수 없는 역할입니다: ${opts.role}`);
  const role = opts.role;
  const env = opts.env ?? process.env;
  const run = loadRun(opts.runDir);
  if (role === "manager-sasu" || role === "ticket-sasu") return renderSasuPacket(opts, run, role);
  if (role === "collector") return renderCollectorPacket(opts, run);
  const purpose = ((): Purpose => {
    if (opts.purpose === undefined) return defaultPurpose(run, role);
    if (!(PURPOSES as readonly string[]).includes(opts.purpose)) throw usageError(`--purpose 는 ${PURPOSES.join("|")} 중 하나여야 합니다: ${opts.purpose}`);
    return opts.purpose as Purpose;
  })();
  const config = roleConfig(role, env);
  const p = runPaths(opts.runDir);
  const hew = hewBinPath();
  const warnings: Issue[] = [];
  const lines: string[] = [];

  lines.push(`# 패킷: ${role} ${opts.plan.n}번째`, "");
  lines.push("## 이번 일", "");
  lines.push(`- 역할: ${role}`, `- 목적: ${purpose} — ${PURPOSE_TEXT[purpose]}`, `- 실행 모드: ${MODE_TEXT[run.mode]}`, `- 실행 id: ${run.run_id}`, `- 현재 상태: ${run.state}`, "");

  lines.push("## 읽을 것", "", "읽을 수 있는 곳은 아래 경로와 그 아래뿐이다. 목록에 없는 곳은 찾아 읽지 않는다.", "");
  lines.push(...readList(opts.runDir, role, purpose, run, config.refs), "");

  if (purpose === "rework") {
    const target = role === "ticket-maker" ? "plan" : "analysis";
    const file = latestFindings(opts.runDir, target, run);
    lines.push("## 반송된 지적", "");
    if (file === null) {
      lines.push("지적 파일이 아직 없습니다.", "");
    } else {
      lines.push(`지적 파일: \`${file}\``, "", ...table(["id", "대상", "종류", "주장", "근거", "처리"], issueRows(file)), "");
      lines.push(...respondGuide(opts.runDir, opts.plan.workDir, hew, target));
    }
  }
  if (role === "ticket-maker" && existsSync(p.answers)) {
    const requests = loadAnswers(opts.runDir).plan_requests;
    if (requests.length > 0) {
      lines.push("## 사람의 수정 요청", "", "게이트에서 사람이 분해안에 낸 요청이다. 대상(`Tn`·`PR-n`·`전체`)마다 요청대로 고친다. 요구는 바꾸지 않는다.", "");
      lines.push(...table(["대상", "요청", "시각"], requests.map((r) => [r.target, r.text, r.at])), "");
    }
  }
  if (purpose === "apply_answers") {
    lines.push("## 사람의 답과 결정", "");
    if (existsSync(p.answers)) {
      lines.push(`답 파일: \`${p.answers}\``, "", ...table(["종류", "id", "값", "메모"], answerRows(p.answers)), "");
    } else {
      lines.push("답 파일이 아직 없습니다.", "");
    }
  }

  lines.push("## 따를 규칙", "", ...rulesSection(config.heka, run, env, warnings));

  lines.push("## 쓰는 곳과 제출", "");
  lines.push(`- 작업 폴더(여기에만 쓸 수 있다): \`${opts.plan.workDir}\``);
  lines.push(`- hew 실행 파일: \`${hew}\``);
  const submit = submitFor(role, hew, opts.runDir, opts.plan.workDir);
  if (submit !== null) {
    lines.push(`- 초안 파일: \`${submit.file}\``, "", "제출 명령:", "", "```sh", submit.line, "```", "");
    lines.push("제출이 거부되면(종료 3) 출력된 오류를 읽고 초안을 고쳐 같은 명령으로 다시 낸다. 통과할 때까지 반복한다.", "");
  } else {
    lines.push(`- 원천 목록 확인: \`${hew} --json source list --run ${opts.runDir}\``, "");
  }
  lines.push("쓸 수 있는 Bash 명령:", "", ...BASH_ALLOWED.map((c) => `- ${c}`), "");
  lines.push("파이프(`|`), `&&`, `||`, `;` 로 이은 명령은 조각마다 위 목록에 있어야 한다. 쉘 치환(`$(...)`, 백틱), 변수 참조, 목록에 없는 명령은 거부된다.", "");
  return { text: `${lines.join("\n")}\n`, purpose, role, warnings };
}

/** 패킷 파일을 쓰고 작업 폴더를 만든다. */
export function buildPacket(opts: PacketOptions): PacketResult {
  const runDir = resolveRunDir(opts.runDir);
  const plan = planPacket(runDir, opts.role);
  const rendered = renderPacket({ ...opts, runDir, plan });
  mkdirSync(runPaths(runDir).packets, { recursive: true });
  writeFileSync(plan.path, rendered.text, "utf8");
  mkdirSync(plan.workDir, { recursive: true });
  if (rendered.role === "collector") mkdirSync(join(plan.workDir, "shots"), { recursive: true });
  return { ...plan, role: rendered.role, purpose: rendered.purpose, warnings: rendered.warnings };
}
