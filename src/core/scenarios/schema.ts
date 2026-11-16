/** scenarios 본문(§5)의 zod 스키마. 형식·열거만 막고, 있어야 하는 칸의 유무는 결정적 검사가 판정한다. */
import { z } from "zod";
import { QuestionSchema } from "../analysis/schema.js";

export const BACKENDS = ["real", "mock"] as const;
export const REACHES = ["deeplink", "navigation", "unknown"] as const;
export const PLATFORMS = ["ios", "android"] as const;
export const PREFLIGHT_KINDS = ["env", "deploy", "flag", "data"] as const;
export const PREFLIGHT_FALLBACKS = ["mock", "hold"] as const;

const strings = z.array(z.string()).default([]);

const PreconditionsSchema = z.object({
  account_state: z.string().optional(),
  feature_flags: strings,
  data: z.string().optional(),
});

const StepSchema = z.object({
  n: z.number().int().min(1),
  action: z.string(),
  screen_id: z.string().optional(),
});

const ExpectedSchema = z.object({
  id: z.string(),
  text: z.string(),
  screen_id: z.string().optional(),
});

const MockSchema = z.object({
  endpoints: z.array(z.object({ method: z.string(), path: z.string(), case: z.string() })).default([]),
  reason: z.string().default(""),
});

export const ScenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  journey: z.string(),
  requirement_ids: strings,
  ac_ids: strings,
  preconditions: PreconditionsSchema.default({}),
  steps: z.array(StepSchema).default([]),
  expected: z.array(ExpectedSchema).default([]),
  backend: z.enum(BACKENDS),
  mock: MockSchema.optional(),
  environment: z.string().optional(),
  reach: z.enum(REACHES).default("unknown"),
  platforms: z.array(z.enum(PLATFORMS)).default(["ios", "android"]),
});

/** 실행하는 날 확인할 환경 상태. 게이트의 열린 항목이 아니다. */
export const PreflightSchema = z.object({
  id: z.string(),
  text: z.string(),
  kind: z.enum(PREFLIGHT_KINDS),
  scenario_ids: z.array(z.string()).min(1),
  check: z.string(),
  fallback: z.enum(PREFLIGHT_FALLBACKS),
});

/** 시나리오가 요구하는 계정 상태. 게이트의 열린 항목이 아니다. */
export const AccountSchema = z.object({
  id: z.string(),
  state: z.string(),
  available: z.boolean(),
  scenario_ids: z.array(z.string()).min(1),
  note: z.string().optional(),
});

export const ScenarioItemsSchema = z.object({
  scenarios: z.array(ScenarioSchema),
  preflight: z.array(PreflightSchema).default([]),
  accounts: z.array(AccountSchema).default([]),
  /** analysis 의 질문 스키마를 그대로 쓴다. origin 은 `qa` 여야 한다(결정적 검사). */
  questions: z.array(QuestionSchema).default([]),
});

export type Scenario = z.infer<typeof ScenarioSchema>;
export type Preflight = z.infer<typeof PreflightSchema>;
export type Account = z.infer<typeof AccountSchema>;
export type ScenarioItems = z.infer<typeof ScenarioItemsSchema>;
export type Backend = (typeof BACKENDS)[number];
