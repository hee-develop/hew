/** scenarios 종류를 제출 흐름에 등록한다. 이 모듈을 불러오면 등록이 이뤄진다. */
import { z } from "zod";
import { loadAnswers } from "../analysis/answers.js";
import { registerKind } from "../submit.js";
import { scenariosCheck } from "./checks.js";
import { computeScenarioOpen } from "./open-items.js";
import { sanitizeScenarios } from "./sanitize.js";
import { ScenarioItemsSchema } from "./schema.js";

registerKind("scenarios", {
  schema: ScenarioItemsSchema as unknown as z.ZodType<Record<string, unknown>>,
  checks: [scenariosCheck],
  collectOpen: (items, runDir) => {
    const parsed = ScenarioItemsSchema.safeParse(items);
    return parsed.success ? computeScenarioOpen(parsed.data, loadAnswers(runDir)) : [];
  },
  sanitize: sanitizeScenarios,
  supportsWithdraw: true,
});
