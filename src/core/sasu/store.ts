/** 사수 회차·계획·묶음 제출 상태를 읽는 공용 함수. 대상(analysis·plan)을 생략하면 분석용이다. */
import { existsSync } from "node:fs";
import { readJsonFile } from "../fsx.js";
import { StoredFindingSchema, type StoredFinding } from "../findings/schema.js";
import { findingsBatchPath, findingsPath, runPaths, sasuPlanPath, sasuResponsesPath, sasuWorkDir } from "../paths.js";
import type { Run } from "../run.js";
import { ResponsesFileSchema, SasuPlanSchema, type Response, type SasuPlan, type SasuTarget } from "./types.js";

/** 이 실행에서 그 대상의 사수가 지금 몇 번째로 도는지(1부터). */
export const currentRound = (run: Run, target: SasuTarget = "analysis"): number =>
  ((target === "analysis" ? run.submissions.findings_analysis : run.submissions.findings_plan)?.attempt ?? 0) + 1;

/** 묶음 파일(에이전트가 읽는 입력)의 경로. */
export const batchFilePath = (runDir: string, round: number, k: number, target: SasuTarget = "analysis"): string =>
  `${sasuWorkDir(runPaths(runDir), target, round)}/batch-${k}.json`;

/** 계획 파일을 읽는다. 없으면 null. */
export function loadPlan(runDir: string, round: number, target: SasuTarget = "analysis"): SasuPlan | null {
  const file = sasuPlanPath(runPaths(runDir), target, round);
  if (!existsSync(file)) return null;
  return SasuPlanSchema.parse(readJsonFile(file));
}

/** 묶음이 이미 제출되어 정본이 있는가. */
export const isBatchSubmitted = (runDir: string, round: number, k: number, target: SasuTarget = "analysis"): boolean =>
  existsSync(findingsBatchPath(runPaths(runDir), target, round, k));

/** 계획에서 아직 제출되지 않은 묶음을 순서대로 돌려준다. */
export function pendingBatches(runDir: string, plan: SasuPlan): SasuPlan["batches"] {
  return plan.batches.filter((b) => !isBatchSubmitted(runDir, plan.round, b.k, plan.for));
}

/** 묶음 정본 하나의 지적 목록. 파일이 없으면 빈 목록. */
export function readBatchFindings(runDir: string, round: number, k: number, target: SasuTarget = "analysis"): StoredFinding[] {
  const file = findingsBatchPath(runPaths(runDir), target, round, k);
  return existsSync(file) ? parseStored(readJsonFile(file)) : [];
}

/** 회차를 합쳐 쓴 지적 정본(doc/findings/<대상>-<회차>.json)의 지적 목록. 파일이 없으면 빈 목록. */
export function readRoundFindings(runDir: string, round: number, target: SasuTarget = "analysis"): StoredFinding[] {
  const file = findingsPath(runPaths(runDir), target, round);
  return existsSync(file) ? parseStored(readJsonFile(file)) : [];
}

/** 그 회차의 지적에 낸 답변 목록. 파일이 없거나 읽을 수 없으면 빈 목록. */
export function readResponses(runDir: string, round: number, target: SasuTarget = "analysis"): Response[] {
  const file = sasuResponsesPath(runPaths(runDir), target, round);
  if (!existsSync(file)) return [];
  const parsed = ResponsesFileSchema.safeParse(readJsonFile(file));
  return parsed.success ? parsed.data.responses : [];
}

function parseStored(doc: unknown): StoredFinding[] {
  const list = (doc as { items?: { findings?: unknown[] } } | null)?.items?.findings ?? [];
  return list.flatMap((raw) => {
    const parsed = StoredFindingSchema.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
}
