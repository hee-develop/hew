import { describe, expect, it } from "vitest";
import { DELTA_CHOICES } from "../src/core/analysis/delta-decision.js";
import { ExportFileSchema } from "../src/core/gate/import.js";
import { buildGateModel } from "../src/core/gate/model.js";
import { collectRunOpen } from "../src/core/open.js";
import { runPaths } from "../src/core/paths.js";
import { answerEverything, loadGateLogic, setupGateRun } from "./gate-helpers.js";
import { useTempRunsDir } from "./helpers.js";
import { writeJson } from "./analysis-fixtures.js";

useTempRunsDir();
const logic = loadGateLogic();
const T1 = "2026-11-14T10:00:00.000Z";
const T2 = "2026-11-14T11:00:00.000Z";

function modelOf(dir: string): any {
  return JSON.parse(JSON.stringify(buildGateModel(dir, "answer").model));
}

describe("페이지 로직: 열린 항목", () => {
  it("답이 없으면 코어와 같은 순서로 모두 열려 있다", () => {
    const { dir } = setupGateRun();
    const model = modelOf(dir);
    expect(logic.computeOpen(model, logic.emptyState()).all).toEqual(collectRunOpen(dir));
  });

  it("답을 채울수록 코어의 열린 항목 계산과 같은 결과가 된다", () => {
    const { dir } = setupGateRun();
    const model = modelOf(dir);
    let state = logic.emptyState();
    const q1 = model.questions[0];
    state = logic.setAnswer(state, q1, { option: "a" }, T1);
    state = logic.setDecision(state, model.rules, { id: "D-1", kind: "mismatch" }, "hold", T1);
    state = logic.setAssumption(state, "A-1", "rejected", T1);
    writeJson(runPaths(dir).answers, state);
    expect(logic.computeOpen(model, state).all).toEqual(collectRunOpen(dir));
    expect(collectRunOpen(dir)).toEqual(["Q-2", "D-2", "Q-3"]);
  });

  it("종류에 맞지 않는 결정은 닫지 못하고, 허용 표는 코어의 표다", () => {
    const { dir } = setupGateRun();
    const model = modelOf(dir);
    expect(model.rules.delta_choices).toEqual(JSON.parse(JSON.stringify(DELTA_CHOICES)));
    const state = logic.setDecision(logic.emptyState(), model.rules, { id: "D-2", kind: "figma_only" }, "follow_prd", T1);
    expect(state.scope).toEqual({});
    const forced = { ...logic.emptyState(), scope: { "D-2": { decision: "follow_prd", at: T1 } } };
    writeJson(runPaths(dir).answers, forced);
    expect(logic.computeOpen(model, forced).deltas).toContain("D-2");
    expect(collectRunOpen(dir)).toContain("D-2");
  });

  it("본문 해시가 다른 답은 다시 답 필요이고 열린 항목이다(코어와 같다)", () => {
    const { dir } = setupGateRun();
    const model = modelOf(dir);
    const state = { ...logic.emptyState(), answers: { "Q-1": { option: "a", question_hash: "옛 해시", at: T1 } } };
    writeJson(runPaths(dir).answers, state);
    const open = logic.computeOpen(model, state);
    expect(open.reanswer).toEqual(["Q-1"]);
    expect(open.all).toContain("Q-1");
    expect(collectRunOpen(dir)).toContain("Q-1");
    const fixed = logic.setAnswer(state, model.questions[0], { option: "a" }, T2);
    expect(logic.computeOpen(model, fixed).reanswer).toEqual([]);
  });
});

