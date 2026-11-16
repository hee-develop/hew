/** 차이 종류별 허용 결정 표(§4.4)와 판별 함수. 순수 함수만 둔다. */
import type { Delta, DeltaKind } from "./schema.js";

export const DELTA_DECISION_VALUES = ["follow_figma", "follow_prd", "drop", "hold"] as const;
export type DeltaDecisionValue = (typeof DELTA_DECISION_VALUES)[number];

export interface DecisionChoice {
  value: DeltaDecisionValue;
  label: string;
}

/** 종류별로 고를 수 있는 결정. */
export const DELTA_CHOICES: Readonly<Record<DeltaKind, readonly DecisionChoice[]>> = {
  figma_only: [
    { value: "follow_figma", label: "시안대로 구현" },
    { value: "drop", label: "구현 안 함" },
    { value: "hold", label: "보류" },
  ],
  prd_only: [
    { value: "follow_prd", label: "PRD대로 구현" },
    { value: "drop", label: "구현 안 함" },
    { value: "hold", label: "보류" },
  ],
  mismatch: [
    { value: "follow_figma", label: "시안을 따름" },
    { value: "follow_prd", label: "PRD 를 따름" },
    { value: "drop", label: "둘 다 구현 안 함" },
    { value: "hold", label: "보류" },
  ],
};

/** 이 종류의 차이에 이 결정 값을 내려도 되는가. */
export function isDecisionAllowed(kind: DeltaKind, decision: string): boolean {
  return DELTA_CHOICES[kind].some((choice) => choice.value === decision);
}

const squash = (text: string | undefined): string => (text ?? "").replace(/\s+/g, "");

/** 비교 행의 (PRD, 시안) 값 쌍을 공백을 뺀 문자열 집합으로 만든다. 둘 다 빈 행은 뺀다. */
function comparisonPairs(delta: Delta): Set<string> {
  const out = new Set<string>();
  for (const row of delta.comparison?.rows ?? []) {
    const prd = squash(row.prd);
    const figma = squash(row.figma);
    if (prd === "" && figma === "") continue;
    out.add(`${prd}\u0000${figma}`);
  }
  return out;
}

const isSubset = (a: Set<string>, b: Set<string>): boolean => [...a].every((x) => b.has(x));

/** 사람이 같은 결정을 내릴 것으로 보이는 두 차이인가: 종류가 같고 비교 값 쌍이 같거나 한쪽이 다른 쪽에 포함되며, 추천 결정이 서로 다르지 않다. */
export function looksSameDecision(a: Delta, b: Delta): boolean {
  if (a.id === b.id || a.kind !== b.kind) return false;
  const ra = a.recommendation?.decision;
  const rb = b.recommendation?.decision;
  if (ra !== undefined && rb !== undefined && ra !== rb) return false;
  const pa = comparisonPairs(a);
  const pb = comparisonPairs(b);
  if (pa.size === 0 || pb.size === 0) return false;
  return isSubset(pa, pb) || isSubset(pb, pa);
}

/** 같은 결정으로 묶을 수 있어 보이는 차이 쌍을 문서 순서대로 모은다(앞, 뒤). */
export function sameDecisionPairs(deltas: readonly Delta[]): [Delta, Delta][] {
  const out: [Delta, Delta][] = [];
  for (let j = 1; j < deltas.length; j += 1) {
    for (let i = 0; i < j; i += 1) {
      const a = deltas[i];
      const b = deltas[j];
      if (a !== undefined && b !== undefined && looksSameDecision(a, b)) out.push([a, b]);
    }
  }
  return out;
}

/** 차이 id 마다, 같은 결정으로 묶을 수 있어 보이는 다른 차이의 id 목록. */
export function similarDeltaIds(deltas: readonly Delta[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [a, b] of sameDecisionPairs(deltas)) {
    out.set(a.id, [...(out.get(a.id) ?? []), b.id]);
    out.set(b.id, [...(out.get(b.id) ?? []), a.id]);
  }
  return out;
}
