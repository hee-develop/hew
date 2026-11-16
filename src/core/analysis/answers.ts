/** doc/answers.json(§8.2)의 형식과 읽기. 파일이 없으면 모두 빈 것으로 본다. */
import { existsSync } from "node:fs";
import { z } from "zod";
import { HewError } from "../errors.js";
import { readJsonFile } from "../fsx.js";
import { runPaths } from "../paths.js";
import { DELTA_DECISION_VALUES } from "./delta-decision.js";

const At = z.string();
const By = z.string().optional();

export const AnswersFileSchema = z.object({
  answers: z
    .record(z.object({ option: z.string().optional(), text: z.string().optional(), question_hash: z.string().optional(), at: At, by: By }))
    .default({}),
  scope: z
    .record(z.object({ decision: z.enum(DELTA_DECISION_VALUES), note: z.string().optional(), at: At, by: By }))
    .default({}),
  assumptions: z
    .record(z.object({ status: z.enum(["confirmed", "rejected"]), note: z.string().optional(), at: At, by: By }))
    .default({}),
  scenarios: z.record(z.object({ backend: z.string(), note: z.string().optional(), at: At, by: By })).default({}),
  plan_requests: z.array(z.object({ target: z.string(), text: z.string(), at: At, by: By })).default([]),
  approvals: z.record(z.object({ revision: z.string(), at: At, by: By, note: z.string().optional() })).default({}),
});

export type AnswersFile = z.infer<typeof AnswersFileSchema>;

export const emptyAnswers = (): AnswersFile => AnswersFileSchema.parse({});

/** answers.json 을 읽는다. 없으면 빈 값, 형식이 틀리면 내부 오류. */
export function loadAnswers(runDir: string): AnswersFile {
  const file = runPaths(runDir).answers;
  if (!existsSync(file)) return emptyAnswers();
  const parsed = AnswersFileSchema.safeParse(readJsonFile(file));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new HewError("internal", `answers.json 형식이 올바르지 않습니다: ${first?.path.join(".") ?? ""} ${first?.message ?? ""}`);
  }
  return parsed.data;
}
