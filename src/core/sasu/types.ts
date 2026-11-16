/** 사수 계획(doc/sasu/<대상>-<회차>.plan.json)과 묶음 파일의 형식. */
import { z } from "zod";
import { WORK_CODES } from "../findings/schema.js";

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

export type PlanUnit = z.infer<typeof PlanUnitSchema>;
export type PlanBatch = z.infer<typeof PlanBatchSchema>;
export type SasuPlan = z.infer<typeof SasuPlanSchema>;
export type BatchFile = z.infer<typeof BatchFileSchema>;
