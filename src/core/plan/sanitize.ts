/** plan 제출 원문 손질: 스키마에 없는 키를 떨어뜨린다(unknown_field_dropped). */
import type { Issue } from "../errors.js";
import { sanitizeItems } from "../analysis/sanitize.js";
import { PlanItemsSchema } from "./schema.js";

/** plan 제출 원문 손질. 사람이 채우는 칸은 없다. */
export function sanitizePlan(raw: unknown): { raw: unknown; issues: Issue[] } {
  return sanitizeItems(raw, PlanItemsSchema, []);
}
