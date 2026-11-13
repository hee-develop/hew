import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAnswers } from "../src/core/analysis/answers.js";
import { computeOpenItems } from "../src/core/analysis/open-items.js";
import { AnalysisItemsSchema } from "../src/core/analysis/schema.js";
import { HewError } from "../src/core/errors.js";
import { readEvents } from "../src/core/events.js";
import { runPaths } from "../src/core/paths.js";
import { computeRevision } from "../src/core/revision.js";
import { loadRun } from "../src/core/run.js";
import { submitArtifact } from "../src/core/submit.js";
import { answersPath, buildAnalysis, clone, setState, setupRun, writeJson, type Doc } from "./analysis-fixtures.js";
import { PRD_URL, useTempRunsDir, writeItemsFile } from "./helpers.js";

const runs = useTempRunsDir();
const BIN = join(import.meta.dirname, "..", "bin", "hew");

const hew = (args: string[]) => spawnSync(BIN, args, { env: { ...process.env, HEW_RUNS_DIR: runs.dir }, encoding: "utf8" });
const readDoc = (dir: string): Doc => JSON.parse(readFileSync(runPaths(dir).analysis, "utf8"));

function rejection(fn: () => unknown): HewError {
  try {
    fn();
  } catch (error) {
    if (error instanceof HewError) return error;
    throw error;
  }
  throw new Error("거부되어야 합니다");
}

describe("submit analysis: 통과", () => {
  it("collected → analyzed, 정본의 사람의 칸은 비어 있고 open 은 열린 항목 id 목록이다", () => {
    const { dir } = setupRun();
    const before = loadRun(dir).revision;
    const file = writeItemsFile(dir, "in.json", buildAnalysis());
    const result = submitArtifact({ runDir: dir, kind: "analysis", file });
    expect(result).toMatchObject({ attempt: 1, previous_state: "collected", state: "analyzed", open: 5 });
    expect(result.warnings.map((w) => w.code)).toEqual(["mismatch_ratio"]);
    expect(result.warnings[0]?.severity).toBe("info");

    const doc = readDoc(dir);
    expect(doc.schema).toBe("hew.analysis/1");
    expect(doc.open).toEqual(["Q-1", "Q-2", "D-1", "D-2", "A-1"]);
    expect(doc.verdict.reasons).toEqual(["mismatch_ratio"]);
    for (const d of doc.items.deltas) expect(d).not.toHaveProperty("decision");
    for (const q of doc.items.questions) expect(q).not.toHaveProperty("answer");
    for (const a of doc.items.assumptions) expect(a).not.toHaveProperty("status");

    const run = loadRun(dir);
    expect(run.state).toBe("analyzed");
    expect(run.open).toBe(5);
    expect(run.revision).toBe(computeRevision(dir));
    expect(run.revision).not.toBe(before);
    const events = readEvents(runPaths(dir).events).filter((e) => e.type === "artifact_submitted");
    expect(events[0]?.data).toMatchObject({ kind: "analysis", from: "collected", to: "analyzed", row: 2 });
  });

  it("정본 items 는 스키마를 다시 통과한다", () => {
    const { dir } = setupRun();
    submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "in.json", buildAnalysis()) });
    expect(AnalysisItemsSchema.safeParse(readDoc(dir).items).success).toBe(true);
  });
});

describe("submit analysis: 거부", () => {
  it("거부면 정본·상태·revision 이 그대로이고 이벤트만 남는다", () => {
    const { dir } = setupRun();
    const before = loadRun(dir);
    const doc = buildAnalysis();
    doc.requirements[0].changes[0].evidence[0].quote = "없는 문장";
    const err = rejection(() => submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "in.json", doc) }));
    expect(err.exitCode).toBe(3);
    expect(err.issues.map((i) => i.code)).toEqual(["quote_not_found"]);
    expect(existsSync(runPaths(dir).analysis)).toBe(false);
    const after = loadRun(dir);
    expect(after.state).toBe("collected");
    expect(after.revision).toBe(before.revision);
    expect(after.submissions.analysis).toBeUndefined();
    expect(readEvents(runPaths(dir).events).some((e) => e.type === "artifact_rejected")).toBe(true);
  });

  it("스키마 위반은 schema_invalid 로 거부한다", () => {
    const { dir } = setupRun();
    const err = rejection(() => submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "in.json", { screens: [] }) }));
    expect(err.issues.every((i) => i.code === "schema_invalid")).toBe(true);
    expect(loadRun(dir).state).toBe("collected");
  });
});

