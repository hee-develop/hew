import { describe, expect, it } from "vitest";
import { looksSameDecision, sameDecisionPairs, similarDeltaIds } from "../src/core/analysis/delta-decision.js";
import type { Delta } from "../src/core/analysis/schema.js";

/** 필요한 칸만 채운 차이. 비교 값 쌍은 [PRD, 시안] 목록으로 준다. */
function delta(id: string, pairs: [string, string][], over: Record<string, unknown> = {}): Delta {
  return {
    id,
    title: `${id} 차이`,
    kind: "mismatch",
    requirement_ids: ["요구-1"],
    comparison: { rows: pairs.map(([prd, figma]) => ({ aspect: "항목", prd, figma })) },
    prd_evidence: [],
    figma_evidence: [],
    audience: [],
    ...over,
  } as unknown as Delta;
}

describe("looksSameDecision", () => {
  it("종류가 다르면 아니다", () => {
    expect(looksSameDecision(delta("D-1", [["5개", "3개"]]), delta("D-2", [["5개", "3개"]], { kind: "figma_only" }))).toBe(false);
  });

  it("추천 결정이 서로 다르면 아니다", () => {
    const a = delta("D-1", [["5개", "3개"]], { recommendation: { decision: "follow_figma" } });
    const b = delta("D-2", [["5개", "3개"]], { recommendation: { decision: "follow_prd" } });
    expect(looksSameDecision(a, b)).toBe(false);
  });

  it("추천이 한쪽에만 있거나 같으면 막지 않는다", () => {
    const rec = { recommendation: { decision: "follow_figma" } };
    expect(looksSameDecision(delta("D-1", [["5개", "3개"]], rec), delta("D-2", [["5개", "3개"]]))).toBe(true);
    expect(looksSameDecision(delta("D-1", [["5개", "3개"]], rec), delta("D-2", [["5개", "3개"]], rec))).toBe(true);
  });

  it("비교 값 쌍이 같으면 맞다(공백은 무시한다)", () => {
    expect(looksSameDecision(delta("D-1", [["최대 5개", "최대 3개"]]), delta("D-2", [["최대5개", "최대3개"]]))).toBe(true);
  });

  it("한쪽 쌍이 다른 쪽에 포함되면 맞다", () => {
    expect(looksSameDecision(delta("D-1", [["a", "b"]]), delta("D-2", [["a", "b"], ["c", "d"]]))).toBe(true);
    expect(looksSameDecision(delta("D-1", [["a", "b"], ["c", "d"]]), delta("D-2", [["c", "d"]]))).toBe(true);
  });

  it("겹치지 않으면 아니다", () => {
    expect(looksSameDecision(delta("D-1", [["a", "b"]]), delta("D-2", [["a", "c"]]))).toBe(false);
    expect(looksSameDecision(delta("D-1", [["a", "b"], ["x", "y"]]), delta("D-2", [["a", "b"], ["c", "d"]]))).toBe(false);
  });

  it("비교 행이 없거나 값이 모두 빈 행뿐이면 아니다", () => {
    const none = delta("D-2", []);
    expect(looksSameDecision(delta("D-1", [["a", "b"]]), none)).toBe(false);
    expect(looksSameDecision(none, delta("D-1", [["a", "b"]]))).toBe(false);
    expect(looksSameDecision(delta("D-1", [["", ""]]), delta("D-2", [["", ""]]))).toBe(false);
    expect(looksSameDecision(delta("D-1", []), delta("D-2", []))).toBe(false);
    const missing = { ...delta("D-3", []), comparison: undefined } as unknown as Delta;
    expect(looksSameDecision(delta("D-1", [["a", "b"]]), missing)).toBe(false);
  });

  it("자기 자신과는 아니다", () => {
    const a = delta("D-1", [["a", "b"]]);
    expect(looksSameDecision(a, a)).toBe(false);
  });
});

describe("sameDecisionPairs, similarDeltaIds", () => {
  const deltas = [delta("D-1", [["a", "b"]]), delta("D-2", [["x", "y"]]), delta("D-3", [["a", "b"]]), delta("D-4", [["a", "b"]])];

  it("쌍은 문서 순서(앞, 뒤)로 모은다", () => {
    expect(sameDecisionPairs(deltas).map(([a, b]) => [a.id, b.id])).toEqual([
      ["D-1", "D-3"],
      ["D-1", "D-4"],
      ["D-3", "D-4"],
    ]);
  });

  it("차이마다 비슷한 다른 차이의 id 를 양쪽에 단다", () => {
    const map = similarDeltaIds(deltas);
    expect(map.get("D-1")).toEqual(["D-3", "D-4"]);
    expect(map.get("D-3")).toEqual(["D-1", "D-4"]);
    expect(map.get("D-4")).toEqual(["D-1", "D-3"]);
    expect(map.has("D-2")).toBe(false);
  });

  it("묶일 것이 없으면 비어 있다", () => {
    expect(sameDecisionPairs([delta("D-1", [["a", "b"]])])).toEqual([]);
    expect(similarDeltaIds([]).size).toBe(0);
  });
});
