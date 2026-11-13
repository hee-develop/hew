import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnalysisItemsSchema } from "../src/core/analysis/schema.js";
import { HewError } from "../src/core/errors.js";
import { readEvents } from "../src/core/events.js";
import { HEW_ROOT, runPaths } from "../src/core/paths.js";
import { PlanItemsSchema } from "../src/core/plan/schema.js";
import { computeRevision } from "../src/core/revision.js";
import { loadRun, saveRun } from "../src/core/run.js";
import { submitArtifact } from "../src/core/submit.js";
import { answersPath, setupRun, writeJson, type Doc } from "./analysis-fixtures.js";
import { useTempRunsDir, writeItemsFile } from "./helpers.js";
import { buildPlan, clone, setupAnswersApplied, submitPlan } from "./plan-fixtures.js";
import { exampleUnits, EXAMPLE_DOC } from "./runner-helpers.js";
import { EXAMPLE_SCENARIOS } from "./gate-helpers.js";

const runs = useTempRunsDir();
const BIN = join(import.meta.dirname, "..", "bin", "hew");
const hew = (args: string[]) => spawnSync(BIN, ["--json", ...args], { env: { ...process.env, HEW_RUNS_DIR: runs.dir }, encoding: "utf8" });
const EXAMPLE_PLAN = join(HEW_ROOT, "refs", "plan.example.json");
const EXAMPLE_ANSWERS = join(HEW_ROOT, "refs", "answers.example.json");

const fail = (fn: () => unknown): HewError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof HewError) return error;
    throw error;
  }
  throw new Error("오류가 나야 합니다");
};

describe("plan 제출: answers_applied → planned", () => {
  it("통과하면 정본·상태·revision·이벤트가 바뀐다", () => {
    const { dir } = setupAnswersApplied();
    const before = computeRevision(dir);
    const r = submitPlan(dir);
    expect(r).toMatchObject({ kind: "plan", attempt: 1, previous_state: "answers_applied", state: "planned", open: 0, warnings: [] });
    expect(r.revision).not.toBe(before);
    const doc = JSON.parse(readFileSync(runPaths(dir).plan, "utf8"));
    expect(doc).toMatchObject({ schema: "hew.plan/1", stage: "plan", attempt: 1, open: [], verdict: { status: "pass", reasons: [] } });
    expect(doc.items.tickets).toHaveLength(5);
    expect(loadRun(dir)).toMatchObject({ state: "planned", revision: r.revision, rework: { analysis: 0, plan: 0 } });
    expect(readEvents(runPaths(dir).events).at(-1)).toMatchObject({ type: "artifact_submitted", data: { kind: "plan", from: "answers_applied", to: "planned", row: 11 } });
  });

  it("거부되면 정본·상태·revision 이 그대로이고 거부 이벤트가 남는다", () => {
    const { dir } = setupAnswersApplied();
    const run = loadRun(dir);
    const revision = computeRevision(dir);
    const doc = clone(buildPlan());
    doc.tickets[0].title = "배너 노출 / 영역";
    const err = fail(() => submitPlan(dir, doc));
    expect(err.exitCode).toBe(3);
    expect(err.issues.map((i) => i.code)).toEqual(["title_format"]);
    expect(loadRun(dir)).toEqual(run);
    expect(computeRevision(dir)).toBe(revision);
    expect(() => readFileSync(runPaths(dir).plan, "utf8")).toThrow();
    expect(readEvents(runPaths(dir).events).at(-1)).toMatchObject({ type: "artifact_rejected", data: { kind: "plan" } });
  });

  it("알 수 없는 키는 버리고 경고하며, 경고는 verdict.reasons 에 남는다", () => {
    const { dir } = setupAnswersApplied();
    const doc = clone(buildPlan());
    doc.memo = "x";
    doc.tickets[0].sp = 6;
    const r = submitPlan(dir, doc);
    expect(r.warnings.map((w) => w.code).sort()).toEqual(["sp_range", "unknown_field_dropped"]);
    const stored = JSON.parse(readFileSync(runPaths(dir).plan, "utf8"));
    expect(stored.items.memo).toBeUndefined();
    expect(stored.verdict.reasons.sort()).toEqual(["sp_range", "unknown_field_dropped"]);
  });

  it("--withdraw 는 plan 에서 처리하지 않는다는 경고를 낸다", () => {
    const { dir } = setupAnswersApplied();
    const r = submitArtifact({ runDir: dir, kind: "plan", file: writeItemsFile(dir, "p.json", buildPlan()), withdraw: ["T1"] });
    expect(r.warnings.map((w) => w.code)).toEqual(["withdraw_unsupported"]);
  });

  it("answers_applied 가 아니면 종료 4 이고 아무것도 바뀌지 않는다", () => {
    const { dir } = setupAnswersApplied();
    for (const state of ["collected", "qa_designed", "checked", "gate_answering", "planned", "plan_checked"] as const) {
      saveRun(dir, { ...loadRun(dir), state });
      const before = readFileSync(runPaths(dir).runJson, "utf8");
      expect(fail(() => submitPlan(dir)).exitCode).toBe(4);
      expect(readFileSync(runPaths(dir).runJson, "utf8")).toBe(before);
    }
  });

  it("재제출은 같은 정본을 덮고 attempt 가 늘어난다(반송 뒤)", () => {
    const { dir } = setupAnswersApplied();
    submitPlan(dir);
    saveRun(dir, { ...loadRun(dir), state: "answers_applied", rework: { analysis: 0, plan: 1 } });
    const doc = clone(buildPlan());
    doc.tickets[3].body.work.push("원가 줄을 그리지 않는다");
    const r = submitPlan(dir, doc);
    expect(r).toMatchObject({ attempt: 2, state: "planned" });
    expect(JSON.parse(readFileSync(runPaths(dir).plan, "utf8")).items.tickets[3].body.work).toHaveLength(2);
  });

  it("plan 정본이 revision 에 들어가 분해안을 고치면 revision 이 달라진다", () => {
    const { dir } = setupAnswersApplied();
    const first = submitPlan(dir).revision;
    saveRun(dir, { ...loadRun(dir), state: "answers_applied" });
    const doc = clone(buildPlan());
    doc.tickets[0].sp = 4;
    expect(submitPlan(dir, doc).revision).not.toBe(first);
  });

  it("hew submit plan 과 hew check --only plan(CLI)", () => {
    const { dir } = setupAnswersApplied();
    const id = loadRun(dir).run_id;
    const file = writeItemsFile(dir, "p.json", buildPlan());
    expect(hew(["check", "--run", id, "--only", "plan"]).status).toBe(4);
    const r = hew(["submit", "plan", "--run", id, "--file", file]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).data).toMatchObject({ kind: "plan", state: "planned" });
    const ok = hew(["check", "--run", id, "--only", "plan"]);
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).data).toMatchObject({ kinds: ["plan"], rejects: 0 });
    // 정본을 망가뜨리면 check 가 거부 지적으로 종료 3.
    const stored = JSON.parse(readFileSync(runPaths(dir).plan, "utf8"));
    stored.items.tickets[0].title = "제목";
    writeFileSync(runPaths(dir).plan, JSON.stringify(stored));
    const bad = hew(["check", "--run", id, "--only", "plan"]);
    expect(bad.status).toBe(3);
    expect(JSON.parse(bad.stdout).errors.map((e: any) => e.code)).toContain("title_format");
    // --only 를 주지 않으면 있는 정본을 모두 검사한다.
    expect(JSON.parse(hew(["check", "--run", id]).stdout).errors.map((e: any) => e.code)).toContain("title_format");
  });
});

