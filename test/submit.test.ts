import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { HewError } from "../src/core/errors.js";
import { readEvents } from "../src/core/events.js";
import { findingsPath, runPaths } from "../src/core/paths.js";
import { computeRevision } from "../src/core/revision.js";
import { loadRun } from "../src/core/run.js";
import {
  countBlocking,
  getKindSpec,
  registerCheck,
  registerKind,
  submitArtifact,
  type KindSpec,
  type SubmitKind,
} from "../src/core/submit.js";
import { makeRun, useTempRunsDir, writeItemsFile } from "./helpers.js";

useTempRunsDir();

const saved: Record<string, KindSpec> = {};
for (const k of ["analysis", "scenarios", "plan", "findings"] as SubmitKind[]) {
  const s = getKindSpec(k);
  saved[k] = { schema: s.schema, checks: [...s.checks], collectOpen: s.collectOpen };
}
afterEach(() => {
  for (const [k, spec] of Object.entries(saved)) registerKind(k as SubmitKind, { ...spec, checks: [...spec.checks] });
});

function fail(fn: () => unknown): HewError {
  try {
    fn();
  } catch (error) {
    if (error instanceof HewError) return error;
    throw error;
  }
  throw new Error("오류가 나야 합니다");
}

describe("submit: 통과", () => {
  it("정본, 상태, revision, 이벤트가 바뀐다", () => {
    const { dir } = makeRun("collected");
    const file = writeItemsFile(dir, "in.json", { requirements: [{ id: "요구-1" }] });
    const result = submitArtifact({ runDir: dir, kind: "analysis", file });
    expect(result).toMatchObject({ attempt: 1, previous_state: "collected", state: "analyzed" });

    const p = runPaths(dir);
    const doc = JSON.parse(readFileSync(p.analysis, "utf8"));
    expect(doc).toMatchObject({
      schema: "hew.analysis/1",
      run_id: "t-1",
      stage: "analysis",
      attempt: 1,
      input_revision: "none",
      produced_by: null,
      cost: null,
      open: [],
      verdict: { status: "pass" },
      items: { requirements: [{ id: "요구-1" }] },
    });

    const run = loadRun(dir);
    expect(run.state).toBe("analyzed");
    expect(run.revision).toBe(computeRevision(dir));
    expect(run.revision).not.toBe("none");
    expect(run.submissions.analysis).toMatchObject({ attempt: 1 });
    expect(run.submissions.analysis?.hash).toMatch(/^[0-9a-f]{64}$/);

    const submitted = readEvents(p.events).filter((e) => e.type === "artifact_submitted");
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.data).toMatchObject({ kind: "analysis", attempt: 1, from: "collected", to: "analyzed", row: 2 });
  });

  it("produced_by 와 cost 는 호출자가 준 값을 그대로 넣는다", () => {
    const { dir } = makeRun("analyzed");
    const file = writeItemsFile(dir, "in.json", { s: 1 });
    const producedBy = { role: "qa-designer", model: "m", effort: "high", role_sha: "abc", session_id: "s" };
    const cost = { usd: 0.5, duration_ms: 1000 };
    submitArtifact({ runDir: dir, kind: "scenarios", file, producedBy, cost });
    const doc = JSON.parse(readFileSync(runPaths(dir).scenarios, "utf8"));
    expect(doc.produced_by).toEqual(producedBy);
    expect(doc.cost).toEqual(cost);
  });

  it("두 번째 제출의 input_revision 은 첫 제출 뒤 revision 이다", () => {
    const { dir } = makeRun("collected");
    submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "a.json", { a: 1 }) });
    const after = loadRun(dir).revision;
    submitArtifact({ runDir: dir, kind: "scenarios", file: writeItemsFile(dir, "s.json", { s: 1 }) });
    expect(JSON.parse(readFileSync(runPaths(dir).scenarios, "utf8")).input_revision).toBe(after);
  });

  it("재제출하면 attempt 가 증가한다(반송 뒤 분석 재제출)", () => {
    const { dir } = makeRun("collected");
    submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "a.json", { a: 1 }) });
    submitArtifact({ runDir: dir, kind: "scenarios", file: writeItemsFile(dir, "s.json", { s: 1 }) });
    submitArtifact({
      runDir: dir,
      kind: "findings",
      for: "analysis",
      file: writeItemsFile(dir, "f.json", { findings: [{ verdict: "issue", evidence: "x" }] }),
    });
    expect(loadRun(dir)).toMatchObject({ state: "collected", rework: { analysis: 1, plan: 0 } });

    const again = submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "a2.json", { a: 2 }) });
    expect(again.attempt).toBe(2);
    expect(JSON.parse(readFileSync(runPaths(dir).analysis, "utf8")).attempt).toBe(2);
    expect(loadRun(dir).submissions.analysis?.attempt).toBe(2);
  });

  it("findings 는 doc/findings/<대상>-<회차>.json 에 쓰고 차단 지적 수로 전이한다", () => {
    const { dir } = makeRun("qa_designed");
    const clean = writeItemsFile(dir, "f.json", { findings: [{ verdict: "ok" }, { verdict: "issue" }] });
    const result = submitArtifact({ runDir: dir, kind: "findings", for: "analysis", file: clean });
    expect(result.state).toBe("checked");
    expect(result.path).toBe(findingsPath(runPaths(dir), "analysis", 1));
    expect(existsSync(result.path)).toBe(true);
    expect(JSON.parse(readFileSync(result.path, "utf8"))).toMatchObject({ stage: "findings_analysis", schema: "hew.findings/1" });
  });

  it("분해안 findings 는 plan-<회차>.json 에 쓴다", () => {
    const { dir } = makeRun("planned");
    const result = submitArtifact({
      runDir: dir,
      kind: "findings",
      for: "plan",
      file: writeItemsFile(dir, "f.json", { findings: [{ verdict: "issue", evidence: "e" }] }),
    });
    expect(result.path.endsWith("findings/plan-1.json")).toBe(true);
    expect(result.state).toBe("answers_applied");
    expect(loadRun(dir).rework.plan).toBe(1);
  });

  it("차단 지적 수는 verdict 가 issue 이고 evidence 가 있는 것만 센다", () => {
    expect(
      countBlocking({
        findings: [
          { verdict: "issue", evidence: "a" },
          { verdict: "issue" },
          { verdict: "issue", evidence: "" },
          { verdict: "issue", evidence: [] },
          { verdict: "ok", evidence: "b" },
          { verdict: "issue", evidence: [{ unit_id: "U-1" }] },
        ],
      }),
    ).toBe(2);
    expect(countBlocking({})).toBe(0);
  });

  it("warn 검사는 통과시키고 경고로 돌려준다", () => {
    registerCheck("analysis", () => [{ code: "w1", severity: "warn", ref: "요구-1", message: "경고" }]);
    const { dir } = makeRun("collected");
    const result = submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "a.json", { a: 1 }) });
    expect(result.warnings).toEqual([{ code: "w1", severity: "warn", ref: "요구-1", message: "경고" }]);
    expect(result.state).toBe("analyzed");
  });

  it("--withdraw 는 아직 지원하지 않음 경고를 낸다", () => {
    const { dir } = makeRun("collected");
    const result = submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "a.json", {}), withdraw: ["Q-1"] });
    expect(result.warnings.map((w) => w.code)).toContain("withdraw_unsupported");
  });

  it("answers_complete 에서 분석·시나리오·사수가 모두 끝나면 한 번에 전이한다", () => {
    const { dir } = makeRun("answers_complete");
    const a = submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "a.json", { a: 1 }) });
    expect(a.state).toBe("answers_complete");
    const s = submitArtifact({ runDir: dir, kind: "scenarios", file: writeItemsFile(dir, "s.json", { s: 1 }) });
    expect(s.state).toBe("answers_complete");
    expect(loadRun(dir).progress).toEqual({ analysis: true, scenarios: true, sasu: false });
    const f = submitArtifact({ runDir: dir, kind: "findings", for: "analysis", file: writeItemsFile(dir, "f.json", { findings: [] }) });
    expect(f.state).toBe("answers_applied");
    expect(loadRun(dir).progress).toEqual({ analysis: false, scenarios: false, sasu: false });
  });

  it("재제출에서 새 열린 항목이 생기면 checked 로 간다(collectOpen 교체)", () => {
    registerKind("analysis", { ...getKindSpec("analysis"), collectOpen: () => ["Q-9"] });
    const { dir } = makeRun("answers_complete");
    submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "a.json", { a: 1 }) });
    submitArtifact({ runDir: dir, kind: "scenarios", file: writeItemsFile(dir, "s.json", { s: 1 }) });
    const f = submitArtifact({ runDir: dir, kind: "findings", for: "analysis", file: writeItemsFile(dir, "f.json", { findings: [] }) });
    expect(f.state).toBe("checked");
    expect(loadRun(dir).open).toBe(1);
    expect(JSON.parse(readFileSync(runPaths(dir).analysis, "utf8")).open).toEqual(["Q-9"]);
  });
});

