/** 답 들여오기(§8.2, §8.3): 게이트 페이지가 내보낸 JSON 을 검증해 doc/answers.json 에 합치고 상태를 옮긴다. */
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { emptyAnswers, loadAnswers, AnswersFileSchema, type AnswersFile } from "../analysis/answers.js";
import { isDecisionAllowed } from "../analysis/delta-decision.js";
import { questionHash } from "../analysis/open-items.js";
import { AnalysisItemsSchema, type AnalysisItems } from "../analysis/schema.js";
import { HewError, rejectedError, stateError, usageError, type Issue } from "../errors.js";
import { appendEvent } from "../events.js";
import { readJsonFile, writeFileAtomic, writeJsonAtomic } from "../fsx.js";
import { ID_PATTERNS } from "../ids.js";
import { collectRunOpen } from "../open.js";
import { runPaths } from "../paths.js";
import { computeRevision } from "../revision.js";
import { loadRun, saveRun, type Run } from "../run.js";
import { BACKENDS, ScenarioItemsSchema, type ScenarioItems } from "../scenarios/schema.js";
import { transition, type RunState, type TransitionEvent } from "../state-machine.js";
import { approveRun } from "./approve.js";

/** 결정에 붙이는 메모의 최대 글자 수. */
export const NOTE_LIMIT = 500;

const At = z.string();
const Note = z.string().optional();

/** 페이지가 내보내는 JSON(§8.2 의 컬렉션 모양). 값의 허용 여부는 항목별로 따로 가려 건너뛴다. */
export const ExportFileSchema = z.object({
  exported_at: z.string(),
  run_id: z.string(),
  revision: z.string(),
  answers: z.record(z.object({ option: z.string().optional(), text: z.string().optional(), question_hash: z.string().optional(), at: At })).default({}),
  scope: z.record(z.object({ decision: z.string(), note: Note, at: At })).default({}),
  assumptions: z.record(z.object({ status: z.string(), note: Note, at: At })).default({}),
  scenarios: z.record(z.object({ backend: z.string(), note: Note, at: At })).default({}),
  plan_requests: z.array(z.object({ target: z.string(), text: z.string(), at: At })).default([]),
  approvals: z.record(z.object({ revision: z.string(), at: At, note: Note })).default({}),
});

export type ExportFile = z.infer<typeof ExportFileSchema>;

