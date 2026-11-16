/** scenarios 제출 원문 손질: 질문의 사람의 칸을 버리고(human_field_ignored), 스키마에 없는 키를 떨어뜨린다(unknown_field_dropped). */
import type { Issue } from "../errors.js";
import { sanitizeItems, type HumanFields } from "../analysis/sanitize.js";
import { ScenarioItemsSchema } from "./schema.js";

const HUMAN_FIELDS: HumanFields = [["questions", "answer"]];

/** scenarios 제출 원문 손질. */
export function sanitizeScenarios(raw: unknown): { raw: unknown; issues: Issue[] } {
  return sanitizeItems(raw, ScenarioItemsSchema, HUMAN_FIELDS);
}
