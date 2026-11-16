/** 열린 항목 계산: 답 없는 질문, 결정 없는(또는 종류에 맞지 않는 값의) 차이, 확인 안 된 가정. */
import type { AnswersFile } from "./answers.js";
import { isDecisionAllowed } from "./delta-decision.js";
import type { AnalysisItems, Delta, Question } from "./schema.js";

export interface OpenItems {
  questions: string[];
  deltas: string[];
  assumptions: string[];
}

/** 질문에 사람의 답(선택지 또는 자유 답)이 있는가. */
export function isQuestionAnswered(question: Pick<Question, "id">, answers: AnswersFile): boolean {
  const entry = answers.answers[question.id];
  if (entry === undefined) return false;
  return (entry.option ?? "").length > 0 || (entry.text ?? "").trim().length > 0;
}

/** 차이에 유효한 사람의 결정이 있는가. `hold` 도 결정이다. */
export function hasValidDecision(delta: Pick<Delta, "id" | "kind">, answers: AnswersFile): boolean {
  const entry = answers.scope[delta.id];
  return entry !== undefined && isDecisionAllowed(delta.kind, entry.decision);
}

/** 항목별로 아직 닫히지 않은 id 를 문서 순서대로 모은다. */
export function computeOpenItems(items: Pick<AnalysisItems, "questions" | "deltas" | "assumptions">, answers: AnswersFile): OpenItems {
  return {
    questions: items.questions.filter((q) => !isQuestionAnswered(q, answers)).map((q) => q.id),
    deltas: items.deltas.filter((d) => !hasValidDecision(d, answers)).map((d) => d.id),
    assumptions: items.assumptions.filter((a) => answers.assumptions[a.id] === undefined).map((a) => a.id),
  };
}

/** 열린 항목 id 를 질문, 차이, 가정 순으로 이은 목록. */
export function openIdList(open: OpenItems): string[] {
  return [...open.questions, ...open.deltas, ...open.assumptions];
}
