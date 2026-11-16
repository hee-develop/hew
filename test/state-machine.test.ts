import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HewError } from "../src/core/errors.js";
import { nextAction } from "../src/core/next.js";
import { runPaths } from "../src/core/paths.js";
import { loadRun } from "../src/core/run.js";
import {
  RUN_STATES,
  emptyProgress,
  transition,
  type RunState,
  type TransitionContext,
  type TransitionEvent,
} from "../src/core/state-machine.js";
import { makeRun, useTempRunsDir } from "./helpers.js";

const ctx = (patch: Partial<TransitionContext> = {}): TransitionContext => ({
  rework: { analysis: 0, plan: 0 },
  progress: emptyProgress(),
  open: 0,
  revision: "rev-1",
  ...patch,
});

function exitCodeOf(fn: () => unknown): number {
  try {
    fn();
  } catch (error) {
    if (error instanceof HewError) return error.exitCode;
    throw error;
  }
  return 0;
}

describe("전이 표의 각 줄", () => {
  it("1줄: init + 필수 원천 등록 -> collected", () => {
    const r = transition("init", { type: "sources_complete" }, ctx());
    expect(r).toMatchObject({ state: "collected", row: 1 });
  });

  it("2줄: collected + analysis 제출 통과 -> analyzed", () => {
    const r = transition("collected", { type: "analysis_accepted", open: 3 }, ctx());
    expect(r).toMatchObject({ state: "analyzed", row: 2, changes: { open: 3 } });
  });

  it("3줄: analyzed + 분석 findings, 차단 0건 -> vetted", () => {
    const r = transition("analyzed", { type: "findings_complete", for: "analysis", blocking: 0 }, ctx());
    expect(r).toMatchObject({ state: "vetted", row: 3 });
  });

  it("3줄: 차단이 있어도 반송 2회를 채웠으면 vetted", () => {
    const r = transition("analyzed", { type: "findings_complete", for: "analysis", blocking: 3 }, ctx({ rework: { analysis: 2, plan: 0 } }));
    expect(r).toMatchObject({ state: "vetted", row: 3 });
  });

  it("4줄: analyzed + 차단 있고 반송 2회 미만 -> collected(분석 반송 +1)", () => {
    const first = transition("analyzed", { type: "findings_complete", for: "analysis", blocking: 1 }, ctx());
    expect(first).toMatchObject({ state: "collected", row: 4, changes: { rework: { analysis: 1, plan: 0 } } });
    const second = transition("analyzed", { type: "findings_complete", for: "analysis", blocking: 1 }, ctx({ rework: { analysis: 1, plan: 0 } }));
    expect(second).toMatchObject({ state: "collected", changes: { rework: { analysis: 2, plan: 0 } } });
  });

  it("5줄: vetted + scenarios 제출 통과 -> checked", () => {
    expect(transition("vetted", { type: "scenarios_accepted", open: 4 }, ctx())).toMatchObject({ state: "checked", row: 5, changes: { open: 4 } });
  });

  it("6줄: checked + 게이트(답변) 게시 -> gate_answering", () => {
    const r = transition("checked", { type: "gate_published", phase: "answer" }, ctx());
    expect(r).toMatchObject({ state: "gate_answering", row: 6 });
  });

  it("7줄: gate_answering + 답 들여옴, 열린 0 -> answers_complete(진행 초기화)", () => {
    const r = transition("gate_answering", { type: "answers_imported", open: 0 }, ctx({ open: 4 }));
    expect(r).toMatchObject({ state: "answers_complete", row: 7, changes: { open: 0, progress: emptyProgress() } });
  });

  it("7줄: answers_complete 로 들어오면 분석 반송 회차를 0 으로 되돌린다(분해안 회차는 그대로)", () => {
    const r = transition("gate_answering", { type: "answers_imported", open: 0 }, ctx({ rework: { analysis: 2, plan: 1 } }));
    expect(r.changes.rework).toEqual({ analysis: 0, plan: 1 });
  });

  it("8줄: gate_answering + 답 들여옴, 열린 항목이 남음 -> gate_answering", () => {
    const r = transition("gate_answering", { type: "answers_imported", open: 2 }, ctx({ open: 4 }));
    expect(r).toMatchObject({ state: "gate_answering", row: 8, changes: { open: 2 } });
  });

  describe("9·10줄: answers_complete 의 진행(분석 -> 사수 -> 시나리오)과 완료", () => {
    const analyzed = { analysis: true, scenarios: false, sasu: false };
    const vetted = { analysis: true, scenarios: false, sasu: true };

    it("분석 재제출은 상태가 그대로이고 분석만 true 로 기록한다", () => {
      const r = transition("answers_complete", { type: "analysis_accepted", open: 2 }, ctx());
      expect(r).toEqual({ state: "answers_complete", row: null, changes: { progress: analyzed, open: 2 } });
    });

    it("분석을 다시 내면 사수·시나리오 진행이 모두 false 로 돌아간다", () => {
      const r = transition("answers_complete", { type: "analysis_accepted", open: 0 }, ctx({ progress: { analysis: true, scenarios: true, sasu: true } }));
      expect(r.changes.progress).toEqual(analyzed);
    });

    it("사수 완료(차단 0)는 sasu 를 true 로 기록한다", () => {
      const r = transition("answers_complete", { type: "findings_complete", for: "analysis", blocking: 0 }, ctx({ progress: analyzed, open: 2 }));
      expect(r).toEqual({ state: "answers_complete", row: null, changes: { progress: vetted, open: 2 } });
    });

    it("사수 완료: 차단이 있어도 반송 상한(2회)이면 sasu 를 true 로 기록한다", () => {
      const r = transition("answers_complete", { type: "findings_complete", for: "analysis", blocking: 3 }, ctx({ progress: analyzed, rework: { analysis: 2, plan: 0 }, open: 5 }));
      expect(r).toEqual({ state: "answers_complete", row: null, changes: { progress: vetted, open: 5 } });
    });

    it("사수 반송: 차단이 있고 상한 미만이면 상태 그대로, 반송 +1, 분석·사수 진행 false", () => {
      const r = transition("answers_complete", { type: "findings_complete", for: "analysis", blocking: 2 }, ctx({ progress: analyzed, rework: { analysis: 1, plan: 1 }, open: 3 }));
      expect(r).toEqual({
        state: "answers_complete",
        row: null,
        changes: { rework: { analysis: 2, plan: 1 }, progress: emptyProgress(), open: 3 },
      });
    });

    it("사수 반송: 반송이 0회여도 차단 1건이면 반송 1회가 된다", () => {
      const r = transition("answers_complete", { type: "findings_complete", for: "analysis", blocking: 1 }, ctx({ progress: analyzed }));
      expect(r.changes.rework).toEqual({ analysis: 1, plan: 0 });
      expect(r.changes.progress).toEqual(emptyProgress());
    });

    it("반송 뒤 분석을 다시 내면 사수 차례가 된다", () => {
      const back = transition("answers_complete", { type: "findings_complete", for: "analysis", blocking: 1 }, ctx({ progress: analyzed }));
      const r = transition("answers_complete", { type: "analysis_accepted", open: 1 }, ctx({ progress: back.changes.progress ?? emptyProgress(), rework: back.changes.rework ?? { analysis: 0, plan: 0 } }));
      expect(r.changes.progress).toEqual(analyzed);
    });

    it("9줄: 사수까지 끝나고 시나리오 재제출 통과, 열린 항목 0 -> answers_applied(진행 초기화)", () => {
      const r = transition("answers_complete", { type: "scenarios_accepted", open: 0 }, ctx({ progress: vetted }));
      expect(r).toEqual({ state: "answers_applied", row: 9, changes: { progress: emptyProgress(), open: 0 } });
    });

    it("10줄: 시나리오 재제출 뒤 새 질문으로 열린 항목이 있음 -> checked", () => {
      const r = transition("answers_complete", { type: "scenarios_accepted", open: 2 }, ctx({ progress: vetted }));
      expect(r).toEqual({ state: "checked", row: 10, changes: { progress: emptyProgress(), open: 2 } });
    });

    it("순서 위반: 분석 전의 사수 완료는 종료 4", () => {
      for (const progress of [emptyProgress()]) {
        expect(exitCodeOf(() => transition("answers_complete", { type: "findings_complete", for: "analysis", blocking: 0 }, ctx({ progress })))).toBe(4);
      }
    });

    it("순서 위반: 사수 전의 시나리오 제출은 종료 4(분석만 끝난 경우, 아무것도 안 끝난 경우)", () => {
      for (const progress of [emptyProgress(), analyzed]) {
        expect(exitCodeOf(() => transition("answers_complete", { type: "scenarios_accepted", open: 0 }, ctx({ progress })))).toBe(4);
      }
    });

    it("순서 위반: 반송 직후(분석 진행 false)의 시나리오 제출은 종료 4", () => {
      expect(exitCodeOf(() => transition("answers_complete", { type: "scenarios_accepted", open: 0 }, ctx({ rework: { analysis: 1, plan: 0 } })))).toBe(4);
    });
  });

  it("11줄: answers_applied + plan 제출 통과 -> planned", () => {
    expect(transition("answers_applied", { type: "plan_accepted" }, ctx())).toMatchObject({ state: "planned", row: 11 });
  });

  it("12줄: planned + 분해안 findings, 차단 0건 -> plan_checked", () => {
    const r = transition("planned", { type: "findings_complete", for: "plan", blocking: 0 }, ctx());
    expect(r).toMatchObject({ state: "plan_checked", row: 12 });
  });

  it("12줄: 차단이 있어도 반송 2회를 채웠으면 plan_checked", () => {
    const r = transition("planned", { type: "findings_complete", for: "plan", blocking: 2 }, ctx({ rework: { analysis: 0, plan: 2 } }));
    expect(r).toMatchObject({ state: "plan_checked", row: 12 });
  });

  it("13줄: planned + 차단 있고 반송 2회 미만 -> answers_applied(분해안 반송 +1)", () => {
    const r = transition("planned", { type: "findings_complete", for: "plan", blocking: 1 }, ctx({ rework: { analysis: 1, plan: 1 } }));
    expect(r).toMatchObject({ state: "answers_applied", row: 13, changes: { rework: { analysis: 1, plan: 2 } } });
  });

  it("14줄: plan_checked + 게이트(승인) 게시 -> gate_plan_review", () => {
    const r = transition("plan_checked", { type: "gate_published", phase: "approve" }, ctx());
    expect(r).toMatchObject({ state: "gate_plan_review", row: 14 });
  });

  it("15줄: gate_plan_review + 분해안 수정 요청 -> answers_applied(분해안 반송 0)", () => {
    const r = transition("gate_plan_review", { type: "plan_change_requested" }, ctx({ rework: { analysis: 2, plan: 2 } }));
    expect(r).toMatchObject({ state: "answers_applied", row: 15, changes: { rework: { analysis: 2, plan: 0 } } });
  });

  it("16줄: gate_plan_review + 승인 요청(revision 같음, 열린 0) -> approved", () => {
    const r = transition("gate_plan_review", { type: "approve_requested", revision: "rev-1" }, ctx());
    expect(r).toMatchObject({ state: "approved", row: 16 });
  });

  it("16줄: revision 이 다르면 종료 3 으로 거부", () => {
    const fn = () => transition("gate_plan_review", { type: "approve_requested", revision: "rev-0" }, ctx());
    expect(exitCodeOf(fn)).toBe(3);
  });

  it("16줄: 열린 항목이 남으면 표에 없는 조합이라 종료 4", () => {
    const fn = () => transition("gate_plan_review", { type: "approve_requested", revision: "rev-1" }, ctx({ open: 1 }));
    expect(exitCodeOf(fn)).toBe(4);
  });

  it("17줄: approved 는 어떤 사건도 받지 않는다", () => {
    for (const event of ALL_EVENTS) expect(exitCodeOf(() => transition("approved", event, ctx()))).toBe(4);
  });
});