describe("submit analysis: 손질 경고", () => {
  it("human_field_ignored: 사람의 칸 값은 버려지고 경고가 난다", () => {
    const { dir } = setupRun();
    const doc = buildAnalysis();
    doc.deltas[0].decision = "follow_figma";
    doc.questions[0].answer = "a";
    doc.assumptions[0].status = "confirmed";
    const result = submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "in.json", doc) });
    const ignored = result.warnings.filter((w) => w.code === "human_field_ignored");
    expect(ignored.map((w) => w.ref).sort()).toEqual(["A-1", "D-1", "Q-1"]);
    expect(ignored.every((w) => w.severity === "warn")).toBe(true);
    expect(result.open).toBe(5);
    const saved = readDoc(dir);
    expect(saved.items.deltas[0]).not.toHaveProperty("decision");
    expect(saved.items.questions[0]).not.toHaveProperty("answer");
    expect(saved.items.assumptions[0]).not.toHaveProperty("status");
  });

  it("unknown_field_dropped: 알 수 없는 키는 거부하지 않고 떨어뜨리며 어느 항목의 어느 키인지 알린다", () => {
    const { dir } = setupRun();
    const doc = buildAnalysis();
    doc.requirements[0].extra = 1;
    doc.requirements[0].changes[0].memo = "x";
    doc.stray = [];
    const result = submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "in.json", doc) });
    const dropped = result.warnings.filter((w) => w.code === "unknown_field_dropped");
    expect(dropped).toHaveLength(3);
    expect(dropped.filter((w) => w.ref === "요구-1").map((w) => w.message).join("\n")).toContain("extra");
    expect(dropped.some((w) => w.ref === "요구-1" && w.message.includes("changes[0]") && w.message.includes("memo"))).toBe(true);
    expect(dropped.some((w) => w.ref === null && w.message.includes("stray"))).toBe(true);
    const saved = readDoc(dir);
    expect(saved.items.requirements[0]).not.toHaveProperty("extra");
    expect(saved.items).not.toHaveProperty("stray");
  });
});

describe("answers.json 과 열린 항목", () => {
  it("파일이 없으면 모두 빈 것으로 본다", () => {
    const { dir } = setupRun();
    expect(loadAnswers(dir)).toEqual({ answers: {}, scope: {}, assumptions: {}, scenarios: {}, plan_requests: [], approvals: {} });
  });

  it("답이 있으면 열린 항목이 줄고, hold 는 결정이며, 허용되지 않는 값은 결정 안 됨이다", () => {
    const { dir } = setupRun();
    writeJson(answersPath(dir), {
      answers: { "Q-1": { option: "a", at: "t" } },
      scope: { "D-1": { decision: "hold", at: "t" }, "D-2": { decision: "follow_prd", at: "t" } },
      assumptions: { "A-1": { status: "confirmed", at: "t" } },
    });
    const items = AnalysisItemsSchema.parse(buildAnalysis());
    expect(computeOpenItems(items, loadAnswers(dir))).toEqual({ questions: ["Q-2"], deltas: ["D-2"], assumptions: [] });

    const result = submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "in.json", buildAnalysis()) });
    expect(result.open).toBe(2);
    expect(readDoc(dir).open).toEqual(["Q-2", "D-2"]);
    expect(result.warnings.find((w) => w.code === "delta_decision_kind")).toMatchObject({ severity: "warn", ref: "D-2" });
    // 사람의 답은 정본 본문에 섞이지 않는다.
    expect(JSON.stringify(readDoc(dir).items)).not.toContain("hold");
  });

  it("빈 답(공백 자유 답)은 답으로 치지 않는다", () => {
    const { dir } = setupRun();
    writeJson(answersPath(dir), { answers: { "Q-1": { text: "  ", at: "t" } } });
    const items = AnalysisItemsSchema.parse(buildAnalysis());
    expect(computeOpenItems(items, loadAnswers(dir)).questions).toEqual(["Q-1", "Q-2"]);
  });

  it("모든 항목에 답이 있고 요구가 confirmed 이면 열린 항목 0 으로 통과한다", () => {
    const { dir } = setupRun({ state: "collected" });
    writeJson(answersPath(dir), {
      answers: { "Q-1": { option: "a", at: "t" }, "Q-2": { text: "받는다", at: "t" } },
      scope: { "D-1": { decision: "follow_figma", at: "t" }, "D-2": { decision: "drop", at: "t" } },
      assumptions: { "A-1": { status: "rejected", at: "t" } },
    });
    const doc = buildAnalysis();
    for (const r of doc.requirements) r.status = "confirmed";
    const result = submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "in.json", doc) });
    expect(result.open).toBe(0);
    expect(readDoc(dir).open).toEqual([]);
  });
});