export const SKIP_REASONS = [
  "stale",
  "unknown_id",
  "invalid_decision",
  "invalid_choice",
  "invalid_status",
  "invalid_backend",
  "invalid_target",
  "empty_answer",
  "revision_mismatch",
  "wrong_phase",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const SECTIONS = ["answers", "scope", "assumptions", "scenarios", "plan_requests", "approvals"] as const;
export type Section = (typeof SECTIONS)[number];

export interface SkippedEntry {
  section: Section;
  id: string;
  reason: SkipReason;
}

export interface ImportResult {
  import_no: number;
  saved_to: string;
  applied: Record<Section, number>;
  skipped: SkippedEntry[];
  skipped_by_reason: Partial<Record<SkipReason, number>>;
  open: number;
  previous_state: RunState;
  state: RunState;
  revision: string;
  approved: boolean;
  warnings: Issue[];
}

export interface ImportOptions {
  runDir: string;
  file: string;
  now?: Date;
}

interface Targets {
  questions: Map<string, { text: string; options: AnalysisItems["questions"][number]["options"] }>;
  deltaKinds: Map<string, AnalysisItems["deltas"][number]["kind"]>;
  assumptions: Set<string>;
  scenarios: Set<string>;
}

const warn = (code: string, ref: string | null, message: string): Issue => ({ code, severity: "warn", ref, message });

function readItems(file: string): unknown {
  return (readJsonFile(file) as { items?: unknown }).items;
}

function loadTargets(runDir: string): Targets {
  const p = runPaths(runDir);
  if (!existsSync(p.analysis)) throw stateError("정본 분석 문서(doc/analysis.json)가 없어 답을 들여올 수 없습니다");
  const analysis = AnalysisItemsSchema.safeParse(readItems(p.analysis));
  if (!analysis.success) throw new HewError("internal", `analysis.json 형식이 올바르지 않습니다: ${analysis.error.issues[0]?.message ?? ""}`);
  let scenarios: ScenarioItems | null = null;
  if (existsSync(p.scenarios)) {
    const parsed = ScenarioItemsSchema.safeParse(readItems(p.scenarios));
    if (parsed.success) scenarios = parsed.data;
  }
  const questions = new Map<string, Targets["questions"] extends Map<string, infer V> ? V : never>();
  for (const q of [...analysis.data.questions, ...(scenarios?.questions ?? [])]) questions.set(q.id, { text: q.text, options: q.options });
  return {
    questions,
    deltaKinds: new Map(analysis.data.deltas.map((d) => [d.id, d.kind])),
    assumptions: new Set(analysis.data.assumptions.map((a) => a.id)),
    scenarios: new Set((scenarios?.scenarios ?? []).map((s) => s.id)),
  };
}

/** 새 시각이 기존 시각보다 늦은가. 읽을 수 없는 시각은 늦은 것으로 보지 않는다. */
function isLater(next: string, previous: string | undefined): boolean {
  if (previous === undefined) return true;
  const a = Date.parse(next);
  const b = Date.parse(previous);
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

const trimNote = (note: string | undefined): string | undefined => {
  const text = (note ?? "").trim().slice(0, NOTE_LIMIT);
  return text.length > 0 ? text : undefined;
};

function nextImportNo(dir: string): number {
  if (!existsSync(dir)) return 1;
  const numbers = readdirSync(dir).flatMap((name) => {
    const m = /^import-(\d+)\.json$/.exec(name);
    return m?.[1] === undefined ? [] : [Number(m[1])];
  });
  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
}

interface Merge {
  answers: AnswersFile;
  applied: Record<Section, number>;
  skipped: SkippedEntry[];
  warnings: Issue[];
}

function mergeAnswerEntries(file: ExportFile, targets: Targets, m: Merge): void {
  for (const [id, entry] of Object.entries(file.answers)) {
    const q = targets.questions.get(id);
    const skip = (reason: SkipReason): void => void m.skipped.push({ section: "answers", id, reason });
    if (q === undefined) {
      m.warnings.push(warn("unknown_id", id, `${id} 는 정본에 없는 질문이라 건너뛰었습니다`));
      skip("unknown_id");
      continue;
    }
    const option = entry.option ?? "";
    const text = (entry.text ?? "").trim();
    if (option.length === 0 && text.length === 0) skip("empty_answer");
    else if (option.length > 0 && !q.options.some((o) => o.key === option)) skip("invalid_choice");
    else if (!isLater(entry.at, m.answers.answers[id]?.at)) skip("stale");
    else {
      m.answers.answers[id] = {
        ...(option.length > 0 ? { option } : {}),
        ...(text.length > 0 ? { text } : {}),
        question_hash: entry.question_hash ?? questionHash({ text: q.text, options: q.options }),
        at: entry.at,
      };
      m.applied.answers += 1;
    }
  }
}

function mergeDecisions(file: ExportFile, targets: Targets, m: Merge): void {
  for (const [id, entry] of Object.entries(file.scope)) {
    const kind = targets.deltaKinds.get(id);
    const skip = (reason: SkipReason): void => void m.skipped.push({ section: "scope", id, reason });
    if (kind === undefined) {
      m.warnings.push(warn("unknown_id", id, `${id} 는 정본에 없는 차이라 건너뛰었습니다`));
      skip("unknown_id");
    } else if (!isDecisionAllowed(kind, entry.decision)) skip("invalid_decision");
    else if (!isLater(entry.at, m.answers.scope[id]?.at)) skip("stale");
    else {
      const note = trimNote(entry.note);
      m.answers.scope[id] = { decision: entry.decision as AnswersFile["scope"][string]["decision"], ...(note === undefined ? {} : { note }), at: entry.at };
      m.applied.scope += 1;
    }
  }
}

function mergeAssumptions(file: ExportFile, targets: Targets, m: Merge): void {
  for (const [id, entry] of Object.entries(file.assumptions)) {
    const skip = (reason: SkipReason): void => void m.skipped.push({ section: "assumptions", id, reason });
    if (!targets.assumptions.has(id)) {
      m.warnings.push(warn("unknown_id", id, `${id} 는 정본에 없는 가정이라 건너뛰었습니다`));
      skip("unknown_id");
    } else if (entry.status !== "confirmed" && entry.status !== "rejected") skip("invalid_status");
    else if (!isLater(entry.at, m.answers.assumptions[id]?.at)) skip("stale");
    else {
      const note = trimNote(entry.note);
      m.answers.assumptions[id] = { status: entry.status, ...(note === undefined ? {} : { note }), at: entry.at };
      m.applied.assumptions += 1;
    }
  }
}

function mergeScenarios(file: ExportFile, targets: Targets, m: Merge): void {
  for (const [id, entry] of Object.entries(file.scenarios)) {
    const skip = (reason: SkipReason): void => void m.skipped.push({ section: "scenarios", id, reason });
    if (!targets.scenarios.has(id)) {
      m.warnings.push(warn("unknown_id", id, `${id} 는 정본에 없는 시나리오라 건너뛰었습니다`));
      skip("unknown_id");
    } else if (!(BACKENDS as readonly string[]).includes(entry.backend)) skip("invalid_backend");
    else if (!isLater(entry.at, m.answers.scenarios[id]?.at)) skip("stale");
    else {
      const note = trimNote(entry.note);
      m.answers.scenarios[id] = { backend: entry.backend, ...(note === undefined ? {} : { note }), at: entry.at };
      m.applied.scenarios += 1;
    }
  }
}

function mergePlanRequests(file: ExportFile, m: Merge): void {
  for (const req of file.plan_requests) {
    const skip = (reason: SkipReason): void => void m.skipped.push({ section: "plan_requests", id: req.target, reason });
    const targetOk = req.target === "전체" || ID_PATTERNS.ticket.test(req.target) || ID_PATTERNS.pr.test(req.target);
    if (!targetOk) skip("invalid_target");
    else if (req.text.trim().length === 0) skip("empty_answer");
    else if (m.answers.plan_requests.some((r) => r.target === req.target && r.text === req.text && r.at === req.at)) skip("stale");
    else {
      m.answers.plan_requests.push({ target: req.target, text: req.text.trim(), at: req.at });
      m.applied.plan_requests += 1;
    }
  }
}

function mergeApprovals(file: ExportFile, state: RunState, current: string, m: Merge): void {
  for (const [id, entry] of Object.entries(file.approvals)) {
    const skip = (reason: SkipReason): void => void m.skipped.push({ section: "approvals", id, reason });
    if (state !== "gate_plan_review") skip("wrong_phase");
    else if (entry.revision !== current) skip("revision_mismatch");
    else if (m.answers.approvals[id] !== undefined) skip("stale");
    else {
      const note = trimNote(entry.note);
      m.answers.approvals[id] = { revision: entry.revision, at: entry.at, ...(note === undefined ? {} : { note }) };
      m.applied.approvals += 1;
    }
  }
}

function parseExport(text: string): ExportFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw rejectedError(`내보낸 파일을 JSON 으로 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = ExportFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues: Issue[] = parsed.error.issues.map((i) => ({ code: "schema_invalid", severity: "reject", ref: i.path.length > 0 ? i.path.join(".") : null, message: i.message }));
    throw rejectedError(`내보낸 파일의 형식이 올바르지 않습니다: ${issues[0]?.ref ?? ""} ${issues[0]?.message ?? ""}`, issues);
  }
  return parsed.data;
}

const countBy = (skipped: SkippedEntry[]): Partial<Record<SkipReason, number>> => {
  const out: Partial<Record<SkipReason, number>> = {};
  for (const s of skipped) out[s.reason] = (out[s.reason] ?? 0) + 1;
  return out;
};

/** 내보낸 JSON 을 들여온다. 상태가 gate_answering·gate_plan_review 가 아니면 종료 4, 형식이 틀리거나 다른 실행의 파일이면 종료 3. */
export function importAnswers(opts: ImportOptions): ImportResult {
  const now = opts.now ?? new Date();
  if (!existsSync(opts.file)) throw usageError(`내보낸 파일이 없습니다: ${opts.file}`);
  const paths = runPaths(opts.runDir);
  const run = loadRun(opts.runDir);
  if (run.state !== "gate_answering" && run.state !== "gate_plan_review") {
    throw stateError(`상태 ${run.state} 에서는 답을 들여올 수 없습니다. gate_answering 또는 gate_plan_review 에서만 받습니다`);
  }
  const text = readFileSync(opts.file, "utf8");
  const file = parseExport(text);
  if (file.run_id !== run.run_id) throw rejectedError(`다른 실행의 답 파일입니다(파일 ${file.run_id}, 이 실행 ${run.run_id})`);

  const targets = loadTargets(opts.runDir);
  const before = computeRevision(opts.runDir);
  const m: Merge = {
    answers: structuredClone(existsSync(paths.answers) ? loadAnswers(opts.runDir) : emptyAnswers()),
    applied: { answers: 0, scope: 0, assumptions: 0, scenarios: 0, plan_requests: 0, approvals: 0 },
    skipped: [],
    warnings: [],
  };
  if (file.revision !== before) {
    m.warnings.push(warn("revision_mismatch", null, `페이지의 revision(${file.revision.slice(0, 12)})이 현재 revision(${before.slice(0, 12)})과 다릅니다. 답은 반영하고 승인은 현재 revision 에 대한 것만 기록합니다`));
  }

  mergeAnswerEntries(file, targets, m);
  mergeDecisions(file, targets, m);
  mergeAssumptions(file, targets, m);
  mergeScenarios(file, targets, m);
  mergePlanRequests(file, m);
  // 승인은 revision 을 잠그는 기록이라 다른 항목을 먼저 쓴 뒤의 현재 revision 과 대조한다.
  writeJsonAtomic(paths.answers, AnswersFileSchema.parse(m.answers));
  const current = computeRevision(opts.runDir);
  mergeApprovals(file, run.state, current, m);
  writeJsonAtomic(paths.answers, AnswersFileSchema.parse(m.answers));

  const importNo = nextImportNo(paths.gateImports);
  mkdirSync(paths.gateImports, { recursive: true });
  const savedTo = join(paths.gateImports, `import-${importNo}.json`);
  writeFileAtomic(savedTo, text);

  const open = collectRunOpen(opts.runDir).length;
  const revision = computeRevision(opts.runDir);
  // 승인 단계에서 수정 요청도 승인도 없으면 전이 없이 revision·열린 항목만 갱신한다.
  const event: TransitionEvent | null =
    run.state === "gate_answering"
      ? { type: "answers_imported", open }
      : m.applied.plan_requests > 0
        ? { type: "plan_change_requested" }
        : null;
  const approveWanted =
    run.state === "gate_plan_review" && m.applied.plan_requests === 0 && Object.values(m.answers.approvals).some((a) => a.revision === revision);
  const next = applyEvent(run, event, open, revision, opts.runDir, now);

  appendEvent(
    paths.events,
    "answers_imported",
    { import_no: importNo, file: savedTo, applied: m.applied, skipped: countBy(m.skipped), from: run.state, to: next.state, open, revision },
    now,
  );

  let approved = false;
  if (approveWanted && next.state === "gate_plan_review") {
    try {
      approveRun({ runDir: opts.runDir, revision, source: "gate", now });
      approved = true;
    } catch (error) {
      if (!(error instanceof HewError)) throw error;
      m.warnings.push(warn("approval_blocked", null, `승인을 처리하지 못했습니다: ${error.message}`));
    }
  }
  return {
    import_no: importNo,
    saved_to: savedTo,
    applied: m.applied,
    skipped: m.skipped,
    skipped_by_reason: countBy(m.skipped),
    open,
    previous_state: run.state,
    state: approved ? "approved" : next.state,
    revision,
    approved,
    warnings: m.warnings,
  };
}

function applyEvent(run: Run, event: TransitionEvent | null, open: number, revision: string, runDir: string, now: Date): Run {
  const result = event === null ? null : transition(run.state, event, { rework: run.rework, progress: run.progress, open, revision });
  return saveRun(
    runDir,
    {
      ...run,
      state: result?.state ?? run.state,
      revision,
      open,
      rework: result?.changes.rework ?? run.rework,
      progress: result?.changes.progress ?? run.progress,
    },
    now,
  );
}
