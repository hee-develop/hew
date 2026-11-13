import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HewError } from "../src/core/errors.js";
import { readEvents } from "../src/core/events.js";
import { injectDefect } from "../src/core/eval/inject.js";
import { parseCodes, runEvalSasu, scoreFindings } from "../src/core/eval/sasu.js";
import { evalPaths, findingsPath, runPaths } from "../src/core/paths.js";
import { loadRun } from "../src/core/run.js";
import { loadPlan } from "../src/core/sasu/store.js";
import { setupEvalSource } from "./eval-fixtures.js";
import { useTempRunsDir } from "./helpers.js";
import { FAKE_HEKA, makeFakeClaude, readCalls, tempDir } from "./runner-helpers.js";

const runs = useTempRunsDir();
const fakeClaude = makeFakeClaude();

function fakeEnv(extra: Record<string, string> = {}): { env: NodeJS.ProcessEnv; log: string } {
  const log = tempDir("hew-fake-log-");
  return {
    log,
    env: { ...process.env, HEW_RUNS_DIR: runs.dir, HEW_CLAUDE_BIN: fakeClaude, HEW_HEKA_BIN: FAKE_HEKA, FAKE_CLAUDE_MODE: "sasu_issue_units", FAKE_CLAUDE_LOG: log, ...extra },
  };
}

const json = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;

/** W3:U-10 을 심은 주입 실행을 만든다. */
function injected(kind: "w3_delete" | "w2_alter" = "w3_delete", seed = 1): { dir: string; expected: string } {
  const { dir: source } = setupEvalSource();
  const r = injectDefect({ source, kind, seed });
  return { dir: r.dir, expected: r.expected };
}

