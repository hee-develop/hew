/** 지적(분석용·분해안용)의 묶음 제출 흐름: 계획 확인, 검증, 묶음 정본 쓰기, 마지막 묶음이면 회차 완료. */
import { existsSync, readFileSync } from "node:fs";
import { sanitizeItems } from "../analysis/sanitize.js";
import { wrapEnvelope, type Cost, type ProducedBy } from "../envelope.js";
import { rejectedError, stateError, usageError, type Issue } from "../errors.js";
import { appendEvent } from "../events.js";
import { readJsonFile, writeJsonAtomic } from "../fsx.js";
import { findingsBatchPath, runPaths } from "../paths.js";
import { computeRevision } from "../revision.js";
import { loadRun } from "../run.js";
import { completeRound, type CompleteResult } from "../sasu/complete.js";
import { currentRound, isBatchSubmitted, loadPlan } from "../sasu/store.js";
import { BatchFileSchema, type SasuTarget } from "../sasu/types.js";
import { nextAction } from "../next.js";
import type { RunState } from "../state-machine.js";
import { checkBatchFindings, classifyFindings } from "./checks.js";
import { FindingsItemsSchema } from "./schema.js";

export interface SubmitBatchOptions {
  runDir: string;
  /** 지적의 대상. 생략하면 분석용이다. */
  target?: SasuTarget;
  batch: number;
  file: string;
  producedBy?: ProducedBy | null;
  cost?: Cost | null;
  now?: Date;
}

export interface SubmitBatchResult {
  round: number;
  batch: number;
  path: string;
  units: number;
  issues: number;
  blocking: number;
  previous_state: RunState;
  state: RunState;
  warnings: Issue[];
  /** 이 제출로 회차가 완료되었으면 그 결과. */
  completed: CompleteResult | null;
}

const reject = (code: string, ref: string | null, message: string): Issue => ({ code, severity: "reject", ref, message });

/** 묶음 하나의 지적을 검사해 정본에 쓴다. 모든 묶음이 들어오면 회차를 완료 처리한다. */
export function submitFindingsBatch(opts: SubmitBatchOptions): SubmitBatchResult {
  const now = opts.now ?? new Date();
  if (!existsSync(opts.file)) throw usageError(`제출 파일이 없습니다: ${opts.file}`);
  const target = opts.target ?? "analysis";
  const paths = runPaths(opts.runDir);
  const run = loadRun(opts.runDir);
  const next = nextAction(run.state, { rework: run.rework, progress: run.progress });
  if (next.action !== "sasu" || next.for !== target) {
    throw stateError(`상태 ${run.state} 에서는 ${target === "analysis" ? "분석용" : "분해안용"} findings 를 받을 수 없습니다`);
  }
  const round = currentRound(run, target);
  const plan = loadPlan(opts.runDir, round, target);
  if (plan === null) throw stateError(`이 회차의 사수 계획이 없습니다. 먼저 hew sasu plan --for ${target} 을 실행하세요`);

  const rejectAll = (issues: Issue[]): never => {
    appendEvent(paths.events, "artifact_rejected", { kind: "findings", for: target, batch: opts.batch, file: opts.file, issues }, now);
    throw rejectedError(`제출이 거부되었습니다(거부 ${issues.length}건). 정본과 상태는 바뀌지 않았습니다`, issues);
  };

  const entry = plan.batches.find((b) => b.k === opts.batch);
  if (entry === undefined) return rejectAll([reject("batch_unknown", String(opts.batch), `이 회차의 계획에 묶음 ${opts.batch} 이(가) 없습니다(1~${plan.batches.length})`)]);
  if (isBatchSubmitted(opts.runDir, round, opts.batch, target)) {
    return rejectAll([reject("batch_already_submitted", String(opts.batch), `묶음 ${opts.batch} 은(는) 이미 제출되었습니다`)]);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(opts.file, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return rejectAll([reject("json_parse", null, `JSON 으로 읽을 수 없습니다: ${detail}`)]);
  }
  const sanitized = sanitizeItems(raw, FindingsItemsSchema, []);
  const parsed = FindingsItemsSchema.safeParse(sanitized.raw);
  if (!parsed.success) {
    return rejectAll(
      parsed.error.issues.map((i) => reject("schema_invalid", i.path.length > 0 ? i.path.join(".") : null, i.message)),
    );
  }
  const batch = BatchFileSchema.parse(readJsonFile(entry.path));
  const rejects = checkBatchFindings(parsed.data.findings, batch);
  if (rejects.length > 0) return rejectAll(rejects);

  const { stored, warnings: unverified } = classifyFindings(parsed.data.findings, batch, opts.runDir);
  const warnings = [...sanitized.issues, ...unverified];
  const envelope = wrapEnvelope({
    stage: target === "analysis" ? "findings_analysis" : "findings_plan",
    runId: run.run_id,
    attempt: round,
    inputRevision: computeRevision(opts.runDir),
    items: { findings: stored },
    verdictReasons: warnings.map((w) => w.code),
    producedBy: opts.producedBy ?? null,
    cost: opts.cost ?? null,
  });
  const docPath = findingsBatchPath(paths, target, round, opts.batch);
  writeJsonAtomic(docPath, envelope);
  const issues = stored.filter((f) => f.verdict === "issue").length;
  const blocking = stored.filter((f) => f.blocking).length;
  appendEvent(paths.events, "findings_batch_submitted", { for: target, round, batch: opts.batch, units: batch.units.length, issues, blocking, path: docPath }, now);

  const allIn = plan.batches.every((b) => isBatchSubmitted(opts.runDir, round, b.k, target));
  const completed = allIn ? completeRound(opts.runDir, plan, now, opts.producedBy ?? null) : null;
  return {
    round,
    batch: opts.batch,
    path: docPath,
    units: batch.units.length,
    issues,
    blocking,
    previous_state: run.state,
    state: completed?.state ?? run.state,
    warnings,
    completed,
  };
}
