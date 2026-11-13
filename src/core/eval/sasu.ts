/** 결함 주입 실행에서 사수 1회차만 돌리고, 심은 결함을 잡았는지 채점한다. */
import { existsSync, readFileSync } from "node:fs";
import { HewError, stateError, usageError } from "../errors.js";
import { ANALYSIS_WORK_CODES, splitWorkId, type StoredFinding, type WorkCode } from "../findings/schema.js";
import { readJsonFile, writeJsonAtomic } from "../fsx.js";
import { evalPaths, resolveRunDir, runPaths } from "../paths.js";
import { runLoop } from "../runner.js";
import { loadRun } from "../run.js";
import { loadPlan, readBatchFindings } from "../sasu/store.js";
import type { InjectionFile } from "./inject.js";

export interface EvalSasuOptions {
  /** 주입 실행 폴더 경로 또는 run_id. */
  run: string;
  /** 돌릴 작업 단위 종류. 생략하면 expected 의 종류다. */
  codes?: WorkCode[];
  maxSteps?: number;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface OtherIssue {
  work: string;
  kind: string | null;
  claim: string;
  blocking: boolean;
}

export interface EvalResult {
  expected: string;
  /** expected 단위에 차단 issue(근거가 묶음 본문과 맞는 issue)가 있는가. */
  caught: boolean;
  /** expected 단위에 근거 없는 issue 까지 포함해 issue 가 있는가. */
  caught_any: boolean;
  other_issues: { count: number; list: OtherIssue[] };
  /** 이번에 돌린 작업 단위 수. */
  units: number;
  cost_usd: number;
  duration_ms: number;
}

/** `W2,W3` 같은 쉼표 목록을 작업 단위 종류 목록으로 바꾼다. */
export function parseCodes(text: string): WorkCode[] {
  const codes = text.split(",").map((c) => c.trim()).filter((c) => c.length > 0);
  if (codes.length === 0) throw usageError("--codes 가 비어 있습니다");
  for (const c of codes) {
    if (!(ANALYSIS_WORK_CODES as readonly string[]).includes(c)) throw usageError(`--codes 는 ${ANALYSIS_WORK_CODES.join("|")} 중에서 쉼표로 이어야 합니다: ${c}`);
  }
  return [...new Set(codes)] as WorkCode[];
}

/** costs.jsonl 의 사수 실행 비용(USD)과 시간(밀리초) 합. 읽을 수 없는 칸은 0 으로 센다. */
function sumCosts(file: string): { cost_usd: number; duration_ms: number } {
  const out = { cost_usd: 0, duration_ms: 0 };
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const row = JSON.parse(line) as { role?: string; total_cost_usd?: unknown; duration_ms?: unknown };
    if (row.role !== "manager-sasu") continue;
    if (typeof row.total_cost_usd === "number") out.cost_usd += row.total_cost_usd;
    if (typeof row.duration_ms === "number") out.duration_ms += row.duration_ms;
  }
  return out;
}

/** 묶음별 지적으로 채점 결과를 만든다. */
export function scoreFindings(expected: string, findings: StoredFinding[], units: number, costs: { cost_usd: number; duration_ms: number }): EvalResult {
  const issues = findings.filter((f) => f.verdict === "issue");
  const mine = issues.filter((f) => f.work === expected);
  const others = issues.filter((f) => f.work !== expected);
  return {
    expected,
    caught: mine.some((f) => f.blocking),
    caught_any: mine.length > 0,
    other_issues: {
      count: others.length,
      list: others.map((f) => ({ work: f.work, kind: f.kind ?? null, claim: f.claim ?? "", blocking: f.blocking })),
    },
    units,
    ...costs,
  };
}

/** 주입 실행에서 사수 1회차만 돌리고 eval/findings.json 과 eval/result.json 을 쓴다. 회차 완료 처리는 하지 않는다. */
export async function runEvalSasu(opts: EvalSasuOptions): Promise<EvalResult> {
  const runDir = resolveRunDir(opts.run);
  const run = loadRun(runDir);
  const paths = evalPaths(runDir);
  if (run.eval === undefined || !existsSync(paths.injection)) throw usageError(`결함 주입 실행이 아닙니다(run.eval 또는 eval/injection.json 이 없음): ${runDir}`);
  if (run.state !== "qa_designed") throw stateError(`상태 ${run.state} 에서는 평가용 사수를 돌릴 수 없습니다. qa_designed 여야 합니다`);
  const injection = readJsonFile(paths.injection) as InjectionFile;
  const expectedCode = splitWorkId(injection.expected)?.code;
  const codes = opts.codes ?? (expectedCode === undefined ? undefined : [expectedCode]);
  if (codes === undefined) throw new HewError("internal", `expected 를 읽을 수 없습니다: ${injection.expected}`);

  const outcome = await runLoop({ runDir, env: opts.env, maxSteps: opts.maxSteps, timeoutMs: opts.timeoutMs, sasuCodes: codes });
  if (outcome.outcome === "role_missing") throw stateError(outcome.message);
  if (outcome.outcome === "max_steps") throw stateError(`${outcome.message}. 같은 명령을 다시 부르면 남은 묶음만 이어서 돌립니다`);

  const plan = loadPlan(runDir, 1);
  if (plan === null) throw new HewError("internal", "사수 계획이 만들어지지 않았습니다");
  const findings = plan.batches.flatMap((b) => readBatchFindings(runDir, plan.round, b.k, plan.for));
  writeJsonAtomic(paths.findings, { round: plan.round, codes, findings });
  const result = scoreFindings(injection.expected, findings, plan.units.length, sumCosts(runPaths(runDir).costs));
  writeJsonAtomic(paths.result, result);
  return result;
}
