/** revision(§2.4) 계산: 승인 대상 정본의 정규화한 내용을 해시한다. */
import { existsSync } from "node:fs";
import { hashJson } from "./hash.js";
import { readJsonFile } from "./fsx.js";
import { runPaths } from "./paths.js";

export const NO_REVISION = "none";

const DROPPED_KEYS = new Set(["cost", "cost_usd", "total_cost_usd", "duration_ms", "session_id", "ts", "at"]);

const isDroppedKey = (key: string): boolean => DROPPED_KEYS.has(key) || key.endsWith("_at");

const isEmpty = (value: unknown): boolean => {
  if (value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
};

/** 비용·시각·세션 id 키와 빈 값(null, 빈 문자열, 빈 배열, 빈 객체)을 뺀 사본을 만든다. */
export function normalizeForRevision(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForRevision);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isDroppedKey(key)) continue;
      const cleaned = normalizeForRevision(child);
      if (isEmpty(cleaned)) continue;
      out[key] = cleaned;
    }
    return out;
  }
  return value;
}

/** 승인 기록은 revision 을 잠그는 것이라, 계정 메모는 승인 대상이 아니라 revision 계산에서 뺀다. */
function withoutApprovals(answers: unknown): unknown {
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) return answers;
  const { approvals: _approvals, accounts: _accounts, ...rest } = answers as Record<string, unknown>;
  return rest;
}

const itemsOf = (envelope: unknown): unknown =>
  envelope !== null && typeof envelope === "object" ? (envelope as Record<string, unknown>).items : undefined;

/** 실행 폴더에 있는 정본으로 revision 을 계산한다. 아무 파일도 없으면 "none". */
export function computeRevision(runDir: string): string {
  const p = runPaths(runDir);
  const parts: Record<string, unknown> = {};
  const itemsFiles: [string, string][] = [
    ["analysis", p.analysis],
    ["scenarios", p.scenarios],
    ["plan", p.plan],
  ];
  for (const [name, file] of itemsFiles) {
    if (existsSync(file)) parts[name] = itemsOf(readJsonFile(file));
  }
  if (existsSync(p.answers)) parts.answers = withoutApprovals(readJsonFile(p.answers));
  if (existsSync(p.manifest)) parts.manifest = readJsonFile(p.manifest);
  if (Object.keys(parts).length === 0) return NO_REVISION;
  return hashJson(normalizeForRevision(parts));
}
