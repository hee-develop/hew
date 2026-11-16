/** 같은 종류·같은 문장의 지적을 하나로 묶는다. */
import { normalizeText } from "../analysis/checks.js";

/** 입력 순서를 지켜, kind 가 같고 claim 의 공백·강조 표시를 지운 문자열이 같은 지적끼리 묶는다. */
export function groupDuplicateFindings<T extends { kind?: string; claim?: string }>(findings: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const f of findings) {
    const key = `${f.kind ?? ""}\u0000${normalizeText(f.claim ?? "")}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [f]);
    else group.push(f);
  }
  return [...groups.values()];
}
