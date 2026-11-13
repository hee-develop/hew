import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readMistakes } from "../src/core/mistakes.js";
import { runPaths } from "../src/core/paths.js";
import { loadRun } from "../src/core/run.js";
import { loadPlan } from "../src/core/sasu/store.js";
import { makeRun, useTempRunsDir } from "./helpers.js";
import { setupQaDesigned, writeFindingsFile } from "./sasu-fixtures.js";
import { createPlan } from "../src/core/sasu/plan.js";

const runs = useTempRunsDir();
const BIN = join(import.meta.dirname, "..", "bin", "hew");
const hew = (args: string[]) => spawnSync(BIN, args, { env: { ...process.env, HEW_RUNS_DIR: runs.dir }, encoding: "utf8" });
const parse = (stdout: string) => JSON.parse(stdout) as { ok: boolean; data: any; warnings: any[]; errors: any[] };

describe("hew sasu plan", () => {
  it("계획을 만들고 요약을 낸다. 다시 부르면 이미 있다고 알린다", () => {
    const { dir } = setupQaDesigned();
    const run = loadRun(dir).run_id;
    const r = hew(["--json", "sasu", "plan", "--run", run, "--for", "analysis"]);
    expect(r.status).toBe(0);
    const body = parse(r.stdout);
    expect(body.data).toMatchObject({ created: true, completed: null });
    expect(body.data.plan.batches).toHaveLength(6);
    expect(loadPlan(dir, 1)?.units).toHaveLength(17);
    const text = hew(["sasu", "plan", "--run", run, "--for", "analysis"]);
    expect(text.stdout).toContain("이미 만들어 둔 사수 계획");
  });

  it("--for plan 은 사용법 오류(종료 2), 알 수 없는 값도 종료 2", () => {
    const { dir } = setupQaDesigned();
    const run = loadRun(dir).run_id;
    expect(hew(["--json", "sasu", "plan", "--run", run, "--for", "plan"]).status).toBe(2);
    expect(hew(["--json", "sasu", "plan", "--run", run, "--for", "x"]).status).toBe(2);
  });

  it("사수 차례가 아니면 종료 4", () => {
    const { dir } = makeRun("collected", {}, "cli-sasu-1");
    expect(dir).toBeTruthy();
    expect(hew(["--json", "sasu", "plan", "--run", "cli-sasu-1", "--for", "analysis"]).status).toBe(4);
  });
});

describe("hew submit findings --batch", () => {
  it("묶음을 내면 종료 0, 마지막 묶음에서 회차가 완료되어 상태가 바뀐다", () => {
    const { dir } = setupQaDesigned();
    const run = loadRun(dir).run_id;
    const plan = createPlan(dir, "analysis").plan;
    let last = parse("{}" as string);
    for (const b of plan.batches) {
      const file = writeFindingsFile(dir, plan, b.k);
      const r = hew(["--json", "submit", "findings", "--for", "analysis", "--batch", String(b.k), "--run", run, "--file", file]);
      expect(r.status).toBe(0);
      last = parse(r.stdout);
      expect(last.data).toMatchObject({ kind: "findings", for: "analysis", round: 1, batch: b.k });
    }
    expect(last.data).toMatchObject({ previous_state: "qa_designed", state: "checked" });
    expect(last.data.completed).toMatchObject({ round: 1, blocking: 0 });
    expect(loadRun(dir).state).toBe("checked");
  });

  it("--batch 없이는 종료 2, 같은 묶음을 다시 내면 종료 3, 분석용이 아닌 곳의 --batch 도 종료 2", () => {
    const { dir } = setupQaDesigned();
    const run = loadRun(dir).run_id;
    const plan = createPlan(dir, "analysis").plan;
    const file = writeFindingsFile(dir, plan, 1);
    expect(hew(["--json", "submit", "findings", "--for", "analysis", "--run", run, "--file", file]).status).toBe(2);
    expect(hew(["--json", "submit", "findings", "--for", "analysis", "--batch", "x", "--run", run, "--file", file]).status).toBe(2);
    expect(hew(["--json", "submit", "findings", "--for", "analysis", "--batch", "1", "--run", run, "--file", file]).status).toBe(0);
    const again = hew(["--json", "submit", "findings", "--for", "analysis", "--batch", "1", "--run", run, "--file", file]);
    expect(again.status).toBe(3);
    expect(parse(again.stdout).errors.map((e) => e.code)).toContain("batch_already_submitted");
    expect(hew(["--json", "submit", "analysis", "--batch", "1", "--run", run, "--file", file]).status).toBe(2);
  });

  it("근거가 맞지 않는 issue 는 경고를 내고 종료 0", () => {
    const { dir } = setupQaDesigned();
    const run = loadRun(dir).run_id;
    const plan = createPlan(dir, "analysis").plan;
    const file = writeFindingsFile(dir, plan, 1, { "W2:요구-1": { verdict: "issue", kind: "unsupported", claim: "c", evidence: { quote: "없는 문장" }, action: "fix" } });
    const r = hew(["--json", "submit", "findings", "--for", "analysis", "--batch", "1", "--run", run, "--file", file]);
    expect(r.status).toBe(0);
    expect(parse(r.stdout).warnings.map((w) => w.code)).toEqual(["finding_evidence_unverified"]);
  });
});

describe("hew mistake add", () => {
  const args = (run: string, extra: string[] = []) => [
    "--json", "mistake", "add", "--run", run, "--found-stage", "sasu", "--cause-stage", "analysis", "--found-by", "human_gate",
    "--type", "missed_question", "--target", "Q-1", "--evidence", "사람이 게이트에서 질문이 빠졌다고 지적", ...extra,
  ];

  it("한 줄을 덧붙이고 M-n 을 돌려준다(--case 는 선택)", () => {
    const { dir } = makeRun("checked", {}, "cli-m-1");
    const a = hew(args("cli-m-1"));
    expect(a.status).toBe(0);
    expect(parse(a.stdout).data).toMatchObject({ id: "M-1", found_by: "human_gate", type: "missed_question", target: "Q-1" });
    const b = hew(args("cli-m-1", ["--case", "case-7"]));
    expect(parse(b.stdout).data).toMatchObject({ id: "M-2", case: "case-7" });
    expect(readMistakes(dir)).toHaveLength(2);
    expect(readFileSync(runPaths(dir).mistakes, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("열거값이 틀리면 종료 2 이고 기록하지 않는다", () => {
    const { dir } = makeRun("checked", {}, "cli-m-2");
    const bad = args("cli-m-2").map((x) => (x === "missed_question" ? "weird" : x));
    expect(hew(bad).status).toBe(2);
    expect(readMistakes(dir)).toEqual([]);
  });

  it("필수 옵션이 빠지면 종료 2", () => {
    makeRun("checked", {}, "cli-m-3");
    expect(hew(["--json", "mistake", "add", "--run", "cli-m-3", "--type", "format"]).status).toBe(2);
  });
});
