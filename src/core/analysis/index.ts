/** analysis 종류를 제출 흐름에 등록한다. 이 모듈을 불러오면 등록이 이뤄진다. */
import { z } from "zod";
import { registerKind } from "../submit.js";
import { loadAnswers } from "./answers.js";
import { analysisCheck } from "./checks.js";
import { computeOpenItems, openIdList } from "./open-items.js";
import { sanitizeAnalysis } from "./sanitize.js";
import { AnalysisItemsSchema } from "./schema.js";

registerKind("analysis", {
  schema: AnalysisItemsSchema as unknown as z.ZodType<Record<string, unknown>>,
  checks: [analysisCheck],
  collectOpen: (items, runDir) => {
    const parsed = AnalysisItemsSchema.safeParse(items);
    return parsed.success ? openIdList(computeOpenItems(parsed.data, loadAnswers(runDir))) : [];
  },
  sanitize: sanitizeAnalysis,
  supportsWithdraw: true,
});
