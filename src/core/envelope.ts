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
  };
}
