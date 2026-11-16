/** 결함 주입(§11.5): 통과한 정본을 새 실행 폴더로 복사하고 분석 문서에 결함 하나를 심는다. */
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import "../analysis/index.js";
import "../scenarios/index.js";
import { runAnalysisChecks } from "../analysis/checks.js";
import { AnalysisItemsSchema, type AnalysisItems } from "../analysis/schema.js";
import { HewError, rejectedError, stateError, usageError } from "../errors.js";
import { appendEvent } from "../events.js";
import { readJsonFile, writeJsonAtomic } from "../fsx.js";
import { hashJson } from "../hash.js";
import { RUN_ID_PATTERN } from "../init.js";
import { collectRunOpen } from "../open.js";
import { evalPaths, resolveRunDir, runPaths } from "../paths.js";
import { NO_REVISION, computeRevision } from "../revision.js";
import { loadRun, saveRun, type Run } from "../run.js";
import { RUN_STATES, emptyProgress } from "../state-machine.js";
import { getKindSpec } from "../submit.js";
import type { Unit } from "../units/types.js";
import { EVAL_KINDS, type EvalKind } from "./kinds.js";
import { findCandidates, type Candidate } from "./mutate.js";

export interface InjectOptions {
  /** 원본 실행 폴더 경로 또는 run_id. */
  source: string;
  kind: EvalKind;
  seed: number;
  outId?: string;
  now?: Date;
}

export interface InjectionFile {
  source_run: string;
  kind: EvalKind;
  seed: number;
  target: Record<string, unknown>;
  before: unknown;
  after: unknown;
  expected: string;
  candidates: number;
  checks_after: string[];
}

export interface InjectResult extends InjectionFile {
  run_id: string;
  dir: string;
}

/** 시드로 고른 후보와 변형한 분석 문서. 파일은 쓰지 않는다. */
export interface Chosen {
  sourceDir: string;
  source: Run;
  items: AnalysisItems;
  candidate: Candidate;
  count: number;
  before: unknown;
  after: unknown;
}

const reachedQaDesigned = (run: Run): boolean => RUN_STATES.indexOf(run.state) >= RUN_STATES.indexOf("qa_designed");

function readUnits(file: string): Unit[] {
  return existsSync(file) ? ((readJsonFile(file) as { units?: Unit[] }).units ?? []) : [];
}

/** 원본 실행을 읽어 종류의 후보를 모으고 시드로 하나를 골라 분석 문서 사본에 변형을 적용한다. */
export function chooseInjection(sourceArg: string, kind: EvalKind, seed: number): Chosen {
  if (!(EVAL_KINDS as readonly string[]).includes(kind)) throw usageError(`--kind 는 ${EVAL_KINDS.join("|")} 중 하나여야 합니다: ${kind}`);
  if (!Number.isInteger(seed) || seed < 0) throw usageError(`--seed 는 0 이상의 정수여야 합니다: ${seed}`);
  const sourceDir = resolveRunDir(sourceArg);
  const source = loadRun(sourceDir);
  const p = runPaths(sourceDir);
  if (!reachedQaDesigned(source)) throw stateError(`원본 실행의 상태가 ${source.state} 입니다. qa_designed 이후여야 합니다`);
  if (!existsSync(p.analysis)) throw stateError("원본 실행에 분석 정본(doc/analysis.json)이 없습니다");
  if (!existsSync(p.scenarios)) throw stateError("원본 실행에 시나리오 정본(doc/scenarios.json)이 없습니다");
  const parsed = AnalysisItemsSchema.safeParse((readJsonFile(p.analysis) as { items?: unknown }).items);
  if (!parsed.success) throw new HewError("internal", `analysis.json 형식이 올바르지 않습니다: ${parsed.error.issues[0]?.message ?? ""}`);

  const candidates = findCandidates(kind, parsed.data, readUnits(p.units));
  const candidate = candidates[seed % Math.max(candidates.length, 1)];
  if (candidate === undefined) throw rejectedError(`이 원본에서는 이 종류를 심을 수 없습니다: ${kind}(후보 없음)`);
  const items = structuredClone(parsed.data);
  const { before, after } = candidate.apply(items);
  const check = AnalysisItemsSchema.safeParse(items);
  if (!check.success) throw new HewError("internal", `변형한 분석 문서가 스키마를 통과하지 못했습니다: ${check.error.issues[0]?.message ?? ""}`);
  return { sourceDir, source, items: check.data, candidate, count: candidates.length, before, after };
}

/** 정본 틀을 새 실행에 맞게 고쳐 쓴다(run_id, 회차 1, 열린 항목 다시 계산, 비용 비움). */
function rewriteEnvelope(file: string, runId: string, kind: "analysis" | "scenarios", runDir: string, items?: unknown): void {
  const doc = readJsonFile(file) as Record<string, unknown>;
  const nextItems = items ?? doc.items;
  doc.run_id = runId;
  doc.attempt = 1;
  doc.items = nextItems;
  doc.open = getKindSpec(kind).collectOpen(nextItems as Record<string, unknown>, runDir);
  doc.cost = null;
  writeJsonAtomic(file, doc);
}

