/** scenarios 의 열린 항목 계산: 답 없는 질문. */
import type { AnswersFile } from "../analysis/answers.js";
import { isQuestionAnswered } from "../analysis/open-items.js";
import type { ScenarioItems } from "./schema.js";

/** 답이 없는 질문 id 를 문서 순서대로 모은다. */
export function computeScenarioOpen(items: Pick<ScenarioItems, "questions">, answers: AnswersFile): string[] {
  return items.questions.filter((q) => !isQuestionAnswered(q, answers)).map((q) => q.id);
}
