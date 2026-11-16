/** 종류별 검증기 등록부와 제출 흐름(상태 확인, 검증, 정본 쓰기, 전이, revision 반영). */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { currentBasis } from "./basis.js";
import { wrapEnvelope, type Cost, type ProducedBy, type Stage } from "./envelope.js";
import { rejectedError, usageError, type Issue } from "./errors.js";
import { appendEvent } from "./events.js";
import { writeJsonAtomic } from "./fsx.js";
import { hashJson } from "./hash.js";
import { collectRunOpen } from "./open.js";
import { runPaths } from "./paths.js";
import { computeRevision } from "./revision.js";
import { loadRun, saveRun, type Run, type SubmissionKey } from "./run.js";
import {
  transition,
  type FindingsTarget,
  type RunState,
  type TransitionContext,
  type TransitionEvent,
} from "./state-machine.js";

export const SUBMIT_KINDS = ["analysis", "scenarios", "plan", "findings"] as const;
export type SubmitKind = (typeof SUBMIT_KINDS)[number];

export interface CheckContext {
  kind: SubmitKind;
  for: FindingsTarget | null;
  run: Run;
  runDir: string;
  /** 이번 제출에서 명시적으로 철회한 항목 id. */
  withdraw?: string[];
}

/** 검증된 items 를 받아 지적 목록을 돌려주는 결정적 검사. */
export type Check = (items: Record<string, unknown>, ctx: CheckContext) => Issue[];

export interface KindSpec {
  schema: z.ZodType<Record<string, unknown>>;
  checks: Check[];
  /** 본문과 실행 폴더(사람의 답)에서 아직 닫히지 않은 항목 id 를 뽑는다. */
  collectOpen: (items: Record<string, unknown>, runDir: string) => string[];
  /** 스키마 검증 전에 제출 원문을 손질하고(칸 버리기 등) 경고를 낸다. */
  sanitize?: (raw: unknown) => { raw: unknown; issues: Issue[] };
  /** 이 종류가 --withdraw 를 처리하는가. 처리하지 않으면 무시한다는 경고를 낸다. */
  supportsWithdraw?: boolean;
}

const placeholderSpec = (): KindSpec => ({
  schema: z.record(z.unknown()),
  checks: [],
  collectOpen: () => [],
});

const registry: Record<SubmitKind, KindSpec> = {
  analysis: placeholderSpec(),
  scenarios: placeholderSpec(),
  plan: placeholderSpec(),
  findings: placeholderSpec(),
};

export function getKindSpec(kind: SubmitKind): KindSpec {
  return registry[kind];
}

/** 종류의 스키마·검사·열린 항목 추출기를 교체한다. 뒤 조각이 실제 검증을 끼우는 자리. */
export function registerKind(kind: SubmitKind, spec: KindSpec): void {
  registry[kind] = spec;
}

/** 종류의 검사 목록 끝에 검사 하나를 더한다. */
export function registerCheck(kind: SubmitKind, check: Check): void {
  registry[kind].checks.push(check);
}

const hasEvidence = (value: unknown): boolean => {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
};

/** 차단 지적 수: items.findings 에서 verdict 가 issue 이고 evidence 가 있는 것의 수. */
export function countBlocking(items: Record<string, unknown>): number {
  const findings = items.findings;
  if (!Array.isArray(findings)) return 0;
  return findings.filter((f) => {
    if (f === null || typeof f !== "object") return false;
    const record = f as Record<string, unknown>;
    return record.verdict === "issue" && hasEvidence(record.evidence);
  }).length;
}

export interface SubmitOptions {
  runDir: string;
  kind: SubmitKind;
  file: string;
  for?: FindingsTarget;
  withdraw?: string[];
  producedBy?: ProducedBy | null;
  cost?: Cost | null;
  now?: Date;
}

export interface SubmitResult {
  kind: SubmitKind;
  for: FindingsTarget | null;
  attempt: number;
  path: string;
  previous_state: RunState;
  state: RunState;
  revision: string;
  open: number;
  warnings: Issue[];
}

const stageOf = (kind: Exclude<SubmitKind, "findings">): Stage => kind;

const contextOf = (run: Run, revision: string): TransitionContext => ({
  rework: run.rework,
  progress: run.progress,
  open: run.open,
  revision,
});

function eventFor(kind: SubmitKind, target: FindingsTarget | null, items: Record<string, unknown>, open: number): TransitionEvent {
  if (kind === "analysis") return { type: "analysis_accepted", open };
  if (kind === "scenarios") return { type: "scenarios_accepted", open };
  if (kind === "plan") return { type: "plan_accepted" };
  return { type: "findings_complete", for: target ?? "analysis", blocking: countBlocking(items) };
}