describe("hew eval sasu", () => {
  it("심은 단위에 근거 있는 issue 를 내면 caught 이고, 회차 완료 처리는 일어나지 않는다", async () => {
    const { dir, expected } = injected();
    const { env, log } = fakeEnv({ FAKE_CLAUDE_ISSUE_UNITS: expected });
    const before = loadRun(dir);
    const result = await runEvalSasu({ run: dir, env });
    expect(expected).toBe("W3:U-10");
    expect(result).toMatchObject({ expected, caught: true, caught_any: true, other_issues: { count: 0, list: [] } });

    const plan = loadPlan(dir, 1);
    expect(plan?.units.every((u) => u.code === "W3")).toBe(true);
    expect(result.units).toBe(plan?.units.length);
    expect(plan?.batches).toHaveLength(1);
    expect(result.cost_usd).toBeCloseTo(0.0123, 4);
    expect(result.duration_ms).toBe(1234);
    expect(readCalls(log)).toHaveLength(1);
    expect(readCalls(log)[0]?.argv).toContain("hew:manager-sasu");

    // 회차 완료 처리(상태 전이·합친 정본·질문 전환·실수 기록)가 없다.
    const after = loadRun(dir);
    expect(after.state).toBe("qa_designed");
    expect(after.rework).toEqual({ analysis: 0, plan: 0 });
    expect(after.submissions).toEqual(before.submissions);
    expect(after.open).toBe(before.open);
    expect(existsSync(findingsPath(runPaths(dir), "analysis", 1))).toBe(false);
    expect(readFileSync(runPaths(dir).mistakes, "utf8")).toBe("");
    const types = readEvents(runPaths(dir).events).map((e) => e.type);
    expect(types).toContain("findings_batch_submitted");
    expect(types).not.toContain("sasu_round_completed");
    expect(types).not.toContain("sasu_questions_added");

    // 묶음별 지적을 모은 eval/findings.json 과 eval/result.json.
    const collected = json(evalPaths(dir).findings);
    expect(collected.codes).toEqual(["W3"]);
    expect(collected.findings).toHaveLength(plan?.units.length ?? -1);
    expect(collected.findings.filter((f: { verdict: string }) => f.verdict === "issue")).toMatchObject([{ work: "W3:U-10", kind: "missing", blocking: true }]);
    expect(json(evalPaths(dir).result)).toEqual(JSON.parse(JSON.stringify(result)));
  });

  it("아무 단위에도 지적하지 않으면 못 잡은 것이다", async () => {
    const { dir } = injected();
    const result = await runEvalSasu({ run: dir, env: fakeEnv({ FAKE_CLAUDE_MODE: "sasu_ok" }).env });
    expect(result).toMatchObject({ caught: false, caught_any: false, other_issues: { count: 0 } });
    expect(loadRun(dir).state).toBe("qa_designed");
  });

  it("다른 단위에만 지적하면 못 잡고 다른 단위 지적으로 센다", async () => {
    const { dir } = injected();
    const result = await runEvalSasu({ run: dir, env: fakeEnv({ FAKE_CLAUDE_ISSUE_UNITS: "W3:U-1,W3:U-5" }).env });
    expect(result.caught).toBe(false);
    expect(result.caught_any).toBe(false);
    expect(result.other_issues.count).toBe(2);
    expect(result.other_issues.list).toEqual([
      { work: "W3:U-1", kind: "missing", claim: "가짜 사수가 낸 지적", blocking: true },
      { work: "W3:U-5", kind: "missing", claim: "가짜 사수가 낸 지적", blocking: true },
    ]);
  });

  it("심은 단위의 지적에 근거가 없으면 caught_any 만 참이다", async () => {
    const { dir } = injected();
    const result = await runEvalSasu({ run: dir, env: fakeEnv({ FAKE_CLAUDE_ISSUE_UNITS: "W3:U-10", FAKE_CLAUDE_ISSUE_EVIDENCE: "none" }).env });
    expect(result).toMatchObject({ caught: false, caught_any: true, other_issues: { count: 0 } });
  });

  it("--codes 가 있으면 그 종류의 단위만 돌린다(여러 종류면 묶음도 종류별로)", async () => {
    const { dir } = injected();
    const { env, log } = fakeEnv({ FAKE_CLAUDE_ISSUE_UNITS: "W3:U-10,W4:요구-3" });
    const result = await runEvalSasu({ run: dir, codes: parseCodes("W3,W4"), env });
    const plan = loadPlan(dir, 1);
    expect([...new Set(plan?.units.map((u) => u.code))]).toEqual(["W3", "W4"]);
    expect(plan?.batches.map((b) => b.code)).toEqual(["W3", "W4"]);
    expect(readCalls(log)).toHaveLength(2);
    expect(result).toMatchObject({ caught: true, other_issues: { count: 1, list: [{ work: "W4:요구-3", kind: "false_confirmed" }] } });
    expect(result.units).toBe(plan?.units.length);
  });

  it("--codes 에 expected 의 종류가 없으면 expected 단위가 돌지 않아 못 잡은 것이다", async () => {
    const { dir } = injected();
    const result = await runEvalSasu({ run: dir, codes: ["W5"], env: fakeEnv({ FAKE_CLAUDE_ISSUE_UNITS: "W3:U-10" }).env });
    expect(result.caught).toBe(false);
    expect(loadPlan(dir, 1)?.units.every((u) => u.code === "W5")).toBe(true);
  });

  it("w2_alter 는 기본으로 W2 단위만 돈다", async () => {
    const { dir, expected } = injected("w2_alter", 2);
    expect(expected).toBe("W2:요구-4");
    const result = await runEvalSasu({ run: dir, env: fakeEnv({ FAKE_CLAUDE_ISSUE_UNITS: expected }).env });
    expect(result).toMatchObject({ caught: true, units: 4 });
    expect(loadPlan(dir, 1)?.units.map((u) => u.id)).toEqual(["W2:요구-1", "W2:요구-2", "W2:요구-3", "W2:요구-4"]);
  });

  it("--max-steps 에 닿으면 종료 4 이고, 다시 부르면 남은 묶음만 이어서 돈다", async () => {
    const { dir, expected } = injected();
    const codes = parseCodes("W3,W4,W5");
    const first = fakeEnv({ FAKE_CLAUDE_ISSUE_UNITS: expected });
    try {
      await runEvalSasu({ run: dir, codes, maxSteps: 1, env: first.env });
      expect.unreachable();
    } catch (e) {
      expect((e as HewError).exitCode).toBe(4);
    }
    expect(existsSync(evalPaths(dir).result)).toBe(false);
    const second = fakeEnv({ FAKE_CLAUDE_ISSUE_UNITS: expected });
    const result = await runEvalSasu({ run: dir, codes, env: second.env });
    expect(readCalls(first.log)).toHaveLength(1);
    expect(readCalls(second.log)).toHaveLength(2);
    expect(result.caught).toBe(true);
    expect(result.cost_usd).toBeCloseTo(0.0369, 4);
  });

  it("주입 실행이 아니거나 qa_designed 가 아니면 거부한다", async () => {
    const { dir: source } = setupEvalSource();
    await expect(runEvalSasu({ run: source, env: fakeEnv().env })).rejects.toMatchObject({ exitCode: 2 });
    const { dir } = injected();
    const file = runPaths(dir).runJson;
    writeFileSync(file, JSON.stringify({ ...json(file), state: "checked" }));
    await expect(runEvalSasu({ run: dir, env: fakeEnv().env })).rejects.toMatchObject({ exitCode: 4 });
  });

  it("평가 실행이 아니면 마지막 묶음이 들어올 때 회차를 완료한다(기존 경로 그대로)", async () => {
    const { dir: source } = setupEvalSource();
    const { runLoop } = await import("../src/core/runner.js");
    const result = await runLoop({ runDir: source, until: "checked", env: fakeEnv({ FAKE_CLAUDE_MODE: "sasu_ok" }).env });
    expect(result.state).toBe("checked");
    expect(existsSync(findingsPath(runPaths(source), "analysis", 1))).toBe(true);
  });
});

