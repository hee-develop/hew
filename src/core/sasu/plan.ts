/** 사수 계획: 작업 단위를 묶음으로 나누고, 직전 회차에서 바뀌지 않은 단위의 판정을 가져온다. */
import { stateError, usageError } from "../errors.js";
import { appendEvent } from "../events.js";
import type { StoredFinding, WorkCode } from "../findings/schema.js";
import { writeJsonAtomic } from "../fsx.js";
import { nextAction } from "../next.js";
import { runPaths, sasuPlanPath } from "../paths.js";
import { loadRun, type Run } from "../run.js";
import { batchFilePath, currentRound, loadPlan, readRoundFindings } from "./store.js";
import { completeRound, type CompleteResult } from "./complete.js";
import { CODE_QUESTIONS, buildWorkUnits, type WorkUnit } from "./units.js";
import {
  BATCH_CHAR_LIMIT,
  BATCH_IMAGE_UNIT_LIMIT,
  BATCH_UNIT_LIMIT,
  type BatchFile,
  type PlanBatch,
  type PlanUnit,
  type SasuPlan,
} from "./types.js";

/** 같은 코드끼리, 단위 수와 inputs 글자 수 상한을 지켜 순서대로 묶는다. */
export function splitBatches(units: Pick<WorkUnit, "id" | "code" | "inputs">[]): { code: WorkCode; unit_ids: string[] }[] {
  const out: { code: WorkCode; unit_ids: string[]; chars: number }[] = [];
  for (const unit of units) {
    const size = JSON.stringify(unit.inputs).length;
    const limit = unit.code === "W7" ? BATCH_IMAGE_UNIT_LIMIT : BATCH_UNIT_LIMIT;
    const last = out[out.length - 1];
    if (last !== undefined && last.code === unit.code && last.unit_ids.length < limit && last.chars + size <= BATCH_CHAR_LIMIT) {
      last.unit_ids.push(unit.id);
      last.chars += size;
    } else {
      out.push({ code: unit.code, unit_ids: [unit.id], chars: size });
    }
  }
  return out.map(({ code, unit_ids }) => ({ code, unit_ids }));
}

/** 직전 회차에서 hash 가 같고 판정이 ok 였던 단위의 판정(재사용 대상)을 id 로 모은다. */
function reusableVerdicts(runDir: string, round: number): Map<string, { hash: string; finding: StoredFinding }> {
  const out = new Map<string, { hash: string; finding: StoredFinding }>();
  if (round < 2) return out;
  const previous = loadPlan(runDir, round - 1);
  if (previous === null) return out;
  const stored = readRoundFindings(runDir, round - 1);
  for (const unit of previous.units) {
    const finding = stored.find((f) => f.work === unit.id);
    if (finding !== undefined && finding.verdict === "ok") out.set(unit.id, { hash: unit.hash, finding });
  }
  return out;
}

export interface PlanResult {
  plan: SasuPlan;
  created: boolean;
  /** 다시 돌릴 단위가 0개라 계획 직후 회차를 완료 처리했으면 그 결과. */
  completed: CompleteResult | null;
}

/** 사수가 지금 돌 차례인가(분석용). 아니면 종료 4. */
function assertSasuTurn(run: Run): void {
  const next = nextAction(run.state, { rework: run.rework, progress: run.progress });
  if (next.action !== "sasu" || next.for !== "analysis") {
    throw stateError(`상태 ${run.state} 에서는 분석용 사수 계획을 만들 수 없습니다`);
  }
}

/** 이 회차의 계획과 묶음 파일을 만든다. 이미 있으면 그대로 돌려주고, 묶음이 0개면 곧바로 회차를 완료 처리한다. */
export function createPlan(runDir: string, target: "analysis" | "plan", now: Date = new Date(), producedBy: Parameters<typeof completeRound>[3] = null): PlanResult {
  if (target !== "analysis") throw usageError("분해안(plan) 사수는 아직 지원하지 않습니다");
  const run = loadRun(runDir);
  assertSasuTurn(run);
  const round = currentRound(run);
  const existing = loadPlan(runDir, round);
  if (existing !== null) return { plan: existing, created: false, completed: null };

  const units = buildWorkUnits(runDir);
  const reusable = reusableVerdicts(runDir, round);
  const reused = new Set(units.filter((u) => reusable.get(u.id)?.hash === u.hash).map((u) => u.id));
  const todo = units.filter((u) => !reused.has(u.id));
  const batches: PlanBatch[] = splitBatches(todo).map((b, index) => ({
    k: index + 1,
    code: b.code,
    unit_ids: b.unit_ids,
    path: batchFilePath(runDir, round, index + 1),
  }));
  const batchOf = new Map(batches.flatMap((b) => b.unit_ids.map((id) => [id, b.k] as const)));
  const planUnits: PlanUnit[] = units.map((u) => ({
    id: u.id,
    code: u.code,
    target: u.target,
    hash: u.hash,
    batch: batchOf.get(u.id) ?? null,
    ...(reused.has(u.id) ? { reuse: true } : {}),
  }));
  const plan: SasuPlan = { for: "analysis", round, units: planUnits, batches };

  const byId = new Map(units.map((u) => [u.id, u]));
  for (const batch of batches) {
    const file: BatchFile = {
      for: "analysis",
      round,
      batch: batch.k,
      code: batch.code,
      question: CODE_QUESTIONS[batch.code],
      units: batch.unit_ids.map((id) => {
        const u = byId.get(id) as WorkUnit;
        return { id: u.id, target: u.target, inputs: u.inputs };
      }),
    };
    writeJsonAtomic(batch.path, file);
  }
  const planFile = sasuPlanPath(runPaths(runDir), "analysis", round);
  writeJsonAtomic(planFile, plan);
  appendEvent(runPaths(runDir).events, "sasu_planned", {
    for: "analysis",
    round,
    units: units.length,
    reused: reused.size,
    batches: batches.length,
    path: planFile,
  }, now);
  const completed = batches.length === 0 ? completeRound(runDir, plan, now, producedBy) : null;
  return { plan, created: true, completed };
}
