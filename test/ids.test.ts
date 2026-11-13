import { describe, expect, it } from "vitest";
import { ID_PATTERNS, idKindOf, isId, type IdKind } from "../src/core/ids.js";

const GOOD: Record<IdKind, string> = {
  screen: "화면-1",
  variant: "화면-3.2",
  requirement: "요구-12",
  ac: "요구-12/AC-3",
  question: "Q-1",
  delta: "D-4",
  assumption: "A-2",
  source: "S-1",
  unit: "U-41",
  coverage: "C-7",
  impact: "I-1",
  blocker: "B-2",
  scenario: "시나리오-5",
  ticket: "T3",
  pr: "PR-2",
  finding: "F-9",
};

describe("ids", () => {
  it.each(Object.entries(GOOD))("%s 형식 %s 를 받아들인다", (kind, value) => {
    expect(isId(kind as IdKind, value)).toBe(true);
    expect(idKindOf(value)).toBe(kind);
  });

  it("모든 형식이 하나씩 등록되어 있다", () => {
    expect(Object.keys(GOOD).sort()).toEqual(Object.keys(ID_PATTERNS).sort());
  });

  it.each([
    ["screen", "화면-0"],
    ["screen", "화면-1.2"],
    ["screen", "screen-1"],
    ["variant", "화면-1"],
    ["variant", "화면-1.0"],
    ["requirement", "REQ-1"],
    ["requirement", "요구-01"],
    ["ac", "요구-1/AC-"],
    ["ac", "AC-1"],
    ["question", "Q1"],
    ["delta", "d-1"],
    ["assumption", "A-"],
    ["ticket", "T-1"],
    ["ticket", "T0"],
    ["pr", "PR1"],
    ["finding", "F-x"],
    ["scenario", "시나리오1"],
  ] as [IdKind, string][])("%s 형식은 %s 를 거부한다", (kind, value) => {
    expect(isId(kind, value)).toBe(false);
  });

  it("문자열이 아닌 값과 어느 형식에도 안 맞는 값은 null", () => {
    expect(isId("screen", 3)).toBe(false);
    expect(idKindOf(undefined)).toBeNull();
    expect(idKindOf("임의-1")).toBeNull();
    expect(idKindOf(" 화면-1")).toBeNull();
  });
});
