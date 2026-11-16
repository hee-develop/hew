/** 차이 종류별 허용 결정 표(§4.4)와 판별 함수. 순수 함수만 둔다. */
import type { DeltaKind } from "./schema.js";

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
