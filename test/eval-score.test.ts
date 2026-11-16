import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { injectDefect } from "../src/core/eval/inject.js";
import type { EvalKind } from "../src/core/eval/kinds.js";
import type { EvalResult } from "../src/core/eval/sasu.js";
import { formatMarkdown, formatTable, scoreRuns } from "../src/core/eval/score.js";
import { evalPaths } from "../src/core/paths.js";
import { setupEvalSource } from "./eval-fixtures.js";
import { useTempRunsDir } from "./helpers.js";

const runs = useTempRunsDir();
const BIN = join(import.meta.dirname, "..", "bin", "hew");
const hew = (args: string[]) => spawnSync(BIN, args, { env: { ...process.env, HEW_RUNS_DIR: runs.dir }, encoding: "utf8" });

const result = (patch: Partial<EvalResult> = {}): EvalResult => ({
  expected: "W3:U-1",
  caught: true,
  caught_any: true,
  other_issues: { count: 0, list: [] },
  units: 10,
  cost_usd: 0.1,
  duration_ms: 1000,
  ...patch,
});

/** 주입 실행을 만들고 결과 파일을 직접 쓴다. */
function made(source: string, kind: EvalKind, seed: number, res: EvalResult | null): string {
  const r = injectDefect({ source, kind, seed });
  if (res !== null) writeFileSync(evalPaths(r.dir).result, JSON.stringify(res));
  return r.run_id;
}

const issues = (count: number) => ({ count, list: Array.from({ length: count }, (_, i) => ({ work: `W3:U-${i + 2}`, kind: "missing", claim: "c", blocking: true })) });

const idOf = (dir: string): string => dir.split("/").pop() as string;

function setupScored(): { source: string; ids: string[]; sourceId: string } {
  const { dir } = setupEvalSource();
  const ids = [
    made(dir, "w3_delete", 0, result({ other_issues: issues(2), cost_usd: 0.25 })),
    made(dir, "w3_delete", 1, result({ caught: false, caught_any: true, other_issues: issues(0), cost_usd: 0.25 })),
    made(dir, "w3_delete", 2, result({ caught: false, caught_any: false, other_issues: issues(1), cost_usd: 0.5 })),
    made(dir, "w2_alter", 0, result({ expected: "W2:요구-1", other_issues: issues(3), cost_usd: 0.125 })),
  ];
  return { source: dir, ids, sourceId: idOf(dir) };
}

describe("eval score", () => {
  it("종류별로 주입 수·잡은 수·근거 없이 잡은 수·포착률·다른 단위 지적 평균·비용을 모은다", () => {
    const { ids } = setupScored();
    const r = scoreRuns({ runs: ids });
    expect(r.rows).toEqual([
      { kind: "w3_delete", injected: 3, caught: 1, caught_without_evidence: 1, rate: 0.3333, other_issues_avg: 1, cost_usd: 1 },
      { kind: "w2_alter", injected: 1, caught: 1, caught_without_evidence: 0, rate: 1, other_issues_avg: 3, cost_usd: 0.125 },
      { kind: "합계", injected: 4, caught: 2, caught_without_evidence: 1, rate: 0.5, other_issues_avg: 1.5, cost_usd: 1.125 },
    ]);
    expect(r.runs).toEqual(ids);
    expect(r.without_result).toEqual([]);
  });

  it("--source 는 그 원본에서 나온 주입 실행 전부를 모으고, 결과가 아직 없는 실행은 따로 알린다", () => {
    const { source, sourceId, ids } = setupScored();
    const pending = made(source, "w5_ainote", 0, null);
    const other = setupEvalSource().dir;
    made(other, "w3_delete", 0, result({ cost_usd: 9 }));
    const r = scoreRuns({ source: sourceId });
    expect([...r.runs].sort()).toEqual([...ids].sort());
    expect(r.without_result).toEqual([pending]);
    expect(r.rows.find((x) => x.kind === "w3_delete")?.cost_usd).toBe(1);
  });

  it("--runs 의 실행에 결과가 없거나 주입 실행이 아니거나, 인자가 둘 다·둘 다 없으면 종료 2", () => {
    const { source, ids } = setupScored();
    const pending = made(source, "w5_ainote", 0, null);
    for (const fn of [() => scoreRuns({ runs: [pending] }), () => scoreRuns({ runs: [idOf(source)] }), () => scoreRuns({}), () => scoreRuns({ runs: ids, source })]) {
      try {
        fn();
        expect.unreachable();
      } catch (e) {
        expect((e as { exitCode: number }).exitCode).toBe(2);
      }
    }
  });

  it("표와 Markdown 표를 만든다", () => {
    const { ids } = setupScored();
    const { rows } = scoreRuns({ runs: ids });
    const table = formatTable(rows).split("\n");
    expect(table[0]).toMatch(/^종류\s+주입\s+잡음\s+근거 없이 잡음\s+포착률\s+다른 단위 지적 평균\s+비용\(USD\)$/);
    expect(table[1]).toMatch(/^w3_delete\s+3\s+1\s+1\s+33\.3%\s+1\.00\s+1\.0000$/);
    expect(table).toHaveLength(4);
    const md = formatMarkdown(rows).split("\n");
    expect(md[0]).toBe("| 종류 | 주입 | 잡음 | 근거 없이 잡음 | 포착률 | 다른 단위 지적 평균 | 비용(USD) |");
    expect(md[1]).toBe("|---|---|---|---|---|---|---|");
    expect(md[2]).toBe("| w3_delete | 3 | 1 | 1 | 33.3% | 1.00 | 1.0000 |");
  });

  it("CLI: 한국어 표, --json, --out 으로 Markdown 저장", () => {
    const { ids, sourceId } = setupScored();
    const text = hew(["eval", "score", "--runs", ids.join(",")]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("포착률");
    expect(text.stdout).toContain("w3_delete");
    const out = join(runs.dir, "score.md");
    const saved = hew(["--json", "eval", "score", "--source", sourceId, "--out", out]);
    expect(saved.status).toBe(0);
    const body = JSON.parse(saved.stdout) as { data: { rows: { kind: string; injected: number }[] } };
    expect(body.data.rows.map((r) => [r.kind, r.injected])).toEqual([["w3_delete", 3], ["w2_alter", 1], ["합계", 4]]);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8")).toContain("| w3_delete | 3 | 1 | 1 | 33.3% | 1.00 | 1.0000 |");
    expect(hew(["--json", "eval", "score"]).status).toBe(2);
  });

  it("집계할 결과가 없으면 안내만 낸다", () => {
    const { dir } = setupEvalSource();
    const r = hew(["eval", "score", "--source", idOf(dir)]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("집계할 결과가 없습니다");
  });
});
