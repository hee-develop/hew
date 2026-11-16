/** 주입 실행들의 eval/result.json 을 모아 종류별 포착률 표를 만든다. */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { usageError } from "../errors.js";
import { readJsonFile } from "../fsx.js";
import { evalPaths, resolveRunDir, runsRoot } from "../paths.js";
import { loadRun } from "../run.js";
import { EVAL_KINDS, type EvalKind } from "./kinds.js";
import type { EvalResult } from "./sasu.js";

export interface ScoreRow {
  kind: EvalKind | "합계";
  injected: number;
  caught: number;
  /** caught_any 이지만 caught 가 아닌 수. */
  caught_without_evidence: number;
  /** 잡은 수 / 주입 수. */
  rate: number;
  /** 그 종류에서 expected 가 아닌 단위에 난 지적 수의 평균. */
  other_issues_avg: number;
  cost_usd: number;
}

export interface ScoreResult {
  rows: ScoreRow[];
  runs: string[];
  /** --source 로 모았지만 eval/result.json 이 아직 없는 실행. */
  without_result: string[];
}

export interface ScoreOptions {
  runs?: string[];
  source?: string;
}

const round = (n: number, digits: number): number => Number(n.toFixed(digits));

function rowOf(kind: ScoreRow["kind"], results: EvalResult[]): ScoreRow {
  const injected = results.length;
  const caught = results.filter((r) => r.caught).length;
  const total = (pick: (r: EvalResult) => number): number => results.reduce((a, r) => a + pick(r), 0);
  return {
    kind,
    injected,
    caught,
    caught_without_evidence: results.filter((r) => r.caught_any && !r.caught).length,
    rate: injected === 0 ? 0 : round(caught / injected, 4),
    other_issues_avg: injected === 0 ? 0 : round(total((r) => r.other_issues.count) / injected, 2),
    cost_usd: round(total((r) => r.cost_usd), 4),
  };
}

/** runsRoot 아래에서 그 원본 실행에서 나온 주입 실행의 폴더 이름을 모은다. */
function injectedFrom(sourceRunId: string): string[] {
  const root = runsRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .filter((name) => {
      const dir = join(root, name);
      if (!existsSync(join(dir, "run.json"))) return false;
      try {
        return loadRun(dir).eval?.source_run === sourceRunId;
      } catch {
        return false;
      }
    });
}

/** 결과 파일을 모아 종류별 집계를 낸다. */
export function scoreRuns(opts: ScoreOptions): ScoreResult {
  if ((opts.runs === undefined) === (opts.source === undefined)) throw usageError("--runs 와 --source 중 정확히 하나만 지정해야 합니다");
  const names = opts.runs ?? injectedFrom(loadRun(resolveRunDir(opts.source as string)).run_id);
  const byKind = new Map<EvalKind, EvalResult[]>();
  const used: string[] = [];
  const without: string[] = [];
  for (const name of names) {
    const dir = resolveRunDir(name);
    const run = loadRun(dir);
    if (run.eval === undefined) throw usageError(`결함 주입 실행이 아닙니다: ${name}`);
    const file = evalPaths(dir).result;
    if (!existsSync(file)) {
      if (opts.runs !== undefined) throw usageError(`eval/result.json 이 없습니다. 먼저 hew eval sasu 를 돌리세요: ${name}`);
      without.push(run.run_id);
      continue;
    }
    byKind.set(run.eval.kind, [...(byKind.get(run.eval.kind) ?? []), readJsonFile(file) as EvalResult]);
    used.push(run.run_id);
  }
  const rows = EVAL_KINDS.filter((k) => byKind.has(k)).map((k) => rowOf(k, byKind.get(k) ?? []));
  if (rows.length > 0) rows.push(rowOf("합계", [...byKind.values()].flat()));
  return { rows, runs: used, without_result: without };
}

const HEADER = ["종류", "주입", "잡음", "근거 없이 잡음", "포착률", "다른 단위 지적 평균", "비용(USD)"];

const cells = (r: ScoreRow): string[] => [
  r.kind,
  String(r.injected),
  String(r.caught),
  String(r.caught_without_evidence),
  `${(r.rate * 100).toFixed(1)}%`,
  r.other_issues_avg.toFixed(2),
  r.cost_usd.toFixed(4),
];

/** Markdown 표. */
export function formatMarkdown(rows: ScoreRow[]): string {
  const lines = [`| ${HEADER.join(" | ")} |`, `|${HEADER.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${cells(r).join(" | ")} |`)];
  return `${lines.join("\n")}\n`;
}

/** 터미널용 한국어 표(열 사이를 공백으로 맞춘다). */
export function formatTable(rows: ScoreRow[]): string {
  const table = [HEADER, ...rows.map(cells)];
  const width = HEADER.map((_, i) => Math.max(...table.map((row) => [...(row[i] as string)].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x7f ? 2 : 1), 0))));
  const pad = (text: string, w: number): string => text + " ".repeat(w - [...text].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x7f ? 2 : 1), 0));
  return table.map((row) => row.map((c, i) => pad(c, width[i] as number)).join("  ").trimEnd()).join("\n");
}

/** Markdown 표를 파일로 저장한다. */
export function writeMarkdown(file: string, rows: ScoreRow[]): void {
  writeFileSync(file, formatMarkdown(rows), "utf8");
}
