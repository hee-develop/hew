/** plan 본문(§7.1)의 zod 스키마. 형식·열거만 막고, 있어야 하는 칸의 유무는 결정적 검사가 판정한다. */
import { z } from "zod";

export const EXCLUDED_KINDS = ["delta", "requirement", "change"] as const;

const strings = z.array(z.string()).default([]);

export const TrackerEventSchema = z.object({
  name: z.string(),
  when: z.string(),
  properties: strings,
});

export const TicketBodySchema = z.object({
  background: z.string().default(""),
  work: strings,
  checks: strings,
  depends_note: z.string().optional(),
  refs: strings,
  tracker_events: z.array(TrackerEventSchema).default([]),
});

/** 요구의 일부 변경만 맡을 때 그 변경 항목. index 는 요구 changes 배열의 0부터 위치다. */
export const TicketChangeSchema = z.object({
  requirement_id: z.string(),
  index: z.number().int().min(0),
});

export const TicketSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: TicketBodySchema,
  requirement_ids: strings,
  changes: z.array(TicketChangeSchema).default([]),
  sp: z.number(),
  depends_on: strings,
  pr: z.string(),
});

export const PrSchema = z.object({
  id: z.string(),
  title: z.string(),
  ticket_ids: strings,
  base: z.string(),
  order: z.number(),
});

export const FeatureFlagSchema = z.object({
  used: z.boolean(),
  name: z.string().optional(),
  removal_ticket: z.string().optional(),
});

export const ExcludedSchema = z.object({
  kind: z.enum(EXCLUDED_KINDS),
  ref: z.string(),
  reason: z.string(),
});

export const PlanItemsSchema = z.object({
  epic_name: z.string(),
  parent: z.string().optional(),
  tickets: z.array(TicketSchema),
  prs: z.array(PrSchema),
  feature_flag: FeatureFlagSchema.optional(),
  excluded: z.array(ExcludedSchema).default([]),
});

export type TrackerEvent = z.infer<typeof TrackerEventSchema>;
export type TicketBody = z.infer<typeof TicketBodySchema>;
export type Ticket = z.infer<typeof TicketSchema>;
export type Pr = z.infer<typeof PrSchema>;
export type FeatureFlag = z.infer<typeof FeatureFlagSchema>;
export type Excluded = z.infer<typeof ExcludedSchema>;
export type PlanItems = z.infer<typeof PlanItemsSchema>;
