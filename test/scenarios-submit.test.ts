import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HewError } from "../src/core/errors.js";
import { readEvents } from "../src/core/events.js";
import { collectRunOpen } from "../src/core/open.js";
import { runPaths } from "../src/core/paths.js";
import { loadRun } from "../src/core/run.js";
import { ScenarioItemsSchema } from "../src/core/scenarios/schema.js";
import { submitArtifact } from "../src/core/submit.js";
import { answersPath, buildAnalysis, clone, setState, setupRun, writeJson, type Doc } from "./analysis-fixtures.js";
import { PRD_URL, useTempRunsDir, writeItemsFile } from "./helpers.js";
import { buildScenarios, setupAnalyzed } from "./scenarios-fixtures.js";

const runs = useTempRunsDir();
const BIN = join(import.meta.dirname, "..", "bin", "hew");
const hew = (args: string[]) => spawnSync(BIN, args, { env: { ...process.env, HEW_RUNS_DIR: runs.dir }, encoding: "utf8" });
const readScenarios = (dir: string): Doc => JSON.parse(readFileSync(runPaths(dir).scenarios, "utf8"));

function rejection(fn: () => unknown): HewError {
  try {
    fn();
  } catch (error) {
    if (error instanceof HewError) return error;
    throw error;
  }
  throw new Error("거부되어야 합니다");
}

const submitScenarios = (dir: string, doc: unknown = buildScenarios(), withdraw?: string[]) =>
  submitArtifact({ runDir: dir, kind: "scenarios", file: writeItemsFile(dir, "sc-in.json", doc), withdraw });

/** 분석의 열린 항목을 모두 닫는 답 파일. */
const answerAnalysis = (dir: string, extra: Record<string, unknown> = {}): void =>
  writeJson(answersPath(dir), {
    answers: { "Q-1": { option: "a", at: "t" }, "Q-2": { option: "a", at: "t" }, ...extra },
    scope: { "D-1": { decision: "follow_figma", at: "t" }, "D-2": { decision: "hold", at: "t" } },
    assumptions: { "A-1": { status: "confirmed", at: "t" } },
  });

describe("submit scenarios: 통과", () => {
  it("analyzed → qa_designed, 정본의 open 은 그 문서의 열린 질문, run.open 은 분석과의 합이다", () => {
    const { dir } = setupAnalyzed();
    const before = loadRun(dir);
    expect(before).toMatchObject({ state: "analyzed", open: 5 });
    const result = submitScenarios(dir);
    expect(result).toMatchObject({ attempt: 1, previous_state: "analyzed", state: "qa_designed", open: 6 });
    expect(result.warnings.map((w) => w.code)).toEqual(["accounts_unavailable"]);

    const doc = readScenarios(dir);
    expect(doc.schema).toBe("hew.scenarios/1");
    expect(doc.stage).toBe("scenarios");
    expect(doc.open).toEqual(["Q-3"]);
    expect(ScenarioItemsSchema.safeParse(doc.items).success).toBe(true);
    expect(JSON.parse(readFileSync(runPaths(dir).analysis, "utf8")).open).toEqual(["Q-1", "Q-2", "D-1", "D-2", "A-1"]);

    const run = loadRun(dir);
    expect(run.state).toBe("qa_designed");
    expect(run.open).toBe(6);
    expect(run.revision).not.toBe(before.revision);
    expect(run.submissions.scenarios?.attempt).toBe(1);
    const events = readEvents(runPaths(dir).events).filter((e) => e.type === "artifact_submitted");
    expect(events.at(-1)?.data).toMatchObject({ kind: "scenarios", from: "analyzed", to: "qa_designed", row: 3 });
  });

  it("질문에 답이 있으면 scenarios 의 열린 항목에서 빠진다", () => {
    const { dir } = setupAnalyzed();
    writeJson(answersPath(dir), { answers: { "Q-3": { option: "b", at: "t" } } });
    const result = submitScenarios(dir);
    expect(result.open).toBe(5);
    expect(readScenarios(dir).open).toEqual([]);
  });

  it("collectRunOpen 은 분석, 시나리오 순으로 열린 항목 id 를 모은다", () => {
    const { dir } = setupAnalyzed();
    submitScenarios(dir);
    expect(collectRunOpen(dir)).toEqual(["Q-1", "Q-2", "D-1", "D-2", "A-1", "Q-3"]);
  });

  it("질문의 answer 는 버리고 알 수 없는 칸은 떨어뜨려 경고한다", () => {
    const { dir } = setupAnalyzed();
    const doc = clone(buildScenarios());
    doc.questions[0].answer = { option: "a" };
    doc.scenarios[0].selector = "#btn";
    const result = submitScenarios(dir, doc);
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain("human_field_ignored");
    expect(codes).toContain("unknown_field_dropped");
    expect(readScenarios(dir).items.questions[0]).not.toHaveProperty("answer");
    expect(readScenarios(dir).items.scenarios[0]).not.toHaveProperty("selector");
    expect(result.open).toBe(6);
  });

  it("answers.json 의 시나리오 backend 로 바꾼 값을 실제 값으로 보고 검사한다", () => {
    const { dir } = setupAnalyzed();
    const doc = clone(buildScenarios());
    doc.scenarios[2].mock = { endpoints: [], reason: "" };
    doc.scenarios[2].environment = "dev";
    const err = rejection(() => submitScenarios(dir, doc));
    expect(err.issues.map((i) => i.code)).toEqual(["mock_without_reason", "mock_without_reason"]);

    writeJson(answersPath(dir), { scenarios: { "시나리오-3": { backend: "real", at: "t" } } });
    const result = submitScenarios(dir, doc);
    expect(result.state).toBe("qa_designed");
    expect(result.warnings.map((w) => w.code)).not.toContain("mock_without_reason");
    // 사람의 선택은 정본 본문에 섞이지 않는다.
    expect(readScenarios(dir).items.scenarios[2].backend).toBe("mock");
  });
});

