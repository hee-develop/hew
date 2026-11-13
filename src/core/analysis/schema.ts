/** analysis 본문(§4.1~§4.5)의 zod 스키마. 형식·열거만 막고, 있어야 하는 칸의 유무는 결정적 검사가 판정한다. */
import { z } from "zod";

export const SCREEN_CHANGES = ["new", "changed", "removed", "reference"] as const;
export const IMAGE_ROLES = ["as_is", "to_be", "both"] as const;
export const REQ_STATUSES = ["confirmed", "pending"] as const;
export const VERIFY_METHODS = ["unit_test", "type_check", "qa_scenario", "visual_compare", "review"] as const;
export const AI_CODE_ROLES = ["modify", "reuse", "reference"] as const;
export const DELTA_KINDS = ["figma_only", "prd_only", "mismatch"] as const;
export const AUDIENCES = ["dev", "po", "designer", "backend"] as const;
export const QUESTION_ORIGINS = ["analysis", "impact", "qa", "sasu"] as const;
export const DISPOSITIONS = ["covered", "out_of_scope", "not_app", "duplicate", "context"] as const;
export const BLOCKER_KINDS = ["missing_asset", "missing_api", "missing_field", "unclear_component", "other"] as const;

const strings = z.array(z.string()).default([]);

export const BoxSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

const QuoteEvidenceSchema = z.object({ unit_id: z.string(), quote: z.string() });
const ImageEvidenceSchema = z.object({ unit_id: z.string(), image: z.string(), box: BoxSchema.optional() });

/** 근거(§2.3): 인용 또는 이미지. 둘 중 하나의 형태여야 한다. */
export const EvidenceSchema = z.union([QuoteEvidenceSchema, ImageEvidenceSchema]);

const ImageRefSchema = z.object({ role: z.enum(IMAGE_ROLES), path: z.string(), hash: z.string().optional() });

const VariantSchema = z.object({
  id: z.string(),
  name: z.string(),
  images: z.array(ImageRefSchema).default([]),
});

export const ScreenSchema = z.object({
  id: z.string(),
  name: z.string(),
  figma: z.object({ file_key: z.string().optional(), node_id: z.string().optional(), url: z.string().optional() }).optional(),
  images: z.array(ImageRefSchema).default([]),
  variants: z.array(VariantSchema).default([]),
  code: z.object({ name: z.string().optional(), path: z.string().optional() }).optional(),
  change: z.enum(SCREEN_CHANGES),
});

const ChangeSchema = z.object({
  text: z.string(),
  screen_id: z.string().optional(),
  evidence: z.array(EvidenceSchema).default([]),
});

const AcceptanceSchema = z.object({
  id: z.string(),
  given: z.string().optional(),
  when: z.string(),
  then: z.string(),
  verify: z.object({ method: z.enum(VERIFY_METHODS), detail: z.string().optional() }).optional(),
});

const AiSchema = z.object({
  code: z.array(z.object({ path: z.string(), symbol: z.string().optional(), role: z.enum(AI_CODE_ROLES) })).default([]),
  verify: z.array(z.object({ ac_id: z.string(), detail: z.string() })).default([]),
  rules: strings,
  notes: z.array(z.object({ text: z.string(), evidence: z.array(EvidenceSchema).default([]) })).default([]),
});

export const RequirementSchema = z.object({
  id: z.string(),
  title: z.string(),
  screen_ids: strings,
  changes: z.array(ChangeSchema).default([]),
  status: z.enum(REQ_STATUSES),
  acceptance: z.array(AcceptanceSchema).default([]),
  ai: AiSchema.default({}),
  depends_on: strings,
});

const ComparisonSchema = z.object({
  prd_source: z.string().optional(),
  figma_source: z.string().optional(),
  rows: z.array(z.object({ aspect: z.string(), prd: z.string().optional(), figma: z.string().optional() })).default([]),
});

export const DeltaSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(DELTA_KINDS),
  requirement_ids: strings,
  comparison: ComparisonSchema.optional(),
  prd_evidence: z.array(EvidenceSchema).default([]),
  figma_evidence: z.array(EvidenceSchema).default([]),
  audience: z.array(z.enum(AUDIENCES)).default([]),
  recommendation: z.object({ decision: z.string(), reason: z.string().optional() }).optional(),
  /** 사람의 칸. 제출 처리에서 값을 버린다. */
  decision: z.unknown().optional(),
});

const OptionSchema = z.object({ key: z.string(), label: z.string(), consequence: z.string().default("") });

export const QuestionSchema = z.object({
  id: z.string(),
  text: z.string(),
  origin: z.enum(QUESTION_ORIGINS),
  blocking: z.boolean(),
  options: z.array(OptionSchema).default([]),
  recommended: z.string().optional(),
  rationale: z.array(EvidenceSchema).default([]),
  affects: strings,
  audience: z.array(z.enum(AUDIENCES)).default([]),
  /** 사람의 칸. 제출 처리에서 값을 버린다. */
  answer: z.unknown().optional(),
});

export const AssumptionSchema = z.object({
  id: z.string(),
  text: z.string(),
  basis: z.string(),
  requirement_ids: strings,
  /** 사람의 칸. 제출 처리에서 값을 버린다. */
  status: z.unknown().optional(),
});

export const CoverageRowSchema = z.object({
  id: z.string(),
  unit_ids: z.array(z.string()).min(1),
  disposition: z.enum(DISPOSITIONS),
  requirement_ids: strings,
  screen_ids: strings,
  quote: z.string().optional(),
  reason: z.string().optional(),
  delta_id: z.string().optional(),
});

export const ImpactSchema = z.object({
  areas: z
    .array(
      z.object({
        id: z.string(),
        screen_ids: strings,
        paths: strings,
        components: strings,
        feature_flag: z.string().optional(),
      }),
    )
    .default([]),
  apis: z
    .array(
      z.object({
        method: z.string(),
        path: z.string(),
        fields: strings,
        presence: z.record(z.boolean()).default({}),
      }),
    )
    .default([]),
  assets: z.array(z.object({ name: z.string(), exists: z.boolean(), path: z.string().optional() })).default([]),
  blockers: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(BLOCKER_KINDS),
        detail: z.string(),
        question_id: z.string().optional(),
      }),
    )
    .default([]),
  environment: z.object({ name: z.string().optional(), basis: z.string().optional() }).optional(),
});

export const AnalysisItemsSchema = z.object({
  screens: z.array(ScreenSchema),
  requirements: z.array(RequirementSchema),
  deltas: z.array(DeltaSchema),
  questions: z.array(QuestionSchema),
  assumptions: z.array(AssumptionSchema),
  coverage: z.array(CoverageRowSchema),
  impact: ImpactSchema,
});

export type Evidence = z.infer<typeof EvidenceSchema>;
export type Screen = z.infer<typeof ScreenSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type Delta = z.infer<typeof DeltaSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type Assumption = z.infer<typeof AssumptionSchema>;
export type CoverageRow = z.infer<typeof CoverageRowSchema>;
export type Impact = z.infer<typeof ImpactSchema>;
export type AnalysisItems = z.infer<typeof AnalysisItemsSchema>;
export type DeltaKind = (typeof DELTA_KINDS)[number];
