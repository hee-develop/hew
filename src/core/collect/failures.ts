/** 수집 실패 기록(sources/failures.jsonl). */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { runPaths } from "../paths.js";

export interface FailureRecord {
  at: string;
  item: string;
  reason: string;
}

/** 이 횟수 이상 실패한 항목은 계획에서 뺀다. */
export const MAX_FAILURES = 2;

/** 실패 기록을 읽는다. */
export function readFailures(runDir: string): FailureRecord[] {
  const file = runPaths(runDir).failures;
  if (!existsSync(file)) return [];
  const out: FailureRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const rec = JSON.parse(line) as Partial<FailureRecord>;
      if (typeof rec.item === "string") out.push({ at: typeof rec.at === "string" ? rec.at : "", item: rec.item, reason: typeof rec.reason === "string" ? rec.reason : "" });
    } catch {
      // 깨진 줄은 건너뛴다
    }
  }
  return out;
}

/** 실패 한 줄을 덧붙인다. */
export function appendFailure(runDir: string, item: string, reason: string, now: Date): FailureRecord {
  const file = runPaths(runDir).failures;
  const record: FailureRecord = { at: now.toISOString(), item, reason };
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}
