import { describe, expect, it } from "vitest";
import { nextAction, type NextAction } from "../src/core/next.js";
import { emptyProgress, type RunState } from "../src/core/state-machine.js";

const base = { rework: { analysis: 0, plan: 0 }, progress: emptyProgress() };

describe("next: 상태별로 전이 표의 마지막 열과 맞는다", () => {
  const cases: [RunState, NextAction][] = [
    ["init", { action: "spawn", role: "collector", purpose: "first" }],
    ["collected", { action: "spawn", role: "technical-manager", purpose: "first" }],
    ["analyzed", { action: "sasu", for: "analysis" }],
    ["vetted", { action: "spawn", role: "qa-designer", purpose: "first" }],
    ["checked", { action: "publish_gate", phase: "answer" }],
    ["gate_answering", { action: "wait_human", for: "answers" }],
    ["answers_applied", { action: "spawn", role: "ticket-maker", purpose: "first" }],
    ["planned", { action: "sasu", for: "plan" }],
    ["plan_checked", { action: "publish_gate", phase: "approve" }],
    ["gate_plan_review", { action: "wait_human", for: "approval" }],
    ["approved", { action: "done" }],
  ];
  it.each(cases)("%s", (state, expected) => {
    expect(nextAction(state, base)).toEqual(expected);
  });

  it("collected 는 분석 반송 회차가 있으면 rework", () => {
    expect(nextAction("collected", { ...base, rework: { analysis: 1, plan: 0 } })).toEqual({
      action: "spawn",
      role: "technical-manager",
      purpose: "rework",
    });
  });

  it("answers_applied 는 분해안 반송 회차가 있으면 rework", () => {
    expect(nextAction("answers_applied", { ...base, rework: { analysis: 0, plan: 2 } })).toEqual({
      action: "spawn",
      role: "ticket-maker",
      purpose: "rework",
    });
  });

  it("answers_complete 는 진행에 따라 매니저, 사수, QA 설계 순서로 알려 준다", () => {
    const step = (progress: { analysis: boolean; scenarios: boolean; sasu: boolean }) =>
      nextAction("answers_complete", { ...base, progress });
    expect(step({ analysis: false, scenarios: false, sasu: false })).toEqual({ action: "spawn", role: "technical-manager", purpose: "apply_answers" });
    expect(step({ analysis: true, scenarios: false, sasu: false })).toEqual({ action: "sasu", for: "analysis" });
    expect(step({ analysis: true, scenarios: false, sasu: true })).toEqual({ action: "spawn", role: "qa-designer", purpose: "apply_answers" });
  });

  it("answers_complete 에서 분석 진행이 false 이고 이번 구간의 반송 회차가 있으면 technical-manager 를 rework 로 띄운다", () => {
    expect(nextAction("answers_complete", { rework: { analysis: 1, plan: 0 }, progress: emptyProgress() })).toEqual({
      action: "spawn",
      role: "technical-manager",
      purpose: "rework",
    });
  });
});