describe("페이지 로직: 결정과 메모", () => {
  const rules = { delta_choices: JSON.parse(JSON.stringify(DELTA_CHOICES)) };
  const delta = { id: "D-1", kind: "mismatch" };

  it("결정을 바꾸면 메모가 지워지고, 같은 결정을 다시 눌러도 그대로다", () => {
    let s = logic.setDecision(logic.emptyState(), rules, delta, "follow_figma", T1);
    s = logic.setDecisionNote(s, "D-1", "x".repeat(600), T1);
    expect(s.scope["D-1"].note).toHaveLength(500);
    expect(logic.setDecision(s, rules, delta, "follow_figma", T2)).toBe(s);
    const changed = logic.setDecision(s, rules, delta, "follow_prd", T2);
    expect(changed.scope["D-1"]).toEqual({ decision: "follow_prd", at: T2 });
  });

  it("답을 모두 지우면 항목이 사라진다", () => {
    const q = { id: "Q-1", hash: "h" };
    let s = logic.setAnswer(logic.emptyState(), q, { option: "a", text: " 메모 " }, T1);
    expect(s.answers["Q-1"]).toEqual({ option: "a", text: "메모", question_hash: "h", at: T1 });
    s = logic.setAnswer(s, q, { option: "" }, T2);
    expect(s.answers["Q-1"].option).toBeUndefined();
    s = logic.setAnswer(s, q, { text: "" }, T2);
    expect(s.answers["Q-1"]).toBeUndefined();
  });

  it("시나리오 서버는 바꿨을 때만 기록한다", () => {
    const sc = { id: "시나리오-1", backend: "real" };
    const same = logic.setScenarioBackend(logic.emptyState(), sc, "real", T1);
    expect(same.scenarios).toEqual({});
    const mock = logic.setScenarioBackend(same, sc, "mock", T1);
    expect(mock.scenarios["시나리오-1"]).toEqual({ backend: "mock", at: T1 });
    expect(logic.effectiveBackend(sc, mock)).toBe("mock");
  });
});

describe("페이지 로직: 비슷한 차이에 같은 결정", () => {
  const rules = { delta_choices: JSON.parse(JSON.stringify(DELTA_CHOICES)) };
  const d1 = { id: "D-1", kind: "mismatch", similar_ids: ["D-3", "D-4"] };
  const d3 = { id: "D-3", kind: "mismatch", similar_ids: ["D-1"] };
  const d4 = { id: "D-4", kind: "figma_only", similar_ids: ["D-1"] };
  const model = { screens: [{ requirements: [{ deltas: [d3, d1] }] }], unbound_requirements: [], unbound_deltas: [d4] };

  it("모델에서 비슷한 차이만 id 순서로 꺼낸다", () => {
    expect(logic.similarDeltas(model, d1).map((d: any) => d.id)).toEqual(["D-3", "D-4"]);
    expect(logic.similarDeltas(model, { id: "D-9", similar_ids: [] })).toEqual([]);
  });

  it("같은 결정을 같은 시각으로 적용하고, 그 종류에 허용되지 않는 결정은 건너뛴다", () => {
    const similar = logic.similarDeltas(model, d1);
    const s = logic.setDecisionWithSimilar(logic.emptyState(), rules, d1, "follow_prd", similar, T1);
    expect(s.scope["D-1"]).toEqual({ decision: "follow_prd", at: T1 });
    expect(s.scope["D-3"]).toEqual({ decision: "follow_prd", at: T1, from: "D-1" });
    expect(s.scope["D-4"]).toBeUndefined();
    const ok = logic.setDecisionWithSimilar(logic.emptyState(), rules, d1, "follow_figma", similar, T1);
    expect(ok.scope["D-4"]).toEqual({ decision: "follow_figma", at: T1, from: "D-1" });
  });

  it("자기 종류에 허용되지 않는 결정이면 아무것도 바꾸지 않는다", () => {
    const s = logic.emptyState();
    expect(logic.setDecisionWithSimilar(s, rules, d4, "follow_prd", [d1], T1)).toBe(s);
  });

  it("이미 같은 결정이면 그대로 둔다. 따로 결정을 바꾸면 적용됨 표시가 사라진다", () => {
    const similar = logic.similarDeltas(model, d1);
    const s = logic.setDecisionWithSimilar(logic.emptyState(), rules, d1, "follow_prd", similar, T1);
    expect(logic.setDecisionWithSimilar(s, rules, d1, "follow_prd", similar, T2)).toBe(s);
    const changed = logic.setDecision(s, rules, d3, "drop", T2);
    expect(changed.scope["D-3"]).toEqual({ decision: "drop", at: T2 });
  });

  it("적용된 결정도 내보내기에는 결정·시각만 담겨 import 스키마를 통과한다", () => {
    const { dir } = setupGateRun();
    const m = modelOf(dir);
    const state = { ...logic.emptyState(), scope: { "D-1": { decision: "follow_figma", at: T1, from: "D-9", note: "메모" } } };
    const exp = logic.buildExport(m, state, new Date(T2));
    expect(exp.scope["D-1"]).toEqual({ decision: "follow_figma", at: T1, note: "메모" });
    expect(ExportFileSchema.safeParse(exp).success).toBe(true);
  });
});

