/** rules/plan.yaml(분해 규칙)을 읽는다. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { HewError } from "../errors.js";
import { HEW_ROOT } from "../paths.js";

export const PlanRulesSchema = z.object({
  sp: z.object({ min: z.number(), max: z.number(), hours_per_sp: z.number().positive() }),
  title_pattern: z.string().min(1),
  body_forbidden: z.array(z.object({ pattern: z.string().min(1), label: z.string().default("") })).default([]),
  pr: z.object({ max_tickets: z.number().int().min(1) }),
});

export type PlanRules = z.infer<typeof PlanRulesSchema>;

/** 분해 규칙 파일을 읽어 검증한다. 없거나 형식이 틀리거나 정규식이 틀리면 내부 오류. */
export function loadPlanRules(root: string = HEW_ROOT): PlanRules {
  const file = join(root, "rules", "plan.yaml");
  if (!existsSync(file)) throw new HewError("internal", `분해 규칙 파일이 없습니다: ${file}`);
  const parsed = PlanRulesSchema.safeParse(parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new HewError("internal", `plan.yaml 형식이 올바르지 않습니다: ${first?.path.join(".") ?? ""} ${first?.message ?? ""}`);
  }
  for (const source of [parsed.data.title_pattern, ...parsed.data.body_forbidden.map((f) => f.pattern)]) {
    try {
      new RegExp(source);
    } catch {
      throw new HewError("internal", `plan.yaml 의 정규식이 올바르지 않습니다: ${source}`);
    }
  }
  return parsed.data;
}