describe("submit scenarios: 거부와 상태", () => {
  it("거부면 정본·상태·run.open·revision 이 그대로이고 이벤트만 남는다", () => {
    const { dir } = setupAnalyzed();
    const before = loadRun(dir);
    const doc = clone(buildScenarios());
    doc.scenarios[0].expected = [];
    const err = rejection(() => submitScenarios(dir, doc));
    expect(err.exitCode).toBe(3);
    expect(err.issues.map((i) => i.code)).toEqual(["expected_empty"]);
    expect(existsSync(runPaths(dir).scenarios)).toBe(false);
    const after = loadRun(dir);
    expect(after.state).toBe("analyzed");
    expect(after.open).toBe(5);
    expect(after.revision).toBe(before.revision);
    expect(after.submissions.scenarios).toBeUndefined();
    expect(readEvents(runPaths(dir).events).some((e) => e.type === "artifact_rejected")).toBe(true);
  });

  it("스키마가 틀리면 거부한다", () => {
    const { dir } = setupAnalyzed();
    const err = rejection(() => submitScenarios(dir, { scenarios: "없음" }));
    expect(err.issues.map((i) => i.code)).toContain("schema_invalid");
  });

  it("collected 에서는 받지 않는다(종료 4)", () => {
    const { dir } = setupRun({ state: "collected" });
    const err = rejection(() => submitScenarios(dir));
    expect(err.exitCode).toBe(4);
  });

  it("정본 analysis 가 없으면 analysis_missing 으로 거부한다", () => {
    const { dir } = setupRun({ state: "analyzed" });
    const err = rejection(() => submitScenarios(dir));
    expect(err.issues.map((i) => i.code)).toEqual(["analysis_missing"]);
    expect(loadRun(dir).state).toBe("analyzed");
  });
});

