import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAnswers } from "../src/core/analysis/answers.js";
import { HewError } from "../src/core/errors.js";
import { readEvents } from "../src/core/events.js";
import { buildGate } from "../src/core/gate/build.js";
import { importAnswers } from "../src/core/gate/import.js";
import { buildGateModel } from "../src/core/gate/model.js";
import { collectRunOpen } from "../src/core/open.js";
import { runPaths } from "../src/core/paths.js";
import { computeRevision } from "../src/core/revision.js";
import { loadRun } from "../src/core/run.js";
import { setState, writeJson } from "./analysis-fixtures.js";
import { answerEverything, loadGateLogic, setupGateRun, writePlan } from "./gate-helpers.js";
import { useTempRunsDir } from "./helpers.js";

useTempRunsDir();
const logic = loadGateLogic();
const T1 = "2026-11-14T10:00:00.000Z";
const T2 = "2026-11-14T11:00:00.000Z";

const model = (dir: string): any => JSON.parse(JSON.stringify(buildGateModel(dir, "answer").model));

function exportFile(dir: string, doc: Record<string, unknown>, name = "export.json"): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(doc));
  return file;
}

const base = (dir: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  exported_at: T2,
  run_id: loadRun(dir).run_id,
  revision: computeRevision(dir),
  ...extra,
});

const code = (fn: () => unknown): number => {
  try {
    fn();
  } catch (e) {
    if (e instanceof HewError) return e.exitCode;
    throw e;
  }
  return 0;
};

function answering(): { dir: string } {
  const r = setupGateRun();
  buildGate({ runDir: r.dir });
  return r;
}

describe("gate import: 계정 메모", () => {
  it("계정 메모를 병합하고, 없는 id 는 건너뛰며, 더 늦은 시각만 반영한다", () => {
    const { dir } = answering();
    const first = importAnswers({ runDir: dir, file: exportFile(dir, base(dir, { accounts: { "AC-2": { note: "  계정 준비함  ", at: T1 }, "AC-9": { note: "x", at: T1 } } })) });
    expect(first.applied.accounts).toBe(1);
    expect(first.skipped).toEqual([{ section: "accounts", id: "AC-9", reason: "unknown_id" }]);
    expect(first.warnings.map((w) => w.code)).toContain("unknown_id");
    expect(loadAnswers(dir).accounts).toEqual({ "AC-2": { note: "계정 준비함", at: T1 } });

    const stale = importAnswers({ runDir: dir, file: exportFile(dir, base(dir, { accounts: { "AC-2": { note: "옛 메모", at: T1 } } }), "e2.json") });
    expect(stale.applied.accounts).toBe(0);
    expect(stale.skipped).toEqual([{ section: "accounts", id: "AC-2", reason: "stale" }]);
    expect(loadAnswers(dir).accounts["AC-2"]?.note).toBe("계정 준비함");

    const later = importAnswers({ runDir: dir, file: exportFile(dir, base(dir, { accounts: { "AC-2": { note: "없음, 모킹으로", at: T2 } } }), "e3.json") });
    expect(later.applied.accounts).toBe(1);
    expect(loadAnswers(dir).accounts["AC-2"]?.note).toBe("없음, 모킹으로");
  });

  it("계정 메모가 바뀌어도 revision 은 그대로이고 열린 항목도 늘지 않는다", () => {
    const { dir } = answering();
    const before = computeRevision(dir);
    const open = collectRunOpen(dir);
    importAnswers({ runDir: dir, file: exportFile(dir, base(dir, { accounts: { "AC-2": { note: "준비함", at: T1 } } })) });
    expect(computeRevision(dir)).toBe(before);
    expect(collectRunOpen(dir)).toEqual(open);
  });
});

