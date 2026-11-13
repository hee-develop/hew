/** 결함 주입 종류(§11.5)와 종류별 expected 작업 단위 코드. */
export const EVAL_KINDS = ["w3_delete", "w2_alter", "w4_confirm", "w5_ainote", "w7_drop_visual", "w8_pair"] as const;
export type EvalKind = (typeof EVAL_KINDS)[number];

/** 종류마다 잡아야 하는 작업 단위의 코드. */
export const CODE_BY_KIND: Record<EvalKind, "W2" | "W3" | "W4" | "W5" | "W7" | "W8"> = {
  w3_delete: "W3",
  w2_alter: "W2",
  w4_confirm: "W4",
  w5_ainote: "W5",
  w7_drop_visual: "W7",
  w8_pair: "W8",
};

export const isEvalKind = (value: string): value is EvalKind => (EVAL_KINDS as readonly string[]).includes(value);