describe("형식 안내 예시(refs/): 분해안", () => {
  const items = (): Doc => JSON.parse(readFileSync(EXAMPLE_PLAN, "utf8")) as Doc;

  function setupExample(): { dir: string } {
    const { dir } = setupRun({ units: exampleUnits() });
    submitArtifact({ runDir: dir, kind: "analysis", file: EXAMPLE_DOC });
    submitArtifact({ runDir: dir, kind: "scenarios", file: EXAMPLE_SCENARIOS });
    writeJson(answersPath(dir), JSON.parse(readFileSync(EXAMPLE_ANSWERS, "utf8")));
    saveRun(dir, { ...loadRun(dir), state: "answers_applied", open: 0 });
    return { dir };
  }

  it("예시 분해안이 스키마를 통과하고 알 수 없는 키가 없다", () => {
    expect(PlanItemsSchema.safeParse(items()).success).toBe(true);
    const keys = new Set(Object.keys(items()));
    for (const k of keys) expect(["epic_name", "parent", "tickets", "prs", "feature_flag", "excluded"]).toContain(k);
  });

  it("예시 분해안이 예시 분석·시나리오·답과 함께 결정적 검사를 통과해 제출된다(거부 0, 경고 없음)", () => {
    const { dir } = setupExample();
    const r = submitArtifact({ runDir: dir, kind: "plan", file: EXAMPLE_PLAN });
    expect(r).toMatchObject({ state: "planned", previous_state: "answers_applied" });
    expect(r.warnings).toEqual([]);
  });

  it("예시 답은 분석의 모든 질문·차이·가정에 답한 것이고 요구-2 가 범위 밖이다", () => {
    const analysis = AnalysisItemsSchema.parse(JSON.parse(readFileSync(EXAMPLE_DOC, "utf8")));
    const answers = JSON.parse(readFileSync(EXAMPLE_ANSWERS, "utf8"));
    for (const q of analysis.questions) expect(answers.answers[q.id]).toBeDefined();
    for (const d of analysis.deltas) expect(answers.scope[d.id]).toBeDefined();
    for (const a of analysis.assumptions) expect(answers.assumptions[a.id]).toBeDefined();
    expect(answers.scope["D-1"].decision).toBe("hold");
    expect(items().excluded[0]).toMatchObject({ kind: "delta", ref: "D-1" });
  });

  it("예시 분해안은 형식 안내가 말하는 칸을 모두 보인다", () => {
    const doc = items();
    for (const key of ["epic_name", "parent", "tickets", "prs", "feature_flag", "excluded"]) expect(doc).toHaveProperty(key);
    const bodyKeys = new Set(doc.tickets.flatMap((t: Doc) => Object.keys(t.body)));
    for (const key of ["background", "work", "checks", "depends_note", "refs", "tracker_events"]) expect(bodyKeys).toContain(key);
    expect(doc.tickets.some((t: Doc) => t.changes?.length > 0)).toBe(true);
  });

  it("형식 안내는 모든 거부 코드를 설명한다", () => {
    const text = readFileSync(join(HEW_ROOT, "refs", "plan-format.md"), "utf8");
    const codes = [
      "requirement_unmapped", "ticket_orphan", "hold_included", "title_format", "body_sections", "body_code_detail", "dependency_cycle", "plan_ref_missing",
      "pr_base_order", "ticket_without_pr", "pr_ticket_mismatch", "flag_removal_last", "requirement_dependency_broken", "id_format", "id_duplicate",
      "sp_range", "pr_too_large", "excluded_missing", "plan_change_unaddressed",
    ];
    for (const code of codes) expect(text, code).toContain(code);
  });
});