const ALL_EVENTS: TransitionEvent[] = [
  { type: "sources_complete" },
  { type: "analysis_accepted", open: 0 },
  { type: "scenarios_accepted", open: 0 },
  { type: "plan_accepted" },
  { type: "findings_complete", for: "analysis", blocking: 0 },
  { type: "findings_complete", for: "plan", blocking: 0 },
  { type: "gate_published", phase: "answer" },
  { type: "gate_published", phase: "approve" },
  { type: "answers_imported", open: 0 },
  { type: "plan_change_requested" },
  { type: "approve_requested", revision: "rev-1" },
];

/** 표에 있는 (상태, 사건) 조합. 나머지는 모두 종료 4 여야 한다. */
const VALID: Record<RunState, (e: TransitionEvent) => boolean> = {
  init: (e) => e.type === "sources_complete",
  collected: (e) => e.type === "analysis_accepted",
  analyzed: (e) => e.type === "findings_complete" && e.for === "analysis",
  vetted: (e) => e.type === "scenarios_accepted",
  checked: (e) => e.type === "gate_published" && e.phase === "answer",
  gate_answering: (e) => e.type === "answers_imported",
  answers_complete: (e) =>
    e.type === "analysis_accepted" || e.type === "scenarios_accepted" || (e.type === "findings_complete" && e.for === "analysis"),
  answers_applied: (e) => e.type === "plan_accepted",
  planned: (e) => e.type === "findings_complete" && e.for === "plan",
  plan_checked: (e) => e.type === "gate_published" && e.phase === "approve",
  gate_plan_review: (e) => e.type === "plan_change_requested" || e.type === "approve_requested",
  approved: () => false,
};

