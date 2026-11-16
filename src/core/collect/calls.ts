/** 수집 세션이 받아 적은 도구 결과(work/collector-<n>/calls)를 읽는다. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { usageError } from "../errors.js";
import { runPaths } from "../paths.js";

export interface CallRecord {
  n: number;
  tool: string | null;
  input: unknown;
  tool_use_id: string | null;
  bytes: number;
  sha256: string;
  from_file: boolean;
  at: string;
  error?: string;
}

export interface CallsDir {
  /** 수집 작업 폴더(work/collector-<n>). */
  workDir: string;
  callsDir: string;
  calls: CallRecord[];
}

/** 가장 최근 수집 작업 폴더(번호가 가장 큰 work/collector-<n>). 없으면 null. */
export function latestCollectorWorkDir(runDir: string): string | null {
  const work = runPaths(runDir).work;
  if (!existsSync(work)) return null;
  let best = 0;
  for (const name of readdirSync(work)) {
    const m = /^collector-(\d+)$/.exec(name);
    if (m?.[1] !== undefined) best = Math.max(best, Number(m[1]));
  }
  return best === 0 ? null : join(work, `collector-${best}`);
}

/** index.jsonl 의 호출 기록을 읽는다. 읽을 수 없는 줄은 건너뛴다. */
export function readCallIndex(callsDir: string): CallRecord[] {
  const file = join(callsDir, "index.jsonl");
  if (!existsSync(file)) return [];
  const out: CallRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const rec = JSON.parse(line) as Partial<CallRecord>;
      if (typeof rec.n === "number" && typeof rec.sha256 === "string") {
        out.push({
          n: rec.n,
          tool: typeof rec.tool === "string" ? rec.tool : null,
          input: rec.input ?? null,
          tool_use_id: typeof rec.tool_use_id === "string" ? rec.tool_use_id : null,
          bytes: typeof rec.bytes === "number" ? rec.bytes : 0,
          sha256: rec.sha256,
          from_file: rec.from_file === true,
          at: typeof rec.at === "string" ? rec.at : "",
          ...(typeof rec.error === "string" ? { error: rec.error } : {}),
        });
      }
    } catch {
      // 깨진 줄은 건너뛴다
    }
  }
  return out.sort((a, b) => a.n - b.n);
}

/** 가장 최근 수집 작업 폴더의 호출 기록. 수집 작업 폴더가 없으면 사용법 오류. */
export function loadCalls(runDir: string): CallsDir {
  const workDir = latestCollectorWorkDir(runDir);
  if (workDir === null) throw usageError("수집 작업 폴더(work/collector-<n>)가 없습니다. 받아 적은 도구 결과가 없습니다");
  const callsDir = join(workDir, "calls");
  return { workDir, callsDir, calls: readCallIndex(callsDir) };
}

/** 호출 번호의 payload 파일 경로. */
export const payloadFile = (callsDir: string, n: number): string => join(callsDir, `${String(n).padStart(3, "0")}.payload`);
