/** 회차 완료 처리: 묶음별 지적을 합쳐 정본에 쓰고, 질문 변환·실수 기록·상태 전이를 한다. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import "../analysis/index.js";
import "../scenarios/index.js";
import { wrapEnvelope, type ProducedBy } from "../envelope.js";
import { appendEvent } from "../events.js";
import { MISTAKE_TYPE_BY_KIND, splitWorkId, type StoredFinding } from "../findings/schema.js";
import { readJsonFile, writeJsonAtomic } from "../fsx.js";
import { hashJson } from "../hash.js";
import { collectRunOpen } from "../open.js";
import { appendMistake, type MistakeVersions } from "../mistakes.js";
import { HEW_ROOT, findingsPath, runPaths } from "../paths.js";
import { computeRevision } from "../revision.js";
import { loadRun, saveRun, type Run } from "../run.js";
import { REWORK_LIMIT, transition, type RunState } from "../state-machine.js";
import { convertFindingsToQuestions } from "./questions.js";
import { readBatchFindings, readRoundFindings } from "./store.js";
import type { SasuPlan } from "./types.js";

export interface CompleteResult {
  round: number;
  previous_state: RunState;
  state: RunState;
  /** 합쳐 쓴 지적 정본 경로. */
  path: string;
  findings: number;
  /** 차단 지적 전체의 수(질문으로 바뀐 것 포함). */
  blocking: number;
  /** 질문으로 바뀌지 않고 테크니컬 매니저에게 돌아가는 차단 지적의 수. */
  remaining: number;
  questions_added: string[];
  revision: string;
  open: number;
}

const isBlocking = (f: StoredFinding): boolean => f.verdict === "issue" && f.blocking;

function coreVersion(): string | null {
  try {
    return (JSON.parse(readFileSync(join(HEW_ROOT, "package.json"), "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/** 분석 정본의 produced_by 에서 실수 기록의 versions 를 만든다. */
function versionsOf(runDir: string): MistakeVersions {
  const file = runPaths(runDir).analysis;
  const by = existsSync(file) ? ((readJsonFile(file) as { produced_by?: Record<string, unknown> | null }).produced_by ?? null) : null;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    role: str(by?.role),
    role_sha: str(by?.role_sha),
    model: str(by?.model),
    effort: str(by?.effort),
    core: coreVersion(),
  };
}

function mistakeEvidence(f: StoredFinding): string {
  const parts = [(f.claim ?? "").trim()];
  if (f.evidence?.quote !== undefined) parts.push(`인용(${f.evidence.unit_id ?? "단위 미지정"}): ${f.evidence.quote}`);
  if (f.evidence?.image !== undefined) parts.push(`이미지: ${f.evidence.image}`);
  return parts.filter((x) => x.length > 0).join(" / ") || f.work;
}

/** 묶음 정본과 재사용한 직전 판정을 계획의 단위 순서로 합쳐 F-1.. 로 다시 번호 매긴다. */
function mergeFindings(runDir: string, plan: SasuPlan): StoredFinding[] {
  const previous = readRoundFindings(runDir, plan.round - 1);
  const fresh = plan.batches.flatMap((b) => readBatchFindings(runDir, plan.round, b.k));
  const merged: StoredFinding[] = [];
  for (const unit of plan.units) {
    if (unit.reuse === true) {
      const old = previous.find((f) => f.work === unit.id);
      if (old !== undefined) merged.push({ ...old, reused: true });
    } else {
      const found = fresh.find((f) => f.work === unit.id);
      if (found !== undefined) merged.push(found);
    }
  }
  return merged.map((f, index) => ({ ...f, id: `F-${index + 1}` }));
}

/** 그 회차의 지적을 합쳐 정본에 쓰고 차단 지적을 처리한 뒤 findings_complete 로 전이한다. */
export function completeRound(runDir: string, plan: SasuPlan, now: Date = new Date(), producedBy: ProducedBy | null = null): CompleteResult {
  const paths = runPaths(runDir);
  const run = loadRun(runDir);
  const ctx = (r: Run, open: number) => ({ rework: r.rework, progress: r.progress, open, revision: r.revision });
  transition(run.state, { type: "findings_complete", for: "analysis", blocking: 0 }, ctx(run, run.open));

  const findings = mergeFindings(runDir, plan);
  const blocking = findings.filter(isBlocking);
  const remainingList = blocking.filter((f) => f.action !== "ask");
  const capReached = run.rework.analysis >= REWORK_LIMIT;
  const toConvert = capReached ? blocking : blocking.filter((f) => f.action === "ask");

  const envelope = wrapEnvelope({
    stage: "findings_analysis",
    runId: run.run_id,
    attempt: plan.round,
    inputRevision: computeRevision(runDir),
    items: { findings },
    verdictReasons: [...new Set(blocking.map((f) => f.kind ?? "issue"))],
    producedBy,
  });
  envelope.verdict.status = blocking.length > 0 ? "blocked" : "pass";
  const docPath = findingsPath(paths, "analysis", plan.round);
  writeJsonAtomic(docPath, envelope);

  const versions = versionsOf(runDir);
  for (const f of blocking) {
    const parts = splitWorkId(f.work);
    appendMistake(
      runDir,
      {
        found_stage: "sasu",
        cause_stage: "analysis",
        found_by: "sasu",
        type: MISTAKE_TYPE_BY_KIND[f.kind ?? "unsupported"] ?? "other",
        target: parts?.target ?? f.work,
        evidence: mistakeEvidence(f),
        versions,
      },
      now,
    );
  }

  const converted = toConvert.length > 0 ? convertFindingsToQuestions(runDir, toConvert) : { added: [], pended: [] };
  if (converted.added.length > 0) {
    appendEvent(paths.events, "sasu_questions_added", { round: plan.round, questions: converted.added, pended: converted.pended }, now);
  }

  const openNow = converted.added.length > 0 ? collectRunOpen(runDir).length : run.open;
  const result = transition(run.state, { type: "findings_complete", for: "analysis", blocking: remainingList.length }, ctx(run, openNow));
  const revision = computeRevision(runDir);
  const analysisHash = existsSync(paths.analysis) ? hashJson((readJsonFile(paths.analysis) as { items: unknown }).items) : null;
  const next: Run = {
    ...run,
    state: result.state,
    revision,
    rework: result.changes.rework ?? run.rework,
    progress: result.changes.progress ?? run.progress,
    open: result.changes.open ?? openNow,
    submissions: {
      ...run.submissions,
      ...(converted.added.length > 0 && run.submissions.analysis !== undefined && analysisHash !== null
        ? { analysis: { ...run.submissions.analysis, hash: analysisHash } }
        : {}),
      findings_analysis: { attempt: plan.round, at: now.toISOString(), hash: hashJson({ findings }) },
    },
  };
  saveRun(runDir, next, now);
  appendEvent(
    paths.events,
    "sasu_round_completed",
    {
      for: "analysis",
      round: plan.round,
      from: run.state,
      to: result.state,
      row: result.row,
      findings: findings.length,
      blocking: blocking.length,
      remaining: remainingList.length,
      questions_added: converted.added,
      revision,
      path: docPath,
    },
    now,
  );
  return {
    round: plan.round,
    previous_state: run.state,
    state: result.state,
    path: docPath,
    findings: findings.length,
    blocking: blocking.length,
    remaining: remainingList.length,
    questions_added: converted.added,
    revision,
    open: next.open,
  };
}