describe("표에 없는 조합은 종료 4", () => {
  const ready = ctx({ progress: { analysis: true, scenarios: false, sasu: true } });
  for (const state of RUN_STATES) {
    for (const event of ALL_EVENTS) {
      if (VALID[state](event)) continue;
      const label = event.type === "findings_complete" ? `${event.type}(${event.for})` : event.type === "gate_published" ? `${event.type}(${event.phase})` : event.type;
      it(`${state} + ${label}`, () => {
        expect(exitCodeOf(() => transition(state, event, ready))).toBe(4);
      });
    }
  }

  it("오류는 HewError(state) 이다", () => {
    try {
      transition("init", { type: "plan_accepted" }, ctx());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HewError);
      expect((error as HewError).kind).toBe("state");
    }
  });
});

describe("순수성", () => {
  it("ctx 를 바꾸지 않는다", () => {
    const c = ctx({ rework: { analysis: 0, plan: 0 } });
    const snapshot = JSON.stringify(c);
    transition("analyzed", { type: "findings_complete", for: "analysis", blocking: 1 }, c);
    transition("answers_complete", { type: "analysis_accepted", open: 1 }, c);
    expect(JSON.stringify(c)).toBe(snapshot);
  });
});

describe("옛 상태 호환", () => {
  useTempRunsDir();

  it("run.json 의 옛 상태 qa_designed 는 analyzed 로 읽는다(시나리오 정본이 있어도 사수부터 다시)", () => {
    const { dir } = makeRun("checked");
    const file = runPaths(dir).runJson;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...raw, state: "qa_designed" }));
    writeFileSync(runPaths(dir).scenarios, JSON.stringify({ items: {} }));
    const run = loadRun(dir);
    expect(run.state).toBe("analyzed");
    expect(nextAction(run.state, { rework: run.rework, progress: run.progress })).toEqual({ action: "sasu", for: "analysis" });
  });

  it("알 수 없는 다른 상태는 여전히 읽을 수 없다", () => {
    const { dir } = makeRun("checked");
    const file = runPaths(dir).runJson;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...raw, state: "weird" }));
    expect(() => loadRun(dir)).toThrow(/run.json 형식/);
  });
});
