/** 스키마 검증 전 손질: 사람의 칸 값을 버리고(human_field_ignored), 스키마에 없는 키를 떨어뜨린다(unknown_field_dropped). */
import { z } from "zod";
import type { Issue } from "../errors.js";
import { AnalysisItemsSchema } from "./schema.js";

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** 묶음 이름, 그 안의 사람의 칸. */
export type HumanFields = readonly (readonly [string, string])[];

const HUMAN_FIELDS: HumanFields = [
  ["deltas", "decision"],
  ["questions", "answer"],
  ["assumptions", "status"],
];

/** 에이전트가 채운 사람의 칸을 지운 사본과 경고를 돌려준다. */
export function dropHumanFields(raw: unknown, fields: HumanFields = HUMAN_FIELDS): { raw: unknown; issues: Issue[] } {
  if (!isRecord(raw)) return { raw, issues: [] };
  const issues: Issue[] = [];
  const out: Record<string, unknown> = { ...raw };
  for (const [group, field] of fields) {
    const list = raw[group];
    if (!Array.isArray(list)) continue;
    out[group] = list.map((item, index) => {
      if (!isRecord(item) || !(field in item)) return item;
      const { [field]: _dropped, ...rest } = item;
      const ref = typeof item.id === "string" ? item.id : `${group}[${index}]`;
      issues.push({
        code: "human_field_ignored",
        severity: "warn",
        ref,
        message: `${ref} 의 '${field}' 는 사람이 채우는 칸이라 제출한 값을 버렸습니다`,
      });
      return rest;
    });
  }
  return { raw: out, issues };
}

function unwrap(schema: z.ZodTypeAny, value: unknown): z.ZodTypeAny | null {
  let cur: z.ZodTypeAny = schema;
  for (;;) {
    if (cur instanceof z.ZodOptional || cur instanceof z.ZodNullable) cur = cur.unwrap();
    else if (cur instanceof z.ZodDefault) cur = cur.removeDefault();
    else if (cur instanceof z.ZodEffects) cur = cur.innerType();
    else if (cur instanceof z.ZodUnion) {
      const options = cur.options as z.ZodTypeAny[];
      const hit = options.find((option) => option.safeParse(value).success);
      if (hit === undefined) return null;
      cur = hit;
    } else return cur;
  }
}

interface Walk {
  dropped: Issue[];
}

function strip(schema: z.ZodTypeAny, value: unknown, path: string, owner: string | null, walk: Walk): unknown {
  const inner = unwrap(schema, value);
  if (inner === null) return value;
  if (inner instanceof z.ZodArray && Array.isArray(value)) {
    return value.map((child, index) => strip(inner.element, child, `${path}[${index}]`, owner, walk));
  }
  if (inner instanceof z.ZodRecord && isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = strip(inner.valueSchema, child, `${path}.${key}`, owner, walk);
    return out;
  }
  if (inner instanceof z.ZodObject && isRecord(value)) {
    const shape = inner.shape as Record<string, z.ZodTypeAny>;
    const here = typeof value.id === "string" ? value.id : owner;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childSchema = shape[key];
      if (childSchema === undefined) {
        walk.dropped.push({
          code: "unknown_field_dropped",
          severity: "warn",
          ref: here,
          message: `${path === "" ? "items" : path} 에 명세에 없는 칸 '${key}' 가 있어 버렸습니다`,
        });
        continue;
      }
      out[key] = strip(childSchema, child, path === "" ? key : `${path}.${key}`, here, walk);
    }
    return out;
  }
  return value;
}

/** 스키마에 없는 키를 떨어뜨린 사본과 경고를 돌려준다. */
export function dropUnknownFields(raw: unknown, schema: z.ZodTypeAny = AnalysisItemsSchema): { raw: unknown; issues: Issue[] } {
  const walk: Walk = { dropped: [] };
  const cleaned = strip(schema, raw, "", null, walk);
  return { raw: cleaned, issues: walk.dropped };
}

/** 제출 원문 손질 전체: 사람의 칸 → 알 수 없는 키 순. */
export function sanitizeItems(raw: unknown, schema: z.ZodTypeAny, fields: HumanFields): { raw: unknown; issues: Issue[] } {
  const human = dropHumanFields(raw, fields);
  const unknown = dropUnknownFields(human.raw, schema);
  return { raw: unknown.raw, issues: [...human.issues, ...unknown.issues] };
}

/** analysis 제출 원문 손질. */
export function sanitizeAnalysis(raw: unknown): { raw: unknown; issues: Issue[] } {
  return sanitizeItems(raw, AnalysisItemsSchema, HUMAN_FIELDS);
}