describe("submit: 열린 항목 합산과 answers_complete", () => {
  /** 분석·시나리오가 한 번씩 들어가고 사람의 답이 다 들어온 answers_complete 실행. */
  function answered(extra: Record<string, unknown> = {}): string {
    const { dir } = setupAnalyzed();
    submitScenarios(dir);
    setState(dir, "answers_complete");
    answerAnalysis(dir, extra);
    return dir;
  }
  const findings = (dir: string) => submitArtifact({ runDir: dir, kind: "findings", for: "analysis", file: writeItemsFile(dir, "f.json", { findings: [] }) });
  const resubmitAnalysis = (dir: string) => {
    const doc = buildAnalysis();
    for (const r of doc.requirements) r.status = "confirmed";
    return submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "a-in.json", doc) });
  };

  it("분석이 모두 닫혀도 시나리오의 답 없는 질문이 남으면 사수 재확인 뒤 checked 로 간다", () => {
    const dir = answered();
    const a = resubmitAnalysis(dir);
    expect(a).toMatchObject({ state: "answers_complete", open: 1 });
    const s = submitScenarios(dir);
    expect(s).toMatchObject({ state: "answers_complete", open: 1 });
    expect(loadRun(dir).progress).toEqual({ analysis: true, scenarios: true, sasu: false });
    const f = findings(dir);
    expect(f.state).toBe("checked");
    expect(loadRun(dir)).toMatchObject({ open: 1, progress: { analysis: false, scenarios: false, sasu: false } });
  });

  it("시나리오의 질문에도 답이 있으면 answers_applied 로 간다", () => {
    const dir = answered({ "Q-3": { option: "b", at: "t" } });
    expect(resubmitAnalysis(dir).open).toBe(0);
    expect(submitScenarios(dir).open).toBe(0);
    expect(findings(dir)).toMatchObject({ state: "answers_applied", open: 0 });
    expect(loadRun(dir).open).toBe(0);
  });

  it("질문을 --withdraw 로 철회한 재제출은 열린 항목에서 빠진다", () => {
    const dir = answered();
    resubmitAnalysis(dir);
    const doc = clone(buildScenarios());
    doc.questions = [];
    const err = rejection(() => submitScenarios(dir, doc));
    expect(err.issues.map((i) => i.code)).toEqual(["id_removed"]);
    const result = submitScenarios(dir, doc, ["Q-3"]);
    expect(result.warnings.map((w) => w.code)).toContain("item_withdrawn");
    expect(result.warnings.map((w) => w.code)).not.toContain("withdraw_unsupported");
    expect(result.open).toBe(0);
    expect(readScenarios(dir).items.questions).toEqual([]);
  });

  it("사람의 답이 있는 질문은 철회할 수 없다", () => {
    const dir = answered({ "Q-3": { option: "b", at: "t" } });
    const doc = clone(buildScenarios());
    doc.questions = [];
    const err = rejection(() => submitScenarios(dir, doc, ["Q-3"]));
    expect(err.issues.map((i) => i.code)).toEqual(["withdraw_has_human_input"]);
  });

  it("plan·findings 제출도 run.open 을 합친 값으로 다시 맞춘다", () => {
    const { dir } = setupAnalyzed();
    submitScenarios(dir);
    expect(loadRun(dir).open).toBe(6);
    expect(findings(dir)).toMatchObject({ state: "checked", open: 6 });
  });
});

describe("hew check: scenarios", () => {
  const run = (id: string, ...rest: string[]) => hew(["--json", "check", "--run", id, ...rest]);

  function published(id: string): string {
    const { dir } = setupAnalyzed({ runId: id });
    submitScenarios(dir);
    return dir;
  }

  it("--only scenarios 는 시나리오 정본만 검사하고 아무것도 바꾸지 않는다", () => {
    const dir = published("sck-1");
    const files = [runPaths(dir).runJson, runPaths(dir).scenarios, runPaths(dir).events];
    const before = files.map((f) => readFileSync(f, "utf8"));
    const r = run("sck-1", "--only", "scenarios");
    expect(r.status).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.data).toMatchObject({ kind: "scenarios", kinds: ["scenarios"], rejects: 0 });
    expect(body.warnings.map((w: any) => w.code)).toEqual(["accounts_unavailable"]);
    expect(files.map((f) => readFileSync(f, "utf8"))).toEqual(before);
  });

  it("--only 없이 부르면 있는 정본(analysis, scenarios)을 모두 검사한다", () => {
    published("sck-2");
    const body = JSON.parse(run("sck-2").stdout);
    expect(body.data).toMatchObject({ kind: "all", kinds: ["analysis", "scenarios"] });
    expect(body.warnings.map((w: any) => w.code).sort()).toEqual(["accounts_unavailable", "mismatch_ratio"]);
  });

  it("분석 정본만 있으면 분석만 검사한다", () => {
    setupAnalyzed({ runId: "sck-3" });
    const body = JSON.parse(run("sck-3").stdout);
    expect(body.data).toMatchObject({ kind: "all", kinds: ["analysis"] });
  });

  it("--only scenarios 인데 정본이 없으면 종료 4", () => {
    setupAnalyzed({ runId: "sck-4" });
    expect(run("sck-4", "--only", "scenarios").status).toBe(4);
  });

  it("시나리오 정본이 검사를 어기면 종료 3 이고 지적 목록을 낸다", () => {
    const dir = published("sck-5");
    const doc = readScenarios(dir);
    doc.items.scenarios[0].steps = [];
    writeJson(runPaths(dir).scenarios, doc);
    const r = run("sck-5");
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout).errors.map((e: any) => e.code)).toContain("steps_empty");
    expect(run("sck-5", "--only", "analysis").status).toBe(0);
  });

  it("--only 가 analysis·scenarios 가 아니면 종료 2", () => {
    setupAnalyzed({ runId: "sck-6" });
    expect(run("sck-6", "--only", "plan").status).toBe(2);
  });
});

