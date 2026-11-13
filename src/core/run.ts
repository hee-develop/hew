/** run.json 의 zod 스키마와 원자적 읽기·쓰기. */
import { existsSync } from "node:fs";
import { z } from "zod";
import { HewError, usageError } from "./errors.js";
import { readJsonFile, writeJsonAtomic } from "./fsx.js";
import { runPaths } from "./paths.js";
import { RUN_STATES } from "./state-machine.js";

export const RUN_MODES = ["live", "replay", "shadow"] as const;
export const INPUT_KINDS = ["prd", "ticket"] as const;
export const SUBMISSION_KEYS = ["analysis", "scenarios", "plan", "findings_analysis", "findings_plan"] as const;

export type SubmissionKey = (typeof SUBMISSION_KEYS)[number];

const SubmissionRecordSchema = z.object({
  attempt: z.number().int().min(1),
  at: z.string(),
  hash: z.string(),
});

export type SubmissionRecord = z.infer<typeof SubmissionRecordSchema>;

export const RunSchema = z.object({
  run_id: z.string().min(1),
  mode: z.enum(RUN_MODES),
  input: z.object({ kind: z.enum(INPUT_KINDS), url: z.string().min(1) }),
  repo: z.object({ path: z.string().nullable(), base: z.string().nullable() }),
  case: z.string().nullable(),
  state: z.enum(RUN_STATES),
  revision: z.string(),
  rework: z.object({ analysis: z.number().int().min(0), plan: z.number().int().min(0) }),
  progress: z.object({ analysis: z.boolean(), scenarios: z.boolean(), sasu: z.boolean() }),
  open: z.number().int().min(0),
  submissions: z.object({
    analysis: SubmissionRecordSchema.optional(),
    scenarios: SubmissionRecordSchema.optional(),
    plan: SubmissionRecordSchema.optional(),
    findings_analysis: SubmissionRecordSchema.optional(),
    findings_plan: SubmissionRecordSchema.optional(),
  }),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Run = z.infer<typeof RunSchema>;

/** run.json 을 읽어 검증한다. 없으면 사용법 오류, 형식이 틀리면 내부 오류. */
export function loadRun(runDir: string): Run {
  const { runJson } = runPaths(runDir);
  if (!existsSync(runJson)) throw usageError(`실행 폴더에 run.json 이 없습니다: ${runDir}`);
  const parsed = RunSchema.safeParse(readJsonFile(runJson));
  if (!parsed.success) {
    throw new HewError("internal", `run.json 형식이 올바르지 않습니다: ${parsed.error.issues[0]?.message ?? ""}`);
  }
  return parsed.data;
}

/** updated_at 을 갱신해 run.json 을 원자적으로 쓴다. */
export function saveRun(runDir: string, run: Run, now: Date = new Date()): Run {
  const next: Run = { ...run, updated_at: now.toISOString() };
  writeJsonAtomic(runPaths(runDir).runJson, RunSchema.parse(next));
  return next;
}
