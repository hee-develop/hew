/** 사수 테스트 공용: qa_designed 상태 실행, 묶음별 지적 파일 만들기, 반송 한 바퀴 도우미. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "../src/core/analysis/index.js";
import "../src/core/scenarios/index.js";
import { submitFindingsBatch, type SubmitBatchResult } from "../src/core/findings/submit.js";
import type { Finding } from "../src/core/findings/schema.js";
import { runPaths } from "../src/core/paths.js";
import { loadRun } from "../src/core/run.js";
import { createPlan } from "../src/core/sasu/plan.js";
import { currentRound, loadPlan } from "../src/core/sasu/store.js";
import type { BatchFile, SasuPlan } from "../src/core/sasu/types.js";
import { submitArtifact } from "../src/core/submit.js";
import type { Unit } from "../src/core/units/types.js";
import { buildAnalysis, buildUnits, clone, setupRun, type Doc } from "./analysis-fixtures.js";
import { writeItemsFile } from "./helpers.js";
import { buildScenarios } from "./scenarios-fixtures.js";

export interface QaDesignedOptions {
  analysis?: (doc: Doc) => void;
  units?: Unit[];
}

/** 분석·시나리오가 통과해 qa_designed 가 된 실행을 만든다. */
export function setupQaDesigned(opts: QaDesignedOptions = {}): { dir: string } {
  const { dir } = setupRun({ units: opts.units ?? buildUnits() });
  const analysis = buildAnalysis();
  opts.analysis?.(analysis);
  submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "analysis-in.json", analysis) });
  submitArtifact({ runDir: dir, kind: "scenarios", file: writeItemsFile(dir, "scenarios-in.json", buildScenarios()) });
  return { dir };
}

export const readBatch = (path: string): BatchFile => JSON.parse(readFileSync(path, "utf8")) as BatchFile;

/** 현재 회차의 계획을 만들어(없으면) 돌려준다. */
export function planNow(dir: string): SasuPlan {
  return createPlan(dir, "analysis").plan;
}

export type Overrides = Record<string, Partial<Finding>>;

/** 묶음 k 의 모든 단위에 ok 를 내고, overrides 에 든 단위는 그 값으로 바꾼 지적 파일을 쓰고 경로를 돌려준다. */
export function writeFindingsFile(dir: string, plan: SasuPlan, k: number, overrides: Overrides = {}): string {
  const batch = readBatch(plan.batches.find((b) => b.k === k)?.path ?? "");
  const findings: Finding[] = batch.units.map((u, i) => ({ id: `F-${i + 1}`, work: u.id, verdict: "ok", ...overrides[u.id] }) as Finding);
  return writeItemsFile(dir, `findings-r${plan.round}-b${k}.json`, { findings });
}

export function submitBatch(dir: string, plan: SasuPlan, k: number, overrides: Overrides = {}): SubmitBatchResult {
  return submitFindingsBatch({ runDir: dir, batch: k, file: writeFindingsFile(dir, plan, k, overrides) });
}

/** 모든 묶음을 낸다. overrides 는 모든 묶음에 걸쳐 단위 id 로 찾는다. 마지막 결과를 돌려준다. */
export function submitAll(dir: string, plan: SasuPlan, overrides: Overrides = {}): SubmitBatchResult {
  let last: SubmitBatchResult | null = null;
  for (const b of plan.batches) last = submitBatch(dir, plan, b.k, overrides);
  if (last === null) throw new Error("묶음이 없습니다");
  return last;
}

/** 작업 단위 id 로 그 단위가 든 묶음 번호를 찾는다. */
export const batchOf = (plan: SasuPlan, workId: string): number => plan.units.find((u) => u.id === workId)?.batch ?? 0;

export const roundOf = (dir: string): number => currentRound(loadRun(dir));
export const findingsRound = (dir: string, round: number): Record<string, any>[] =>
  (JSON.parse(readFileSync(join(runPaths(dir).findingsDir, `analysis-${round}.json`), "utf8")) as { items: { findings: Record<string, any>[] } }).items.findings;
export { clone, loadPlan };
