/** 사수 계획(doc/sasu/<대상>-<회차>.plan.json)과 묶음 파일의 형식. */
import { z } from "zod";
import { WORK_CODES } from "../findings/schema.js";
import { ID_PATTERNS } from "../ids.js";

export const SASU_TARGETS = ["analysis", "plan"] as const;
export type SasuTarget = (typeof SASU_TARGETS)[number];

/** 묶음 하나의 단위 수 상한. */
export const BATCH_UNIT_LIMIT = 20;
/** W7(이미지) 묶음의 단위 수 상한. */
export const BATCH_IMAGE_UNIT_LIMIT = 4;
/** 묶음 하나의 inputs JSON 글자 수 합 상한. */
export const BATCH_CHAR_LIMIT = 60_000;

export const PlanUnitSchema = z.object({
  id: z.string(),
  code: z.enum(WORK_CODES),
  target: z.string(),
  hash: z.string(),
  batch: z.number().int().min(1).nullable(),
  reuse: z.boolean().optional(),
});

export const PlanBatchSchema = z.object({
  k: z.number().int().min(1),
  code: z.enum(WORK_CODES),
  unit_ids: z.array(z.string()).min(1),
  path: z.string(),
});

export const SasuPlanSchema = z.object({
  for: z.enum(SASU_TARGETS),
  round: z.number().int().min(1),
  units: z.array(PlanUnitSchema),
  batches: z.array(PlanBatchSchema),
});

export const BatchFileSchema = z.object({
  for: z.enum(SASU_TARGETS),
  round: z.number().int().min(1),
  batch: z.number().int().min(1),
  code: z.enum(WORK_CODES),
  question: z.string(),
  units: z.array(z.object({ id: z.string(), target: z.string(), inputs: z.record(z.unknown()) })),
});

export const RESPONSE_KINDS = ["fixed", "rejected", "asked"] as const;

export const ResponseSchema = z.object({
  finding: z.string().regex(ID_PATTERNS.finding, "지적 id 는 F-n 형식이어야 합니다"),
  response: z.enum(RESPONSE_KINDS),
  reason: z.string().default(""),
  evidence: z.object({ unit_id: z.string().min(1), quote: z.string() }).optional(),
});

export const ResponsesInputSchema = z.object({ responses: z.array(ResponseSchema) });

/** 저장하는 답변 파일(doc/sasu/<대상>-<회차>.responses.json). */
export const ResponsesFileSchema = z.object({
  for: z.enum(SASU_TARGETS),
  round: z.number().int().min(1),
  responses: z.array(ResponseSchema),
});

export type PlanUnit = z.infer<typeof PlanUnitSchema>;
export type PlanBatch = z.infer<typeof PlanBatchSchema>;
export type SasuPlan = z.infer<typeof SasuPlanSchema>;
export type BatchFile = z.infer<typeof BatchFileSchema>;
export type Response = z.infer<typeof ResponseSchema>;
export type ResponsesFile = z.infer<typeof ResponsesFileSchema>;
