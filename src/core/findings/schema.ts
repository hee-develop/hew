/** 지적(findings, §6.4) 본문의 zod 스키마와 작업 단위 코드별 허용 종류. */
import { z } from "zod";
import { BoxSchema } from "../analysis/schema.js";
import { ID_PATTERNS } from "../ids.js";

export const ANALYSIS_WORK_CODES = ["W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9"] as const;
export const PLAN_WORK_CODES = ["T1"] as const;
export const WORK_CODES = [...ANALYSIS_WORK_CODES, ...PLAN_WORK_CODES] as const;
export type WorkCode = (typeof WORK_CODES)[number];

export const FINDING_VERDICTS = ["ok", "issue"] as const;
export const FINDING_KINDS = [
  "unsupported",
  "missing",
  "wrong_disposition",
  "false_confirmed",
  "ai_only_behavior",
  "operator_row",
  "visual_unlisted",
  "bad_pairing",
  "already_answered",
  "ticket_contradicts",
  "ticket_missing_change",
  "ticket_missing_context",
] as const;
export const FINDING_ACTIONS = ["fix", "ask", "drop"] as const;

export type FindingKind = (typeof FINDING_KINDS)[number];
export type FindingAction = (typeof FINDING_ACTIONS)[number];

/** 작업 단위 코드마다 허용되는 지적 종류. */
export const KINDS_BY_CODE: Record<WorkCode, readonly FindingKind[]> = {
  W2: ["unsupported"],
  W3: ["missing", "wrong_disposition"],
  W4: ["false_confirmed"],
  W5: ["ai_only_behavior"],
  W6: ["operator_row"],
  W7: ["visual_unlisted"],
  W8: ["bad_pairing"],
  W9: ["already_answered"],
  T1: ["ticket_contradicts", "ticket_missing_change", "ticket_missing_context"],
};

/** 지적 종류를 실수 기록(§12)의 type 으로 옮기는 표. */
export const MISTAKE_TYPE_BY_KIND: Record<FindingKind, string> = {
  unsupported: "wrong_evidence",
  missing: "missing_requirement",
  wrong_disposition: "scope_closed_by_guess",
  false_confirmed: "false_confirmed",
  ai_only_behavior: "invented_requirement",
  operator_row: "wrong_evidence",
  visual_unlisted: "visual_missed",
  bad_pairing: "other",
  already_answered: "needless_question",
  ticket_contradicts: "bad_plan",
  ticket_missing_change: "bad_plan",
  ticket_missing_context: "bad_plan",
};

const FindingEvidenceSchema = z.object({
  quote: z.string().optional(),
  unit_id: z.string().optional(),
  image: z.string().optional(),
  box: BoxSchema.optional(),
});

export const FindingSchema = z.object({
  id: z.string().regex(ID_PATTERNS.finding, "지적 id 는 F-n 형식이어야 합니다"),
  work: z.string().min(1),
  verdict: z.enum(FINDING_VERDICTS),
  kind: z.enum(FINDING_KINDS).optional(),
  claim: z.string().optional(),
  evidence: FindingEvidenceSchema.optional(),
  action: z.enum(FINDING_ACTIONS).optional(),
});

export const FindingsItemsSchema = z.object({ findings: z.array(FindingSchema) });

/** 코어가 차단 여부와 재사용 표시를 붙여 저장한 지적. */
export const StoredFindingSchema = FindingSchema.extend({
  blocking: z.boolean(),
  reused: z.boolean().optional(),
  /** 반송 상한에 닿아 사람에게 묻는 질문으로 바뀐 차단 지적(분석용). */
  to_question: z.boolean().optional(),
  /** 반송 상한에 닿아 게이트의 확인 필요로 올라가는 차단 지적(분해안용). */
  to_gate: z.boolean().optional(),
});

export type Finding = z.infer<typeof FindingSchema>;
export type StoredFinding = z.infer<typeof StoredFindingSchema>;
export type FindingEvidence = z.infer<typeof FindingEvidenceSchema>;

/** 작업 단위 id(`<code>:<대상>`)를 코드와 대상으로 가른다. 형식이 맞지 않으면 null. */
export function splitWorkId(id: string): { code: WorkCode; target: string } | null {
  const at = id.indexOf(":");
  if (at < 0) return null;
  const code = id.slice(0, at);
  const target = id.slice(at + 1);
  return (WORK_CODES as readonly string[]).includes(code) && target.length > 0 ? { code: code as WorkCode, target } : null;
}
