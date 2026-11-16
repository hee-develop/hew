import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runPaths } from "../src/core/paths.js";
import { loadRun } from "../src/core/run.js";
import { submitArtifact } from "../src/core/submit.js";
import { AnalysisItemsSchema } from "../src/core/analysis/schema.js";
import { HEW_ROOT } from "../src/core/paths.js";
import { join } from "node:path";
import { exampleUnits, EXAMPLE_DOC } from "./runner-helpers.js";
import { setupRun } from "./analysis-fixtures.js";
import { useTempRunsDir } from "./helpers.js";

useTempRunsDir();

describe("형식 안내 예시(refs/)", () => {
  it("예시 분석 문서가 스키마를 통과하고 사람의 칸이 비어 있다", () => {
    const doc = JSON.parse(readFileSync(EXAMPLE_DOC, "utf8")) as Record<string, any>;
    expect(AnalysisItemsSchema.safeParse(doc).success).toBe(true);
    for (const d of doc.deltas) expect(d.decision).toBeUndefined();
    for (const q of doc.questions) expect(q.answer).toBeUndefined();
    for (const a of doc.assumptions) expect(a.status).toBeUndefined();
  });

  it("예시 분석 문서가 예시 단위 목록과 함께 결정적 검사를 통과해 제출된다(거부 0, 경고 없음)", () => {
    const { dir } = setupRun({ units: exampleUnits() });
    const result = submitArtifact({ runDir: dir, kind: "analysis", file: EXAMPLE_DOC });
    expect(result.state).toBe("analyzed");
    expect(result.warnings.filter((w) => w.severity !== "info")).toEqual([]);
    expect(loadRun(dir).submissions.analysis?.attempt).toBe(1);
    expect(runPaths(dir).analysis).toBeTruthy();
  });

  it("roles.yaml 의 technical-manager.refs 가 가리키는 파일이 모두 있다", async () => {
    const { roleConfig } = await import("../src/core/roles.js");
    const refs = roleConfig("technical-manager").refs;
    expect(refs).toEqual(["refs/analysis-format.md", "refs/analysis.example.json", "refs/analysis.example.units.json"]);
    for (const ref of refs) expect(() => readFileSync(join(HEW_ROOT, ref))).not.toThrow();
  });

  it("형식 안내가 스키마의 최상위 묶음과 거부 코드를 모두 언급한다", () => {
    const text = readFileSync(join(HEW_ROOT, "refs", "analysis-format.md"), "utf8");
    for (const word of ["screens", "requirements", "deltas", "questions", "assumptions", "coverage", "impact"]) expect(text).toContain(word);
    for (const code of ["quote_not_found", "coverage_incomplete", "confirmed_with_open", "blocker_without_question", "evidence_operator_row"]) {
      expect(text).toContain(code);
    }
  });
});
