/** run.json 의 zod 스키마와 원자적 읽기·쓰기. */
import { existsSync } from "node:fs";
import { z } from "zod";
import { EVAL_KINDS } from "./eval/kinds.js";
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

export const CaseInfoSchema = z.object({
  story: z.string().optional(),
  known_at: z.string().optional(),
  prd_version: z.string().optional(),
  block: z.object({
    jira_keys: z.array(z.string()),
    pr_numbers: z.array(z.number().int()),
    heka_ids: z.array(z.string()),
  }),
});

export type CaseInfo = z.infer<typeof CaseInfoSchema>;

/** 결함 주입 실행(§11.5)이 가리키는 원본 실행·주입 종류·시드. */
export const EvalInfoSchema = z.object({
  source_run: z.string().min(1),
  kind: z.enum(EVAL_KINDS),
  seed: z.number().int().min(0),
});

export type EvalInfo = z.infer<typeof EvalInfoSchema>;

/** 수집 중 필수가 아니라 넘어간 일(실패한 항목, 건너뛴 링크). */
export const CollectWarningSchema = z.object({
  code: z.string(),
  item: z.string(),
  message: z.string(),
});

export type CollectWarning = z.infer<typeof CollectWarningSchema>;

export const RunSchema = z.object({
  run_id: z.string().min(1),
  mode: z.enum(RUN_MODES),
  input: z.object({ kind: z.enum(INPUT_KINDS), url: z.string().min(1), figma: z.array(z.string().min(1)).optional() }),
  repo: z.object({ path: z.string().nullable(), base: z.string().nullable() }),
  case: z.string().nullable(),
  /** 리플레이에서 사례 시점까지의 지식만 쓰기 위한 기준 시점(날짜 또는 ISO 시각). */
  known_at: z.string().nullable().optional(),
  /** 사례 파일에서 읽은 정보(replay). */
  case_info: CaseInfoSchema.optional(),
  /** 결함 주입 실행이면 그 정보. 있으면 사수 회차 완료 처리를 하지 않는다. */
  eval: EvalInfoSchema.optional(),
  /** hew source done 이 통과하면서 남긴 선택 항목 경고. */
  collect_warnings: z.array(CollectWarningSchema).optional(),
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
