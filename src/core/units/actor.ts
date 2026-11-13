/** 표 머리글에서 주체 열을 찾고 칸 내용에서 주체(운영자·판매자·구매자)를 판정한다. */
import type { Actor } from "./types.js";

const ACTOR_HEADERS = ["user journey", "주체", "actor", "사용자"];

const ACTOR_PATTERNS: [Actor, RegExp][] = [
  ["operator", /운영자|관리자|어드민|admin/i],
  ["provider", /판매자/],
  ["customer", /구매자/],
];

/** 머리글 이름에서 마크다운 강조 기호를 빼고 소문자로 맞춘다. */
export const normalizeHeader = (header: string): string => header.replace(/\*\*|__/g, "").trim().toLowerCase();

/** 주체 열의 위치. 없으면 -1. */
export function findActorColumn(headers: string[]): number {
  return headers.findIndex((h) => {
    const normalized = normalizeHeader(h);
    return ACTOR_HEADERS.some((key) => normalized.includes(key));
  });
}

/** 칸 내용에서 가장 먼저 나오는 주체를 돌려준다. 어느 주체도 나오지 않으면 undefined. */
export function judgeActor(cell: string): Actor | undefined {
  let best: { actor: Actor; index: number } | undefined;
  for (const [actor, re] of ACTOR_PATTERNS) {
    const index = cell.search(re);
    if (index >= 0 && (best === undefined || index < best.index)) best = { actor, index };
  }
  return best?.actor;
}