/** 변형한 분석 문서로 새 주입 실행 폴더를 만든다. */
export function injectDefect(opts: InjectOptions): InjectResult {
  const now = opts.now ?? new Date();
  const chosen = chooseInjection(opts.source, opts.kind, opts.seed);
  const { source, sourceDir, candidate, items } = chosen;
  const outId = opts.outId ?? `${source.run_id}-inj-${opts.kind}-${opts.seed}`;
  if (!RUN_ID_PATTERN.test(outId)) throw usageError(`--out-id 형식이 올바르지 않습니다: ${outId}`);
  const dir = resolveRunDir(outId);
  if (existsSync(dir)) throw usageError(`이미 있는 실행 폴더입니다: ${dir}`);

  const from = runPaths(sourceDir);
  const to = runPaths(dir);
  mkdirSync(dir, { recursive: true });
  if (existsSync(from.sources)) cpSync(from.sources, to.sources, { recursive: true });
  for (const d of [to.packets, to.work, to.findingsDir, to.gateAssets, to.doc, evalPaths(dir).dir]) mkdirSync(d, { recursive: true });
  for (const f of [to.costs, to.mistakes]) writeFileSync(f, "", "utf8");
  cpSync(from.analysis, to.analysis);
  cpSync(from.scenarios, to.scenarios);
  if (existsSync(from.answers)) cpSync(from.answers, to.answers);

  const stamp = now.toISOString();
  const base: Run = {
    run_id: outId,
    mode: "shadow",
    input: source.input,
    repo: source.repo,
    case: null,
    ...(source.case_info === undefined ? {} : { case_info: source.case_info }),
    eval: { source_run: source.run_id, kind: opts.kind, seed: opts.seed },
    state: "qa_designed",
    revision: NO_REVISION,
    rework: { analysis: 0, plan: 0 },
    progress: emptyProgress(),
    open: 0,
    submissions: {},
    created_at: stamp,
    updated_at: stamp,
  };
  saveRun(dir, base, now);
  appendEvent(to.events, "eval_injected", { source_run: source.run_id, kind: opts.kind, seed: opts.seed, expected: candidate.expected }, now);

  rewriteEnvelope(to.analysis, outId, "analysis", dir, items);
  rewriteEnvelope(to.scenarios, outId, "scenarios", dir);
  const checks = runAnalysisChecks(items, { kind: "analysis", for: null, run: base, runDir: dir });
  const checksAfter = [...new Set(checks.filter((i) => i.severity === "reject").map((i) => i.code))];

  const stored = (file: string): unknown => (readJsonFile(file) as { items: unknown }).items;
  saveRun(
    dir,
    {
      ...base,
      revision: computeRevision(dir),
      open: collectRunOpen(dir).length,
      submissions: {
        analysis: { attempt: 1, at: stamp, hash: hashJson(stored(to.analysis)) },
        scenarios: { attempt: 1, at: stamp, hash: hashJson(stored(to.scenarios)) },
      },
    },
    now,
  );

  const injection: InjectionFile = {
    source_run: source.run_id,
    kind: opts.kind,
    seed: opts.seed,
    target: candidate.target,
    before: chosen.before,
    after: chosen.after,
    expected: candidate.expected,
    candidates: chosen.count,
    checks_after: checksAfter,
  };
  writeJsonAtomic(evalPaths(dir).injection, injection);
  return { ...injection, run_id: outId, dir };
}

export interface InjectAllOptions {
  source: string;
  perKind: number;
  seed: number;
  now?: Date;
}

export interface InjectAllResult {
  runs: { run_id: string; kind: EvalKind; seed: number; expected: string }[];
  skipped: { kind: EvalKind; seed: number; reason: string }[];
}

/** 종류 6개 × n 개를 한꺼번에 만든다. 후보가 없거나 같은 대상이 다시 뽑히면 건너뛰고 사유를 남긴다. */
export function injectAll(opts: InjectAllOptions): InjectAllResult {
  if (!Number.isInteger(opts.perKind) || opts.perKind < 1) throw usageError(`--per-kind 는 1 이상의 정수여야 합니다: ${opts.perKind}`);
  if (!Number.isInteger(opts.seed) || opts.seed < 0) throw usageError(`--seed 는 0 이상의 정수여야 합니다: ${opts.seed}`);
  const out: InjectAllResult = { runs: [], skipped: [] };
  for (const kind of EVAL_KINDS) {
    const made = new Set<string>();
    for (let seed = opts.seed; seed < opts.seed + opts.perKind; seed += 1) {
      try {
        const chosen = chooseInjection(opts.source, kind, seed);
        if (made.has(chosen.candidate.id)) {
          out.skipped.push({ kind, seed, reason: `같은 대상(${chosen.candidate.id})이 다시 뽑혀 건너뜀` });
          continue;
        }
        const r = injectDefect({ source: opts.source, kind, seed, now: opts.now });
        made.add(chosen.candidate.id);
        out.runs.push({ run_id: r.run_id, kind, seed, expected: r.expected });
      } catch (error) {
        if (error instanceof HewError && error.kind === "rejected") out.skipped.push({ kind, seed, reason: "후보가 없어 건너뜀" });
        else if (error instanceof HewError && error.kind === "usage" && error.message.startsWith("이미 있는 실행 폴더")) {
          out.skipped.push({ kind, seed, reason: "이미 있는 실행 폴더라 건너뜀" });
        } else throw error;
      }
    }
  }
  return out;
}