describe("submit analysis: 게이트 게시 뒤 재제출", () => {
  function published(): string {
    const { dir } = setupRun();
    submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "first.json", buildAnalysis()) });
    setState(dir, "answers_complete");
    return dir;
  }
  const withoutD2 = (): Doc => {
    const d = clone(buildAnalysis());
    d.deltas = d.deltas.filter((x: Doc) => x.id !== "D-2");
    return d;
  };

  it("--withdraw 없이 항목이 사라지면 거부하고 정본은 그대로", () => {
    const dir = published();
    const before = readFileSync(runPaths(dir).analysis, "utf8");
    const err = rejection(() => submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "re.json", withoutD2()) }));
    expect(err.issues.map((i) => i.code)).toEqual(["id_removed"]);
    expect(readFileSync(runPaths(dir).analysis, "utf8")).toBe(before);
    expect(loadRun(dir).state).toBe("answers_complete");
  });

  it("--withdraw 로 명시하면 통과하고 withdraw_unsupported 경고는 나오지 않는다", () => {
    const dir = published();
    const result = submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "re.json", withoutD2()), withdraw: ["D-2"] });
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain("item_withdrawn");
    expect(codes).not.toContain("withdraw_unsupported");
    expect(readDoc(dir).items.deltas.map((d: Doc) => d.id)).toEqual(["D-1"]);
    expect(result.attempt).toBe(2);
  });

  it("사람 입력이 있는 항목은 철회해도 거부한다", () => {
    const dir = published();
    writeJson(answersPath(dir), { scope: { "D-2": { decision: "follow_figma", at: "t" } } });
    const err = rejection(() => submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "re.json", withoutD2()), withdraw: ["D-2"] }));
    expect(err.issues.map((i) => i.code)).toEqual(["withdraw_has_human_input"]);
  });

  it("answers_complete 에서 재제출이 열린 항목 수를 run 에 반영한다", () => {
    const dir = published();
    writeJson(answersPath(dir), {
      answers: { "Q-1": { option: "a", at: "t" }, "Q-2": { option: "a", at: "t" } },
      scope: { "D-1": { decision: "follow_figma", at: "t" }, "D-2": { decision: "hold", at: "t" } },
      assumptions: { "A-1": { status: "confirmed", at: "t" } },
    });
    const doc = buildAnalysis();
    for (const r of doc.requirements) r.status = "confirmed";
    const result = submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "re.json", doc) });
    expect(result.open).toBe(0);
    expect(loadRun(dir).progress.analysis).toBe(true);
  });
});