describe("페이지 로직: 합치기와 내보내기", () => {
  it("항목마다 시각이 늦은 쪽을 쓰고 수정 요청은 합친다", () => {
    const base = { answers: { "Q-1": { option: "a", at: T2 }, "Q-2": { option: "a", at: T1 } }, plan_requests: [{ target: "전체", text: "x", at: T1 }] };
    const local = { answers: { "Q-1": { option: "b", at: T1 }, "Q-2": { option: "b", at: T2 } }, plan_requests: [{ target: "전체", text: "x", at: T1 }, { target: "T1", text: "y", at: T2 }] };
    const merged = logic.mergeStates(base, local);
    expect(merged.answers["Q-1"].option).toBe("a");
    expect(merged.answers["Q-2"].option).toBe("b");
    expect(merged.plan_requests).toHaveLength(2);
  });

  it("내보내기 JSON 이 import 스키마를 통과하고 승인은 현재 revision 만 담는다", () => {
    const { dir } = setupGateRun();
    const model = modelOf(dir);
    let state = answerEverything(logic, model);
    state = logic.addPlanRequest(state, "전체", "  티켓을 더 쪼개 주세요 ", T2);
    state = logic.approveState(state, model.head.revision, T2);
    state = logic.approveState(state, "f".repeat(64), T2);
    const exp = logic.buildExport(model, state, new Date(T2));
    expect(ExportFileSchema.safeParse(exp).success).toBe(true);
    expect(exp).toMatchObject({ exported_at: T2, run_id: model.head.run_id, revision: model.head.revision });
    expect(Object.keys(exp.approvals)).toEqual([model.head.revision.slice(0, 12)]);
    expect(exp.plan_requests).toEqual([{ target: "전체", text: "티켓을 더 쪼개 주세요", at: T2 }]);
    expect(Object.keys(exp.answers)).toEqual(["Q-1", "Q-2", "Q-3"]);
  });

  it("승인 버튼은 승인 단계에서 열린 항목이 0일 때만 켜진다", () => {
    const { dir } = setupGateRun();
    const answerModel = modelOf(dir);
    const full = answerEverything(logic, answerModel);
    expect(logic.canApprove(answerModel, full)).toBe(false);
    const approve = { ...answerModel, head: { ...answerModel.head, phase: "approve" } };
    expect(logic.canApprove(approve, logic.emptyState())).toBe(false);
    expect(logic.canApprove(approve, full)).toBe(true);
    expect(logic.canApprove({ ...approve, head: { ...approve.head, approved: true } }, full)).toBe(false);
  });

  it("분해안 티켓을 의존 순서의 층으로 나눈다", () => {
    const layers = logic.planLayers([
      { id: "T2", depends_on: ["T1"] },
      { id: "T1", depends_on: [] },
      { id: "T3", depends_on: ["T1", "T2"] },
    ]);
    expect(layers.map((l: { id: string }[]) => l.map((t) => t.id))).toEqual([["T1"], ["T2"], ["T3"]]);
  });

  it("저장 키에 실행 id 와 revision 이 들어간다", () => {
    expect(logic.storageKey({ head: { run_id: "r1", revision: "abc" } })).toBe("hew-gate:r1:abc");
  });
});
