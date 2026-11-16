/** 표 머리글에서 주체 열을 찾고 칸 내용에서 주체(운영자·제공자·이용자, 낱말은 프로필의 actors)를 판정한다. */
import { loadProfile, type Profile } from "../profile.js";
import type { Actor } from "./types.js";

const ACTOR_HEADERS = ["user journey", "주체", "actor", "사용자"];

const ACTOR_ORDER: Actor[] = ["operator", "provider", "customer"];

const compiled = new WeakMap<Profile, [Actor, RegExp][]>();

/** 프로필의 주체 낱말로 정규식을 만든다(대소문자 무시). 프로필마다 한 번만 만든다. */
function actorPatterns(): [Actor, RegExp][] {
  const profile = loadProfile();
  let patterns = compiled.get(profile);
  if (patterns === undefined) {
    patterns = ACTOR_ORDER.map((actor): [Actor, RegExp] => [actor, new RegExp(profile.actors[actor].join("|"), "i")]);
    compiled.set(profile, patterns);
  }
  return patterns;
}

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
  for (const [actor, re] of actorPatterns()) {
    const index = cell.search(re);
    if (index >= 0 && (best === undefined || index < best.index)) best = { actor, index };
  }
  return best?.actor;
}
