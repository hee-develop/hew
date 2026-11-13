/** plan 종류를 제출 흐름에 등록한다. 이 모듈을 불러오면 등록이 이뤄진다. */
import { z } from "zod";
import { registerKind } from "../submit.js";
import { planCheck } from "./checks.js";
import { sanitizePlan } from "./sanitize.js";
import { PlanItemsSchema } from "./schema.js";

registerKind("plan", {
  schema: PlanItemsSchema as unknown as z.ZodType<Record<string, unknown>>,
  checks: [planCheck],
  collectOpen: () => [],
  sanitize: sanitizePlan,
});
