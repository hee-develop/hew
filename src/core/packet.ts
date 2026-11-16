/** 역할 패킷(packets/<역할>-<n>.md) 생성: 읽을 파일, 이번 일의 범위, 따를 규칙, 쓰는 곳과 제출 방법. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { usageError, type Issue } from "./errors.js";
import { readJsonFile } from "./fsx.js";
import { HEW_ROOT, findingsPath, resolveRunDir, runPaths } from "./paths.js";
import { nextAction } from "./next.js";
import { loadRun, type Run } from "./run.js";
import { isRoleName, roleConfig, type RoleName } from "./roles.js";
import { currentRound, isBatchSubmitted, loadPlan } from "./sasu/store.js";
import { BatchFileSchema, type BatchFile } from "./sasu/types.js";

export const PURPOSES = ["first", "rework", "apply_answers"] as const;
export type Purpose = (typeof PURPOSES)[number];

/** heka 노트 본문을 패킷에 싣는 최대 글자 수. */
export const HEKA_BODY_LIMIT = 1500;

/** 에이전트가 쓸 수 있는 Bash 명령 목록(훅의 허용 목록과 같다). */
export const BASH_ALLOWED = [
  "rg", "grep", "ls", "find", "cat", "head", "tail", "wc", "jq", "sort", "uniq", "cut", "tr", "sips", "file", "stat",
  "basename", "dirname", "echo", "true", "test", "[", "git(읽기 전용 하위 명령만)", "hew(아래 제출 명령과 check·status·next·units·source list·source request)",
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
  /** manager-sasu 패킷이 다룰 묶음 번호. 생략하면 이번 회차에서 아직 제출되지 않은 첫 묶음. */
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
  recordedAt: string | null;
  error: string | null;
}

/** heka 명령줄 도구로 노트 하나를 읽는다. 실패하면 error 에 사유를 담는다. */
function readHekaNote(bin: string, id: string, env: NodeJS.ProcessEnv): HekaNote {
  const fail = (error: string): HekaNote => ({ id, title: null, body: null, recordedAt: null, error });
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
    recordedAt: typeof rec.recorded_at === "string" ? rec.recorded_at : null,
    error: null,
  };
}

/** 기록 시각이 기준 시점보다 늦은가. 기준이 날짜만이면 날짜 단위로 비교한다. */
function isAfter(recordedAt: string, knownAt: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(knownAt)) return recordedAt.slice(0, 10) > knownAt;
  const a = Date.parse(recordedAt);
  const b = Date.parse(knownAt);
  return Number.isNaN(a) || Number.isNaN(b) ? false : a > b;
}

