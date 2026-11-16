/** 상태와 run 정보로 다음에 할 일을 계산하는 순수 함수(전이 표의 마지막 열). */
import type { AnswersProgress, Rework, RunState } from "./state-machine.js";

export type NextAction =
  | { action: "spawn"; role: "collector"; purpose: "first" }
  | { action: "spawn"; role: "technical-manager"; purpose: "first" | "rework" | "apply_answers" }
  | { action: "spawn"; role: "qa-designer"; purpose: "first" | "apply_answers" }
  | { action: "spawn"; role: "ticket-maker"; purpose: "first" | "rework" }
  | { action: "sasu"; for: "analysis" | "plan" }
  | { action: "publish_gate"; phase: "answer" | "approve" }
  | { action: "wait_human"; for: "answers" | "approval" }
  | { action: "done" };

export interface NextContext {
  rework: Rework;
  progress: AnswersProgress;
}

export function nextAction(state: RunState, ctx: NextContext): NextAction {
  switch (state) {
    case "init":
      return { action: "spawn", role: "collector", purpose: "first" };
    case "collected":
      return {
        action: "spawn",
        role: "technical-manager",
        purpose: ctx.rework.analysis > 0 ? "rework" : "first",
      };
    case "analyzed":
      return { action: "spawn", role: "qa-designer", purpose: "first" };
    case "qa_designed":
      return { action: "sasu", for: "analysis" };
    case "checked":
      return { action: "publish_gate", phase: "answer" };
    case "gate_answering":
      return { action: "wait_human", for: "answers" };
    case "answers_complete": {
      // 시나리오 진행은 남고 분석 진행만 false 이면 사수 반송이다.
      if (!ctx.progress.analysis) {
        return { action: "spawn", role: "technical-manager", purpose: ctx.progress.scenarios ? "rework" : "apply_answers" };
      }
      if (!ctx.progress.scenarios) {
        return { action: "spawn", role: "qa-designer", purpose: "apply_answers" };
      }
      return { action: "sasu", for: "analysis" };
    }
    case "answers_applied":
      return { action: "spawn", role: "ticket-maker", purpose: ctx.rework.plan > 0 ? "rework" : "first" };
    case "planned":
      return { action: "sasu", for: "plan" };
    case "plan_checked":
      return { action: "publish_gate", phase: "approve" };
    case "gate_plan_review":
      return { action: "wait_human", for: "approval" };
    case "approved":
      return { action: "done" };
  }
}