describe("CLI 끝에서 끝까지: init → source add·done → submit analysis → submit scenarios → status", () => {
  it("analyzed 를 거쳐 qa_designed 에 도달하고 check 가 0 이다", () => {
    const prd = join(runs.dir, "prd.md");
    writeFileSync(prd, "## 요구\n\n- 배너를 노출한다\n- 최대 5개까지 보인다\n", "utf8");
    expect(hew(["init", "--prd", PRD_URL, "--run-id", "e2e-sc"]).status).toBe(0);
    expect(hew(["source", "add", "--run", "e2e-sc", "--kind", "prd", "--ref", "123", "--file", prd]).status).toBe(0);
    expect(hew(["source", "add", "--run", "e2e-sc", "--kind", "code", "--ref", "/repo", "--base-sha", "abc"]).status).toBe(0);
    expect(hew(["--json", "source", "done", "--run", "e2e-sc"]).status).toBe(0);

    const dir = join(runs.dir, "e2e-sc");
    const units = (JSON.parse(readFileSync(runPaths(dir).units, "utf8")) as { units: { id: string }[] }).units;
    const analysis = {
      screens: [{ id: "화면-1", name: "홈", images: [], variants: [], change: "changed" }],
      requirements: [
        {
          id: "요구-1",
          title: "배너",
          screen_ids: ["화면-1"],
          changes: [{ text: "배너를 노출한다", evidence: [{ unit_id: units[0]!.id, quote: "배너를 노출한다" }] }],
          status: "confirmed",
          acceptance: [{ id: "요구-1/AC-1", when: "진입", then: "보인다", verify: { method: "qa_scenario" } }],
        },
      ],
      deltas: [],
      questions: [],
      assumptions: [],
      coverage: [{ id: "C-1", unit_ids: units.map((u) => u.id), disposition: "covered", requirement_ids: ["요구-1"] }],
      impact: {},
    };
    const submitA = hew(["--json", "submit", "analysis", "--run", "e2e-sc", "--file", writeItemsFile(dir, "analysis-in.json", analysis)]);
    expect(submitA.status).toBe(0);

    const scenarios = {
      scenarios: [
        {
          id: "시나리오-1",
          title: "홈에서 배너를 본다",
          journey: "구매자가 홈에 들어와 배너를 본다",
          requirement_ids: ["요구-1"],
          ac_ids: ["요구-1/AC-1"],
          steps: [{ n: 1, action: "앱을 열어 홈에 들어간다", screen_id: "화면-1" }],
          expected: [{ id: "시나리오-1/E-1", text: "배너가 보인다", screen_id: "화면-1" }],
          backend: "real",
          environment: "dev",
          reach: "deeplink",
        },
      ],
      accounts: [{ state: "일반 구매자", available: true }],
      questions: [],
    };
    const submitS = hew(["--json", "submit", "scenarios", "--run", "e2e-sc", "--file", writeItemsFile(dir, "scenarios-in.json", scenarios)]);
    expect(submitS.status).toBe(0);
    expect(JSON.parse(submitS.stdout).data).toMatchObject({ kind: "scenarios", previous_state: "analyzed", state: "qa_designed", open: 0 });
    expect(JSON.parse(hew(["--json", "status", "--run", "e2e-sc"]).stdout).data).toMatchObject({ state: "qa_designed", open: 0 });
    expect(hew(["--json", "check", "--run", "e2e-sc"]).status).toBe(0);
  });
});