describe("submit: 거부(종료 3)", () => {
  function snapshot(dir: string): string {
    const p = runPaths(dir);
    const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");
    return [read(p.runJson), read(p.analysis), read(p.scenarios), read(p.plan)].join("|");
  }

  it("거부 검사가 하나라도 있으면 정본·상태가 그대로이고 artifact_rejected 만 남는다", () => {
    registerCheck("analysis", () => [
      { code: "c1", severity: "reject", ref: "요구-1", message: "나쁨" },
      { code: "c2", severity: "warn", ref: null, message: "경고" },
    ]);
    const { dir } = makeRun("collected");
    const before = snapshot(dir);
    const error = fail(() => submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "a.json", { a: 1 }) }));
    expect(error.exitCode).toBe(3);
    expect(error.issues.map((i) => i.code)).toEqual(["c1"]);
    expect(snapshot(dir)).toBe(before);
    expect(existsSync(runPaths(dir).analysis)).toBe(false);
    const types = readEvents(runPaths(dir).events).map((e) => e.type);
    expect(types).toEqual(["run_created", "artifact_rejected"]);
  });

  it("스키마에 맞지 않으면(items 가 객체가 아님) 종료 3", () => {
    const { dir } = makeRun("collected");
    const before = snapshot(dir);
    const error = fail(() => submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "a.json", [1, 2]) }));
    expect(error.exitCode).toBe(3);
    expect(error.issues[0]?.code).toBe("schema_invalid");
    expect(snapshot(dir)).toBe(before);
  });

  it("JSON 이 아니면 종료 3", () => {
    const { dir } = makeRun("collected");
    const error = fail(() => submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "a.json", "{not json") }));
    expect(error.exitCode).toBe(3);
    expect(error.issues[0]?.code).toBe("json_parse");
    expect(loadRun(dir).state).toBe("collected");
  });

  it("거부 뒤 같은 종류를 고쳐 내면 attempt 는 1 이다", () => {
    const { dir } = makeRun("collected");
    fail(() => submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "bad.json", "x") }));
    const ok = submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "ok.json", { a: 1 }) });
    expect(ok.attempt).toBe(1);
  });
});

