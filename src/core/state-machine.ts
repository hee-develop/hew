/** 상태 전이 표(§1.3, 구현 기준)를 구현한 순수 함수. */
import { HewError, stateError } from "./errors.js";

export const RUN_STATES = [
  "init",
  "collected",
  "analyzed",
  "vetted",
  "checked",
  "gate_answering",
  "answers_complete",
  "answers_applied",
  "planned",
  "plan_checked",
  "gate_plan_review",
  "approved",
] as const;

export type RunState = (typeof RUN_STATES)[number];

/** 사수 반송 상한. */
export const REWORK_LIMIT = 2;

export interface Rework {
  analysis: number;
  plan: number;
}

/** answers_complete 안에서 끝난 일. */
export interface AnswersProgress {
  analysis: boolean;
  scenarios: boolean;
  sasu: boolean;
}

export type FindingsTarget = "analysis" | "plan";

export type TransitionEvent =
  | { type: "sources_complete" }
  | { type: "analysis_accepted"; open: number }
  | { type: "scenarios_accepted"; open: number }
  | { type: "plan_accepted" }
  | { type: "findings_complete"; for: FindingsTarget; blocking: number }
  | { type: "gate_published"; phase: "answer" | "approve" }
  | { type: "answers_imported"; open: number }
  | { type: "plan_change_requested" }
  | { type: "approve_requested"; revision: string };

export interface TransitionContext {
  rework: Rework;
  progress: AnswersProgress;
  open: number;
  revision: string;
}

/** 전이로 바뀌는 run 값. 있는 칸만 바뀐다. */
export interface RunChanges {
  rework?: Rework;
  progress?: AnswersProgress;
  open?: number;
}

export interface TransitionResult {
  state: RunState;
  changes: RunChanges;
  /** 전이 표의 줄 번호(1부터). 상태가 그대로이고 진행만 기록하면 null. */
  row: number | null;
}

export const emptyProgress = (): AnswersProgress => ({ analysis: false, scenarios: false, sasu: false });

function rejectEvent(state: RunState, event: TransitionEvent): never {
  throw stateError(`상태 ${state} 에서는 사건 ${event.type} 을(를) 받을 수 없습니다`);
}

function transitionAnswersComplete(event: TransitionEvent, ctx: TransitionContext): TransitionResult {
  const progress = { ...ctx.progress };
  let open = ctx.open;
  if (event.type === "analysis_accepted") {
    return {
      state: "answers_complete",
      changes: { progress: { analysis: true, sasu: false, scenarios: false }, open: event.open },
      row: null,
    };
  }
  if (event.type === "findings_complete" && event.for === "analysis") {
    if (!progress.analysis) throw stateError("분석 재제출이 끝나기 전에는 사수 재확인을 받을 수 없습니다");
    if (event.blocking > 0 && ctx.rework.analysis < REWORK_LIMIT) {
      return {
        state: "answers_complete",
        changes: {
          rework: { ...ctx.rework, analysis: ctx.rework.analysis + 1 },
          progress: { analysis: false, sasu: false, scenarios: false },
          open,
        },
        row: null,
      };
    }
    return { state: "answers_complete", changes: { progress: { ...progress, sasu: true }, open }, row: null };
  }
  if (event.type === "scenarios_accepted") {
    if (!progress.sasu) throw stateError("사수 재확인이 끝나기 전에는 시나리오 재제출을 받을 수 없습니다");
    open = event.open;
    return open === 0
      ? { state: "answers_applied", changes: { progress: emptyProgress(), open }, row: 9 }
      : { state: "checked", changes: { progress: emptyProgress(), open }, row: 10 };
  }
  return rejectEvent("answers_complete", event);
}

/** 지금 상태와 사건으로 다음 상태와 run 변경분을 계산한다. 표에 없는 조합은 종료 4 오류. */
export function transition(state: RunState, event: TransitionEvent, ctx: TransitionContext): TransitionResult {
  switch (state) {
    case "init": {
      if (event.type === "sources_complete") return { state: "collected", changes: {}, row: 1 };
      return rejectEvent(state, event);
    }
    case "collected": {
      if (event.type === "analysis_accepted") {
        return { state: "analyzed", changes: { open: event.open }, row: 2 };
      }
      return rejectEvent(state, event);
    }
    case "analyzed": {
      if (event.type !== "findings_complete" || event.for !== "analysis") return rejectEvent(state, event);
      const noBlocking = event.blocking === 0;
      const reworkFull = ctx.rework.analysis >= REWORK_LIMIT;
      if (noBlocking || reworkFull) return { state: "vetted", changes: {}, row: 3 };
      return {
        state: "collected",
        changes: { rework: { ...ctx.rework, analysis: ctx.rework.analysis + 1 } },
        row: 4,
      };
    }
    case "vetted": {
      if (event.type === "scenarios_accepted") return { state: "checked", changes: { open: event.open }, row: 5 };
      return rejectEvent(state, event);
    }
    case "checked": {
      if (event.type === "gate_published" && event.phase === "answer") {
        return { state: "gate_answering", changes: {}, row: 6 };
      }
      return rejectEvent(state, event);
    }
    case "gate_answering": {
      if (event.type !== "answers_imported") return rejectEvent(state, event);
      const allClosed = event.open === 0;
      return allClosed
        ? { state: "answers_complete", changes: { open: 0, progress: emptyProgress(), rework: { ...ctx.rework, analysis: 0 } }, row: 7 }
        : { state: "gate_answering", changes: { open: event.open }, row: 8 };
    }
    case "answers_complete":
      return transitionAnswersComplete(event, ctx);
    case "answers_applied": {
      if (event.type === "plan_accepted") return { state: "planned", changes: {}, row: 11 };
      return rejectEvent(state, event);
    }
    case "planned": {
      if (event.type !== "findings_complete" || event.for !== "plan") return rejectEvent(state, event);
      const noBlocking = event.blocking === 0;
      const reworkFull = ctx.rework.plan >= REWORK_LIMIT;
      if (noBlocking || reworkFull) return { state: "plan_checked", changes: {}, row: 12 };
      return {
        state: "answers_applied",
        changes: { rework: { ...ctx.rework, plan: ctx.rework.plan + 1 } },
        row: 13,
      };
    }
    case "plan_checked": {
      if (event.type === "gate_published" && event.phase === "approve") {
        return { state: "gate_plan_review", changes: {}, row: 14 };
      }
      return rejectEvent(state, event);
    }
    case "gate_plan_review": {
      if (event.type === "plan_change_requested") {
        return { state: "answers_applied", changes: { rework: { ...ctx.rework, plan: 0 } }, row: 15 };
      }
      if (event.type === "approve_requested") {
        if (event.revision !== ctx.revision) {
          throw new HewError("rejected", "승인 요청의 revision 이 현재 revision 과 다릅니다");
        }
        if (ctx.open > 0) throw stateError("열린 항목이 남아 있어 승인할 수 없습니다");
        return { state: "approved", changes: {}, row: 16 };
      }
      return rejectEvent(state, event);
    }
    case "approved":
      return rejectEvent(state, event);
  }
}
