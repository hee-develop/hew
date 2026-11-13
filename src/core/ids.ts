/** 산출물 id 형식(§2.2)의 정규식과 판별 함수. */
const N = "[1-9][0-9]*";

export const ID_PATTERNS = {
  screen: new RegExp(`^화면-${N}$`),
  variant: new RegExp(`^화면-${N}\\.${N}$`),
  requirement: new RegExp(`^요구-${N}$`),
  ac: new RegExp(`^요구-${N}/AC-${N}$`),
  question: new RegExp(`^Q-${N}$`),
  delta: new RegExp(`^D-${N}$`),
  assumption: new RegExp(`^A-${N}$`),
  source: new RegExp(`^S-${N}$`),
  unit: new RegExp(`^U-${N}$`),
  coverage: new RegExp(`^C-${N}$`),
  impact: new RegExp(`^I-${N}$`),
  blocker: new RegExp(`^B-${N}$`),
  scenario: new RegExp(`^시나리오-${N}$`),
  expectation: new RegExp(`^시나리오-${N}/E-${N}$`),
  ticket: new RegExp(`^T${N}$`),
  pr: new RegExp(`^PR-${N}$`),
  finding: new RegExp(`^F-${N}$`),
} as const;

export type IdKind = keyof typeof ID_PATTERNS;

export const ID_KINDS = Object.keys(ID_PATTERNS) as IdKind[];

export function isId(kind: IdKind, value: unknown): value is string {
  return typeof value === "string" && ID_PATTERNS[kind].test(value);
}

/** 값이 어느 형식에 맞는지 돌려준다. 맞는 형식이 없으면 null. */
export function idKindOf(value: unknown): IdKind | null {
  if (typeof value !== "string") return null;
  return ID_KINDS.find((kind) => ID_PATTERNS[kind].test(value)) ?? null;
}