describe("submit: 상태와 인자", () => {
  it("상태에 맞지 않는 종류는 종료 4 이고 아무것도 바뀌지 않는다", () => {
    const { dir } = makeRun("collected");
    const before = readFileSync(runPaths(dir).runJson, "utf8");
    const file = writeItemsFile(dir, "x.json", { x: 1 });
    for (const kind of ["scenarios", "plan"] as const) {
      expect(fail(() => submitArtifact({ runDir: dir, kind, file })).exitCode).toBe(4);
    }
    expect(fail(() => submitArtifact({ runDir: dir, kind: "findings", for: "analysis", file })).exitCode).toBe(4);
    expect(readFileSync(runPaths(dir).runJson, "utf8")).toBe(before);
    expect(readEvents(runPaths(dir).events).map((e) => e.type)).toEqual(["run_created"]);
  });

  it("상태가 안 맞으면 내용이 나빠도 먼저 종료 4", () => {
    const { dir } = makeRun("init");
    const file = writeItemsFile(dir, "x.json", "not json");
    expect(fail(() => submitArtifact({ runDir: dir, kind: "analysis", file })).exitCode).toBe(4);
  });

  it("qa_designed 에서 분해안용 findings 는 종료 4", () => {
    const { dir } = makeRun("qa_designed");
    const file = writeItemsFile(dir, "x.json", { findings: [] });
    expect(fail(() => submitArtifact({ runDir: dir, kind: "findings", for: "plan", file })).exitCode).toBe(4);
  });

  it("findings 에 --for 가 없거나 다른 종류에 --for 가 있으면 종료 2", () => {
    const { dir } = makeRun("qa_designed");
    const file = writeItemsFile(dir, "x.json", {});
    expect(fail(() => submitArtifact({ runDir: dir, kind: "findings", file })).exitCode).toBe(2);
    expect(fail(() => submitArtifact({ runDir: dir, kind: "analysis", for: "plan", file })).exitCode).toBe(2);
  });

  it("파일이 없으면 종료 2", () => {
    const { dir } = makeRun("collected");
    expect(fail(() => submitArtifact({ runDir: dir, kind: "analysis", file: `${dir}/nope.json` })).exitCode).toBe(2);
  });
});
