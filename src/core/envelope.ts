/** 산출물 틀(§2.1) 스키마와 items 에 틀을 씌우는 함수. */
import { z } from "zod";

export const STAGES = ["analysis", "scenarios", "plan", "findings_analysis", "findings_plan"] as const;
export type Stage = (typeof STAGES)[number];

const ProducedBySchema = z.object({
  role: z.string(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  role_sha: z.string().nullable(),
  session_id: z.string().nullable(),
});

const CostSchema = z.object({
  usd: z.number().nullable(),
  duration_ms: z.number().nullable(),
});

export const EnvelopeSchema = z.object({
  schema: z.string().regex(/^hew\.[a-z_]+\/[0-9]+$/),
  run_id: z.string(),
  stage: z.enum(STAGES),
  attempt: z.number().int().min(1),
  input_revision: z.string(),
  produced_by: ProducedBySchema.nullable(),
  items: z.record(z.unknown()),
  open: z.array(z.string()),
  verdict: z.object({
    status: z.enum(["pass", "blocked"]),
    reasons: z.array(z.string()),
  }),
  cost: CostSchema.nullable(),
  /** 시나리오 정본만: 제출 시점 분석의 요구별 해시. revision 계산에는 들어가지 않는다. */
  basis: z.record(z.string()).optional(),
});

export type Envelope = z.infer<typeof EnvelopeSchema>;
export type ProducedBy = z.infer<typeof ProducedBySchema>;
export type Cost = z.infer<typeof CostSchema>;

export interface WrapInput {
  stage: Stage;
  runId: string;
  attempt: number;
  inputRevision: string;
  items: Record<string, unknown>;
  open?: string[];
  verdictReasons?: string[];
  producedBy?: ProducedBy | null;
  cost?: Cost | null;
  basis?: Record<string, string>;
}

/** 에이전트가 낸 items 에 공통 틀을 씌운다. produced_by·cost 는 받은 값을 그대로 넣고 없으면 null. */
export function wrapEnvelope(input: WrapInput): Envelope {
  const kind = input.stage.startsWith("findings_") ? "findings" : input.stage;
  return {
    schema: `hew.${kind}/1`,
    run_id: input.runId,
    stage: input.stage,
    attempt: input.attempt,
    input_revision: input.inputRevision,
    produced_by: input.producedBy ?? null,
    items: input.items,
    open: input.open ?? [],
    verdict: { status: "pass", reasons: input.verdictReasons ?? [] },
    cost: input.cost ?? null,
    ...(input.basis === undefined ? {} : { basis: input.basis }),
  };
}

/** 환경 변수 HEW_PRODUCED_BY(JSON)에서 produced_by 를 읽는다. 없거나 형식이 틀리면 null. */
export function producedByFromEnv(env: NodeJS.ProcessEnv = process.env): ProducedBy | null {
  const raw = env.HEW_PRODUCED_BY;
  if (raw === undefined || raw.length === 0) return null;
  try {
    const parsed = ProducedBySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