function parseItems(text: string, spec: KindSpec): { items: Record<string, unknown>; notes: Issue[] } | { issues: Issue[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { issues: [{ code: "json_parse", severity: "reject", ref: null, message: `JSON 으로 읽을 수 없습니다: ${detail}` }] };
  }
  const sanitized = spec.sanitize ? spec.sanitize(raw) : { raw, issues: [] };
  const parsed = spec.schema.safeParse(sanitized.raw);
  if (!parsed.success) {
    const issues: Issue[] = parsed.error.issues.map((issue) => ({
      code: "schema_invalid",
      severity: "reject",
      ref: issue.path.length > 0 ? issue.path.join(".") : null,
      message: issue.message,
    }));
    return { issues };
  }
  return { items: parsed.data, notes: sanitized.issues };
}

/** 제출 흐름: 상태 확인(4) → 스키마·검사(3) → 정본 쓰기 → 전이 → revision 반영 → 이벤트. */
export function submitArtifact(opts: SubmitOptions): SubmitResult {
  const now = opts.now ?? new Date();
  const target = opts.kind === "findings" ? (opts.for ?? null) : null;
  if (opts.kind === "findings" && target === null) throw usageError("findings 제출에는 --for analysis|plan 이 필요합니다");
  if (opts.kind !== "findings" && opts.for !== undefined) throw usageError("--for 는 findings 제출에만 쓸 수 있습니다");
  if (!existsSync(opts.file)) throw usageError(`제출 파일이 없습니다: ${opts.file}`);

  const paths = runPaths(opts.runDir);
  const run = loadRun(opts.runDir);
  const spec = getKindSpec(opts.kind);
  const text = readFileSync(opts.file, "utf8");
  const currentRevision = computeRevision(opts.runDir);

  // 상태가 이 종류를 받을 수 있는지 먼저 확인한다(받을 수 없으면 종료 4).
  transition(run.state, eventFor(opts.kind, target, {}, 0), contextOf(run, currentRevision));

  if (opts.kind === "findings") {
    throw usageError("findings 는 묶음 단위로 냅니다. --batch <k> 를 붙여 hew submit findings 를 부르세요");
  }

  const parsed = parseItems(text, spec);
  const issues: Issue[] = [];
  if ("issues" in parsed) {
    issues.push(...parsed.issues);
  } else {
    const checkCtx: CheckContext = { kind: opts.kind, for: target, run, runDir: opts.runDir, withdraw: opts.withdraw };
    issues.push(...parsed.notes);
    for (const check of spec.checks) issues.push(...check(parsed.items, checkCtx));
  }
  const rejects = issues.filter((issue) => issue.severity === "reject");
  if (rejects.length > 0 || !("items" in parsed)) {
    appendEvent(paths.events, "artifact_rejected", { kind: opts.kind, for: target, file: opts.file, issues: rejects }, now);
    throw rejectedError(`제출이 거부되었습니다(거부 ${rejects.length}건). 정본과 상태는 바뀌지 않았습니다`, rejects);
  }

  const warnings: Issue[] = issues.filter((issue) => issue.severity !== "reject");
  if (opts.withdraw !== undefined && opts.withdraw.length > 0 && spec.supportsWithdraw !== true) {
    warnings.push({ code: "withdraw_unsupported", severity: "warn", ref: null, message: "--withdraw 는 아직 지원하지 않아 무시했습니다" });
  }

  const items = parsed.items;
  const key: SubmissionKey = stageOf(opts.kind);
  const attempt = (run.submissions[key]?.attempt ?? 0) + 1;
  const openIds = spec.collectOpen(items, opts.runDir);
  const totalOpen = opts.kind === "analysis" || opts.kind === "scenarios" ? collectRunOpen(opts.runDir, { kind: opts.kind, items }).length : run.open;
  const result = transition(run.state, eventFor(opts.kind, target, items, totalOpen), contextOf(run, currentRevision));

  const envelope = wrapEnvelope({
    stage: key,
    runId: run.run_id,
    attempt,
    inputRevision: currentRevision,
    items,
    open: openIds,
    verdictReasons: warnings.map((w) => w.code),
    producedBy: opts.producedBy ?? null,
    cost: opts.cost ?? null,
    basis: opts.kind === "scenarios" ? (currentBasis(opts.runDir) ?? undefined) : undefined,
  });
  const docPath =
    opts.kind === "analysis" ? paths.analysis
    : opts.kind === "scenarios" ? paths.scenarios
    : paths.plan;
  writeJsonAtomic(docPath, envelope);

  const revision = computeRevision(opts.runDir);
  const open = collectRunOpen(opts.runDir).length;
  const next: Run = {
    ...run,
    state: result.state,
    revision,
    rework: result.changes.rework ?? run.rework,
    progress: result.changes.progress ?? run.progress,
    open,
    submissions: { ...run.submissions, [key]: { attempt, at: now.toISOString(), hash: hashJson(items) } },
  };
  saveRun(opts.runDir, next, now);
  appendEvent(
    paths.events,
    "artifact_submitted",
    { kind: opts.kind, for: target, attempt, from: run.state, to: result.state, row: result.row, revision, path: docPath },
    now,
  );

  return {
    kind: opts.kind,
    for: target,
    attempt,
    path: docPath,
    previous_state: run.state,
    state: result.state,
    revision,
    open,
    warnings,
  };
}