function rulesSection(ids: string[], run: Run, env: NodeJS.ProcessEnv, warnings: Issue[]): string[] {
  if (ids.length === 0) return ["이 역할에 따로 지정된 규칙이 없습니다."];
  const home = env.HOME ?? homedir();
  const bin = env.HEW_HEKA_BIN && env.HEW_HEKA_BIN.length > 0 ? env.HEW_HEKA_BIN : join(home, "heka", "bin", "heka.js");
  const cutoff = run.mode === "replay" && run.known_at ? run.known_at : null;
  const out: string[] = [];
  for (const id of ids) {
    const note = readHekaNote(bin, id, env);
    if (note.error !== null) {
      warnings.push({ code: "heka_unreadable", severity: "warn", ref: id, message: `규칙 ${id} 의 본문을 읽지 못했습니다: ${note.error}` });
      out.push(`### ${id}`, "", "본문을 읽지 못함", "");
      continue;
    }
    if (cutoff !== null && note.recordedAt !== null && isAfter(note.recordedAt, cutoff)) {
      out.push(`### ${id}`, "", `시점 이후라 제외(기록 ${note.recordedAt}, 사례 시점 ${cutoff})`, "");
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
  if (role === "manager-sasu" && batch === undefined) throw usageError("manager-sasu 패킷에는 묶음 번호가 필요합니다");
  switch (role) {
    case "technical-manager": return { ...make("analysis.json", "submit analysis") };
    case "qa-designer": return { ...make("scenarios.json", "submit scenarios") };
    case "ticket-maker": return { ...make("plan.json", "submit plan") };
    case "manager-sasu": return { ...make("findings.json", `submit findings --for analysis --batch ${batch}`) };
    case "ticket-sasu": return { ...make("findings.json", "submit findings --for plan") };
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

/** 반송 지적 표의 행: 차단 지적 중 테크니컬 매니저가 고칠 것(fix·drop)만. 차단 표시가 없는 옛 지적은 issue 면 싣는다. */
function issueRows(file: string): unknown[][] {
  const doc = readJsonFile(file) as { items?: { findings?: unknown } } | null;
  const findings = doc?.items?.findings;
  if (!Array.isArray(findings)) return [];
  const rows: unknown[][] = [];
  for (const f of findings) {
    if (f === null || typeof f !== "object") continue;
    const rec = f as Record<string, unknown>;
    if (rec.verdict !== "issue" || rec.blocking === false || rec.action === "ask") continue;
    rows.push([rec.id ?? "", rec.work ?? "", rec.kind ?? "", rec.claim ?? "", evidenceCell(rec.evidence), rec.action ?? ""]);
  }
  return rows;
}

function answerRows(file: string): unknown[][] {
  const doc = readJsonFile(file) as Record<string, Record<string, Record<string, unknown>> | undefined> | null;
  const rows: unknown[][] = [];
  for (const [id, a] of Object.entries(doc?.answers ?? {})) rows.push(["질문 답", id, a.option ?? a.text ?? "", a.text !== undefined && a.option !== undefined ? a.text : ""]);
  for (const [id, a] of Object.entries(doc?.scope ?? {})) rows.push(["차이 결정", id, a.decision ?? "", a.note ?? ""]);
  for (const [id, a] of Object.entries(doc?.assumptions ?? {})) rows.push(["가정 확인", id, a.status ?? "", a.note ?? ""]);
  return rows;
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
  if (role === "ticket-maker") prior.push([p.scenarios, "시나리오 정본", "scenarios"]);
  if (role === "technical-manager" && purpose !== "first") prior.push([p.analysis, "지금의 분석 정본(고칠 대상)", "analysis"]);
  if (role === "qa-designer" && purpose === "apply_answers") prior.push([p.scenarios, "지금의 시나리오 정본(고칠 대상)", "scenarios"]);
  if (role === "ticket-maker" && purpose === "rework") prior.push([p.plan, "지금의 분해안 정본(고칠 대상)", "plan"]);
  for (const [path, note] of prior) if (existsSync(path)) add(path, note);
  const rulesPlan = join(HEW_ROOT, "rules", "plan.yaml");
  if (role === "ticket-maker" && existsSync(rulesPlan)) add(rulesPlan, "분해 규칙");
  for (const ref of refs) add(join(HEW_ROOT, ref), "형식 안내");
  return out;
}

/** manager-sasu 패킷이 다룰 묶음을 정한다. */
function sasuBatch(runDir: string, run: Run, wanted: number | undefined): { k: number; path: string; file: BatchFile } {
  const round = currentRound(run);
  const plan = loadPlan(runDir, round);
  if (plan === null) throw usageError("이 회차의 사수 계획이 없습니다. 먼저 hew sasu plan --for analysis 를 실행하세요");
  const entry = wanted !== undefined ? plan.batches.find((b) => b.k === wanted) : plan.batches.find((b) => !isBatchSubmitted(runDir, round, b.k));
  if (entry === undefined) throw usageError(wanted !== undefined ? `계획에 묶음 ${wanted} 이(가) 없습니다` : "제출되지 않은 묶음이 없습니다");
  return { k: entry.k, path: entry.path, file: BatchFileSchema.parse(readJsonFile(entry.path)) };
}

function renderSasuPacket(opts: PacketOptions & { plan: PacketPlan }, run: Run): { text: string; purpose: Purpose; role: RoleName; warnings: Issue[] } {
  const env = opts.env ?? process.env;
  const config = roleConfig("manager-sasu", env);
  const hew = hewBinPath();
  const warnings: Issue[] = [];
  const batch = sasuBatch(opts.runDir, run, opts.batch);
  const lines: string[] = [];
  lines.push(`# 패킷: manager-sasu ${opts.plan.n}번째`, "");
  lines.push("## 이번 일", "");
  lines.push(
    "- 역할: manager-sasu",
    `- 목적: first — 작업 묶음 파일의 단위마다 판정을 하나씩 내어 지적(findings)으로 제출한다.`,
    `- 대상: 분석 문서, 회차 ${batch.file.round}, 묶음 ${batch.k} (종류 ${batch.file.code}, 단위 ${batch.file.units.length}개)`,
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
  const submit = submitFor("manager-sasu", hew, opts.runDir, opts.plan.workDir, batch.k) as Submit;
  lines.push(`- 초안 파일: \`${submit.file}\``, "", "제출 명령:", "", "```sh", submit.line, "```", "");
  lines.push("제출이 거부되면(종료 3) 출력된 오류를 읽고 초안을 고쳐 같은 명령으로 다시 낸다. 통과할 때까지 반복한다.", "");
  lines.push("쓸 수 있는 Bash 명령:", "", ...BASH_ALLOWED.map((c) => `- ${c}`), "");
  lines.push("파이프(`|`), `&&`, `||`, `;` 로 이은 명령은 조각마다 위 목록에 있어야 한다. 쉘 치환(`$(...)`, 백틱), 변수 참조, 목록에 없는 명령은 거부된다.", "");
  return { text: `${lines.join("\n")}\n`, purpose: "first", role: "manager-sasu", warnings };
}

/** 패킷 본문과 경고를 만든다. 파일은 쓰지 않는다. */
export function renderPacket(opts: PacketOptions & { plan: PacketPlan }): { text: string; purpose: Purpose; role: RoleName; warnings: Issue[] } {
  if (!isRoleName(opts.role)) throw usageError(`알 수 없는 역할입니다: ${opts.role}`);
  const role = opts.role;
  const env = opts.env ?? process.env;
  const run = loadRun(opts.runDir);
  if (role === "manager-sasu") return renderSasuPacket(opts, run);
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
  return { ...plan, role: rendered.role, purpose: rendered.purpose, warnings: rendered.warnings };
}