describe("parseCodes·scoreFindings", () => {
  it("쉼표로 이은 종류를 읽고 틀린 값은 종료 2", () => {
    expect(parseCodes("W3, W2,W3")).toEqual(["W3", "W2"]);
    for (const bad of ["", "W1", "T1", "W3,x"]) expect(() => parseCodes(bad)).toThrow(HewError);
  });

  it("차단·근거 없는 지적을 가려 채점한다", () => {
    const f = (work: string, verdict: "ok" | "issue", blocking: boolean) => ({ id: "F-1", work, verdict, blocking, ...(verdict === "issue" ? { kind: "missing" as const, claim: "c" } : {}) });
    const costs = { cost_usd: 1, duration_ms: 2 };
    expect(scoreFindings("W3:U-1", [f("W3:U-1", "issue", true), f("W3:U-2", "ok", false)], 2, costs)).toMatchObject({ caught: true, caught_any: true, units: 2, other_issues: { count: 0 } });
    expect(scoreFindings("W3:U-1", [f("W3:U-1", "issue", false), f("W3:U-2", "issue", true)], 2, costs)).toMatchObject({ caught: false, caught_any: true, other_issues: { count: 1 } });
    expect(scoreFindings("W3:U-1", [], 0, costs)).toMatchObject({ caught: false, caught_any: false });
  });
});

describe("hew eval sasu (CLI)", () => {
  it("가짜 claude 로 돌려 종료 0 과 결과 요약을 낸다", () => {
    const { dir, expected } = injected();
    const { env } = fakeEnv({ FAKE_CLAUDE_ISSUE_UNITS: expected });
    const r = spawnSync(join(import.meta.dirname, "..", "bin", "hew"), ["--json", "eval", "sasu", "--run", loadRun(dir).run_id, "--codes", "W3"], { env, encoding: "utf8" });
    expect(r.status).toBe(0);
    const body = JSON.parse(r.stdout) as { data: Record<string, any> };
    expect(body.data).toMatchObject({ expected, caught: true });
    const text = spawnSync(join(import.meta.dirname, "..", "bin", "hew"), ["eval", "sasu", "--run", loadRun(dir).run_id], { env, encoding: "utf8" });
    expect(text.stdout).toContain("W3:U-10: 잡음");
    const bad = spawnSync(join(import.meta.dirname, "..", "bin", "hew"), ["--json", "eval", "sasu", "--run", loadRun(dir).run_id, "--codes", "W1"], { env, encoding: "utf8" });
    expect(bad.status).toBe(2);
  }, 60000);
});
