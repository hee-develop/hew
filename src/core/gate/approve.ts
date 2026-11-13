/** 승인(§1.3, §9): gate_plan_review 에서 revision 이 현재 값과 같고 열린 항목이 없을 때만 approved 로 잠근다. */
import { appendEvent } from "../events.js";
import { writeJsonAtomic } from "../fsx.js";
import { collectRunOpen } from "../open.js";
import { runPaths } from "../paths.js";
import { computeRevision } from "../revision.js";
import { loadRun, saveRun } from "../run.js";
import { rejectedError, stateError, usageError } from "../errors.js";
import { transition, type RunState } from "../state-machine.js";

export const APPROVAL_SOURCES = ["gate", "cli"] as const;
export type ApprovalSource = (typeof APPROVAL_SOURCES)[number];

/** 앞 12자 비교를 허용하는 revision 인자의 최소 길이. */
export const REVISION_PREFIX_MIN = 12;

export interface ApproveOptions {
  runDir: string;
  /** 전체 해시 또는 앞 12자 이상의 접두. */
  revision: string;
  source: ApprovalSource;
  now?: Date;
}

export interface ApproveResult {
  revision: string;
  approved_at: string;
  source: ApprovalSource;
  path: string;
  previous_state: RunState;
  state: RunState;
}

/** 승인을 처리한다. 상태가 다르면 종료 4, revision 이 다르면 종료 3, 열린 항목이 남으면 종료 4. */
export function approveRun(opts: ApproveOptions): ApproveResult {
  const now = opts.now ?? new Date();
  if (!/^[0-9a-f]+$/.test(opts.revision) || opts.revision.length < REVISION_PREFIX_MIN) {
    throw usageError(`--revision 은 해시 전체 또는 앞 ${REVISION_PREFIX_MIN}자 이상이어야 합니다: ${opts.revision}`);
  }
  const paths = runPaths(opts.runDir);
  const run = loadRun(opts.runDir);
  if (run.state !== "gate_plan_review") throw stateError(`상태 ${run.state} 에서는 승인할 수 없습니다. 승인은 gate_plan_review 에서만 받습니다`);

  const current = computeRevision(opts.runDir);
  if (!current.startsWith(opts.revision)) {
    throw rejectedError(`승인 요청의 revision(${opts.revision.slice(0, REVISION_PREFIX_MIN)})이 현재 revision(${current.slice(0, REVISION_PREFIX_MIN)})과 다릅니다`);
  }
  const open = collectRunOpen(opts.runDir).length;
  const result = transition(run.state, { type: "approve_requested", revision: current }, { rework: run.rework, progress: run.progress, open, revision: current });

  const approvedAt = now.toISOString();
  writeJsonAtomic(paths.approval, { revision: current, approved_at: approvedAt, source: opts.source });
  saveRun(opts.runDir, { ...run, state: result.state, revision: current, open }, now);
  appendEvent(paths.events, "approved", { revision: current, source: opts.source, from: run.state, to: result.state, row: result.row }, now);
  return { revision: current, approved_at: approvedAt, source: opts.source, path: paths.approval, previous_state: run.state, state: result.state };
}