describe("hew check", () => {
  const run = (id: string) => hew(["--json", "check", "--run", id]);

  it("정본이 없으면 종료 4", () => {
    setupRun({ runId: "ck-0" });
    expect(run("ck-0").status).toBe(4);
  });

  it("통과하면 종료 0 이고 아무것도 바꾸지 않는다", () => {
    const { dir } = setupRun({ runId: "ck-1" });
    submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "in.json", buildAnalysis()) });
    const files = [runPaths(dir).runJson, runPaths(dir).analysis, runPaths(dir).events];
    const before = files.map((f) => readFileSync(f, "utf8"));
    const r = run("ck-1");
    expect(r.status).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.ok).toBe(true);
    expect(body.warnings.map((w: any) => w.code)).toEqual(["mismatch_ratio"]);
    expect(files.map((f) => readFileSync(f, "utf8"))).toEqual(before);
  });

  it("정본이 검사를 어기면 종료 3 이고 지적 목록을 낸다", () => {
    const { dir } = setupRun({ runId: "ck-2" });
    submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "in.json", buildAnalysis()) });
    const doc = readDoc(dir);
    doc.items.requirements[0].changes[0].evidence[0].quote = "없는 문장";
    writeJson(runPaths(dir).analysis, doc);
    const r = run("ck-2");
    expect(r.status).toBe(3);
    const body = JSON.parse(r.stdout);
    expect(body.ok).toBe(false);
    expect(body.errors.map((e: any) => e.code)).toContain("quote_not_found");
  });

  it("--only 가 analysis 가 아니면 종료 2", () => {
    setupRun({ runId: "ck-3" });
    expect(hew(["--json", "check", "--run", "ck-3", "--only", "plan"]).status).toBe(2);
  });
});

describe("CLI 끝에서 끝까지: init → source add·done → submit analysis → status → check", () => {
  it("통과하는 합성 문서로 analyzed 에 도달하고 check 가 0 이다", () => {
    const prd = join(runs.dir, "prd.md");
    writeFileSync(prd, "## 요구\n\n- 배너를 노출한다\n- 최대 5개까지 보인다\n", "utf8");
    expect(hew(["init", "--prd", PRD_URL, "--run-id", "e2e-an"]).status).toBe(0);
    expect(hew(["source", "add", "--run", "e2e-an", "--kind", "prd", "--ref", "123", "--file", prd]).status).toBe(0);
    expect(hew(["source", "add", "--run", "e2e-an", "--kind", "code", "--ref", "/repo", "--base-sha", "abc"]).status).toBe(0);
    expect(hew(["--json", "source", "done", "--run", "e2e-an"]).status).toBe(0);

    const dir = join(runs.dir, "e2e-an");
    const units = (JSON.parse(readFileSync(runPaths(dir).units, "utf8")) as { units: { id: string; text: string }[] }).units;
    expect(units.length).toBeGreaterThanOrEqual(2);
    const doc = {
      screens: [],
      requirements: [
        {
          id: "요구-1",
          title: "배너",
          screen_ids: [],
          changes: [{ text: "배너를 노출한다", evidence: [{ unit_id: units[0]!.id, quote: "배너를 노출한다" }] }],
          status: "confirmed",
          acceptance: [{ id: "요구-1/AC-1", when: "진입", then: "보인다", verify: { method: "review" } }],
        },
      ],
      deltas: [],
      questions: [],
      assumptions: [],
      coverage: [{ id: "C-1", unit_ids: units.map((u) => u.id), disposition: "covered", requirement_ids: ["요구-1"] }],
      impact: {},
    };
    const file = writeItemsFile(dir, "analysis-in.json", doc);
    const submit = hew(["--json", "submit", "analysis", "--run", "e2e-an", "--file", file]);
    expect(submit.status).toBe(0);
    expect(JSON.parse(submit.stdout).data).toMatchObject({ previous_state: "collected", state: "analyzed", open: 0 });
    expect(JSON.parse(hew(["--json", "status", "--run", "e2e-an"]).stdout).data.state).toBe("analyzed");
    expect(hew(["--json", "check", "--run", "e2e-an"]).status).toBe(0);
  });
});
