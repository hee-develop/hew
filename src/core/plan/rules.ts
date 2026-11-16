/** 분해 규칙: rules/plan.yaml 의 body_forbidden 과 프로필의 plan 을 합쳐 돌려준다. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { HewError } from "../errors.js";
import { HEW_ROOT } from "../paths.js";
import { loadProfile, titlePattern, type Profile } from "../profile.js";

/** rules/plan.yaml 이 가진 것(프로필과 무관한 본문 금지 규칙). */
export const PlanFileSchema = z.object({
  body_forbidden: z.array(z.object({ pattern: z.string().min(1), label: z.string().default("") })).default([]),
});

export interface PlanRules {
  sp: Profile["plan"]["sp"];
  /** 프로필의 제목 형식에서 만든 정규식 원문. */
  title_pattern: string;
  title_format: string;
  body_forbidden: { pattern: string; label: string }[];
  pr: Profile["plan"]["pr"];
  notes: string[];
}

/** 분해 규칙을 읽어 검증한다. 없거나 형식이 틀리거나 정규식이 틀리면 내부 오류. */
export function loadPlanRules(root: string = HEW_ROOT, profile: Profile = loadProfile()): PlanRules {
  const file = join(root, "rules", "plan.yaml");
  if (!existsSync(file)) throw new HewError("internal", `분해 규칙 파일이 없습니다: ${file}`);
  const parsed = PlanFileSchema.safeParse(parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new HewError("internal", `plan.yaml 형식이 올바르지 않습니다: ${first?.path.join(".") ?? ""} ${first?.message ?? ""}`);
  }
  for (const source of parsed.data.body_forbidden.map((f) => f.pattern)) {
    try {
      new RegExp(source);
    } catch {
      throw new HewError("internal", `plan.yaml 의 정규식이 올바르지 않습니다: ${source}`);
    }
  }
  const { plan } = profile;
  return {
    sp: plan.sp,
    title_pattern: titlePattern(plan.title.format),
    title_format: plan.title.format,
    body_forbidden: parsed.data.body_forbidden,
    pr: plan.pr,
    notes: plan.notes,
  };
}