describe("gate import: 답변 단계", () => {
  it("일부만 답하면 gate_answering 그대로, 열린 항목이 줄고 원본을 보관한다", () => {
    const { dir } = answering();
    const file = exportFile(dir, base(dir, { answers: { "Q-1": { option: "a", at: T1 } } }));
    const r = importAnswers({ runDir: dir, file });
    expect(r).toMatchObject({ import_no: 1, state: "gate_answering", open: 5, applied: { answers: 1 }, skipped: [] });
    expect(existsSync(join(runPaths(dir).gateImports, "import-1.json"))).toBe(true);
    expect(loadAnswers(dir).answers["Q-1"]?.question_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(loadRun(dir)).toMatchObject({ state: "gate_answering", open: 5 });
    expect(importAnswers({ runDir: dir, file: exportFile(dir, base(dir), "e2.json") }).import_no).toBe(2);
  });

  it("전부 답하면 answers_complete", () => {
    const { dir } = answering();
    const state = answerEverything(logic, model(dir));
    const file = exportFile(dir, logic.buildExport(model(dir), state, new Date(T2)));
    const r = importAnswers({ runDir: dir, file });
    expect(r).toMatchObject({ state: "answers_complete", open: 0, previous_state: "gate_answering" });
    expect(collectRunOpen(dir)).toEqual([]);
    expect(readEvents(runPaths(dir).events).at(-1)?.type).toBe("answers_imported");
  });

  it("시각이 같거나 이른 항목은 stale 로 건너뛰고, 늦은 항목은 결정과 함께 메모를 대체한다", () => {
    const { dir } = answering();
    const first = base(dir, { scope: { "D-1": { decision: "follow_figma", note: "처음", at: T1 } }, answers: { "Q-1": { option: "a", at: T1 } } });
    importAnswers({ runDir: dir, file: exportFile(dir, first) });
    const again = importAnswers({ runDir: dir, file: exportFile(dir, first, "again.json") });
    expect(again.skipped_by_reason).toEqual({ stale: 2 });
    const older = base(dir, { scope: { "D-1": { decision: "drop", at: "2026-11-14T09:00:00.000Z" } } });
    expect(importAnswers({ runDir: dir, file: exportFile(dir, older, "old.json") }).skipped).toEqual([{ section: "scope", id: "D-1", reason: "stale" }]);
    const newer = base(dir, { scope: { "D-1": { decision: "follow_prd", at: T2 } } });
    const r = importAnswers({ runDir: dir, file: exportFile(dir, newer, "new.json") });
    expect(r.applied.scope).toBe(1);
    expect(loadAnswers(dir).scope["D-1"]).toEqual({ decision: "follow_prd", at: T2 });
  });

  it("건너뛰는 사유: unknown_id(경고), invalid_decision, invalid_choice, empty_answer 등", () => {
    const { dir } = answering();
    const file = exportFile(
      dir,
      base(dir, {
        answers: { "Q-9": { option: "a", at: T1 }, "Q-1": { option: "zzz", at: T1 }, "Q-2": { text: "  ", at: T1 }, "Q-3": { option: "a", at: T1 } },
        scope: { "D-2": { decision: "follow_prd", at: T1 }, "D-9": { decision: "hold", at: T1 } },
        assumptions: { "A-1": { status: "maybe", at: T1 } },
        scenarios: { "시나리오-1": { backend: "fake", at: T1 } },
        plan_requests: [{ target: "나중에", text: "x", at: T1 }],
      }),
    );
    const r = importAnswers({ runDir: dir, file });
    expect(r.skipped_by_reason).toEqual({ unknown_id: 2, invalid_choice: 1, empty_answer: 1, invalid_decision: 1, invalid_status: 1, invalid_backend: 1, invalid_target: 1 });
    expect(r.applied.answers).toBe(1);
    expect(r.warnings.filter((w) => w.code === "unknown_id").map((w) => w.ref)).toEqual(["Q-9", "D-9"]);
  });

  it("revision 이 다르면 경고하고 답은 반영한다", () => {
    const { dir } = answering();
    const file = exportFile(dir, { ...base(dir, { answers: { "Q-1": { option: "a", at: T1 } } }), revision: "0".repeat(64) });
    const r = importAnswers({ runDir: dir, file });
    expect(r.warnings.map((w) => w.code)).toContain("revision_mismatch");
    expect(r.applied.answers).toBe(1);
  });

  it("다른 실행의 파일은 종료 3, 깨진 형식도 3, 상태가 다르면 4", () => {
    const { dir } = answering();
    expect(code(() => importAnswers({ runDir: dir, file: exportFile(dir, { ...base(dir), run_id: "다른-실행" }) }))).toBe(3);
    expect(code(() => importAnswers({ runDir: dir, file: exportFile(dir, { run_id: 1 }) }))).toBe(3);
    writeFileSync(join(dir, "bad.json"), "{");
    expect(code(() => importAnswers({ runDir: dir, file: join(dir, "bad.json") }))).toBe(3);
    setState(dir, "answers_complete");
    expect(code(() => importAnswers({ runDir: dir, file: exportFile(dir, base(dir)) }))).toBe(4);
  });

  it("질문 본문이 바뀌면 다시 답 필요가 되어 열린 항목으로 센다", () => {
    const { dir } = answering();
    const state = answerEverything(logic, model(dir));
    importAnswers({ runDir: dir, file: exportFile(dir, logic.buildExport(model(dir), state, new Date(T2))) });
    expect(loadRun(dir).state).toBe("answers_complete");
    const file = runPaths(dir).analysis;
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.items.questions[0].text = "배너를 탭하면 어디로 가나요(바뀜)";
    writeFileSync(file, JSON.stringify(doc));
    expect(collectRunOpen(dir)).toEqual(["Q-1"]);
    const m = buildGateModel(dir, "answer").model;
    expect(m.needs.filter((n) => n.kind === "reanswer").map((n) => n.ref)).toEqual(["Q-1"]);
    expect(m.head.open_ids).toEqual(["Q-1"]);
  });
});

describe("gate import: 승인 단계", () => {
  function reviewing(): { dir: string } {
    const { dir } = setupGateRun();
    const state = answerEverything(logic, model(dir));
    writeJson(runPaths(dir).answers, state);
    writePlan(dir, { tickets: [{ id: "T1", title: "[MO] 홈 / 배너", requirement_ids: ["요구-1"], sp: 2, depends_on: [], pr: "PR-1" }] });
    setState(dir, "plan_checked");
    buildGate({ runDir: dir });
    return { dir };
  }

  it("수정 요청이 있으면 answers_applied 로 돌아가고 요청이 저장된다", () => {
    const { dir } = reviewing();
    expect(loadRun(dir).state).toBe("gate_plan_review");
    const file = exportFile(dir, base(dir, { plan_requests: [{ target: "T1", text: "SP 를 줄여 주세요", at: T2 }] }));
    const r = importAnswers({ runDir: dir, file });
    expect(r).toMatchObject({ state: "answers_applied", approved: false, applied: { plan_requests: 1 } });
    expect(loadAnswers(dir).plan_requests).toEqual([{ target: "T1", text: "SP 를 줄여 주세요", at: T2 }]);
    expect(loadRun(dir).rework.plan).toBe(0);
  });

  it("현재 revision 에 대한 승인이 들어 있으면 approved, approval.json 은 source gate", () => {
    const { dir } = reviewing();
    const m = model(dir);
    const state = logic.approveState(answerEverything(logic, m), m.head.revision, T2);
    const r = importAnswers({ runDir: dir, file: exportFile(dir, logic.buildExport(m, state, new Date(T2))) });
    expect(r).toMatchObject({ approved: true, state: "approved", applied: { approvals: 1 } });
    expect(JSON.parse(readFileSync(runPaths(dir).approval, "utf8"))).toMatchObject({ revision: m.head.revision, source: "gate" });
    expect(loadRun(dir).state).toBe("approved");
  });

  it("revision 이 다른 승인은 기록하지 않고 상태는 그대로다", () => {
    const { dir } = reviewing();
    const stale = "a".repeat(64);
    const file = exportFile(dir, base(dir, { approvals: { [stale.slice(0, 12)]: { revision: stale, at: T2 } } }));
    const r = importAnswers({ runDir: dir, file });
    expect(r).toMatchObject({ approved: false, state: "gate_plan_review", applied: { approvals: 0 } });
    expect(r.skipped).toEqual([{ section: "approvals", id: stale.slice(0, 12), reason: "revision_mismatch" }]);
    expect(loadAnswers(dir).approvals).toEqual({});
  });

  it("승인 단계에서 답을 바꾸면 revision 이 달라져 이 승인은 기록되지 않는다", () => {
    const { dir } = reviewing();
    const m = model(dir);
    const file = exportFile(dir, base(dir, { scope: { "D-1": { decision: "drop", at: T2 } }, approvals: { [m.head.revision.slice(0, 12)]: { revision: m.head.revision, at: T2 } } }));
    const r = importAnswers({ runDir: dir, file });
    expect(r).toMatchObject({ approved: false, state: "gate_plan_review" });
    expect(r.skipped[0]).toMatchObject({ section: "approvals", reason: "revision_mismatch" });
  });
});
