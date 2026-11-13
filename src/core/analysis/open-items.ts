/** 열린 항목 계산: 답 없는 질문, 결정 없는(또는 종류에 맞지 않는 값의) 차이, 확인 안 된 가정. */
import { hashJson } from "../hash.js";
import type { AnswersFile } from "./answers.js";
import { isDecisionAllowed } from "./delta-decision.js";
import type { AnalysisItems, Delta, Question } from "./schema.js";

export interface OpenItems {
  questions: string[];
  deltas: string[];
  assumptions: string[];
}

type QuestionRef = Pick<Question, "id"> & Partial<Pick<Question, "text" | "options">>;

/** 질문 본문(text·options)의 해시. 답이 어느 본문에 대한 것인지 가린다. */
export function questionHash(question: Pick<Question, "text" | "options">): string {
  return hashJson({ text: question.text, options: question.options });
}

const hasAnswerContent = (entry: AnswersFile["answers"][string] | undefined): boolean =>
  entry !== undefined && ((entry.option ?? "").length > 0 || (entry.text ?? "").trim().length > 0);

/** 답이 있는 질문의 본문이 답한 뒤에 바뀌었는가. 답에 본문 해시가 없으면 바뀌지 않은 것으로 본다. */
export function isQuestionSuperseded(question: QuestionRef, answers: AnswersFile): boolean {
  const entry = answers.answers[question.id];
  if (!hasAnswerContent(entry) || entry?.question_hash === undefined || question.text === undefined) return false;
  return entry.question_hash !== questionHash({ text: question.text, options: question.options ?? [] });
}

/** 질문에 사람의 답(선택지 또는 자유 답)이 있고 그 답이 지금의 질문 본문에 대한 것인가. */
export function isQuestionAnswered(question: QuestionRef, answers: AnswersFile): boolean {
  return hasAnswerContent(answers.answers[question.id]) && !isQuestionSuperseded(question, answers);
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
