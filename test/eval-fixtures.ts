/** 결함 주입 테스트용 합성 자료: 여섯 종류 모두 후보가 있는 분석 문서와 원문 단위, qa_designed 실행 준비 도우미. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import "../src/core/analysis/index.js";
import "../src/core/scenarios/index.js";
import { runPaths } from "../src/core/paths.js";
import { submitArtifact } from "../src/core/submit.js";
import type { Unit } from "../src/core/units/types.js";
import { IMG, buildAnalysis, buildUnits, clone, setupRun, type Doc } from "./analysis-fixtures.js";
import { writeItemsFile } from "./helpers.js";
import { buildScenarios } from "./scenarios-fixtures.js";

/** buildUnits() 에 미정 표시가 있는 단위(U-11, U-13)와 알림 절의 단위(U-10, U-12)를 더한 목록. */
export function buildEvalUnits(): Unit[] {
  const doc = (n: number, kind: Unit["kind"], text: string, section: string[]): Unit => ({
    id: `U-${n}`,
    source_id: "S-1",
    kind,
    locator: { section, index: n },
    text,
  });
  return [
    ...buildUnits(),
    doc(10, "bullet", "알림은 24시간 이내에 보낸다", ["요구", "알림"]),
    doc(11, "bullet", "알림 문구는 미정이다. 논의 필요", ["요구", "알림"]),
    doc(12, "paragraph", "알림 영역은 화면 위에 보인다", ["요구", "알림"]),
    doc(13, "bullet", "배너 문구는 TBD", ["요구"]),
  ];
}

/**
 * 여섯 종류 모두 후보가 둘 이상인 분석 문서(items).
 * - w3: 요구-1 변경 0(U-1), 요구-4 변경 0(U-10)·1(U-12)
 * - w2: 요구-1 변경 0(5→7), 요구-2 변경 0(6→8), 요구-4 변경 0(24→26)·1(위→아래)
 * - w4: 요구-1·요구-2(U-13 의 TBD), 요구-4(U-11 의 미정)
 * - w5: 요구 네 개 모두
 * - w7: 요구-1 변경 1(화면-1.1), 요구-2 변경 1(화면-2)
 * - w8: D-1, D-3
 */
export function buildEvalAnalysis(): Doc {
  const a = buildAnalysis();
  a.screens[0].variants[0].images = [
    { role: "as_is", path: IMG },
    { role: "to_be", path: IMG },
  ];
  a.screens[1].images = [
    { role: "as_is", path: IMG },
    { role: "to_be", path: IMG },
  ];
  a.requirements[0].changes[0].text = "홈 상단에 배너를 최대 5개 노출한다";
  a.requirements[1].changes.push({ text: "상세 화면의 아이콘을 교체한다", screen_id: "화면-2", evidence: [{ unit_id: "U-6", image: IMG }] });
  a.requirements.push({
    id: "요구-4",
    title: "알림을 보낸다",
    screen_ids: ["화면-2"],
    changes: [
      { text: "알림은 24시간 이내에 보낸다", screen_id: "화면-2", evidence: [{ unit_id: "U-10", quote: "24시간 이내" }] },
      { text: "알림 영역은 화면 위에 보인다", screen_id: "화면-2", evidence: [{ unit_id: "U-12", quote: "화면 위에 보인다" }] },
    ],
    status: "pending",
    acceptance: [{ id: "요구-4/AC-1", when: "알림이 온다", then: "알림 영역이 보인다", verify: { method: "qa_scenario" } }],
    ai: { code: [], verify: [], rules: [], notes: [] },
    depends_on: [],
  });
  a.deltas[0].comparison.rows.push({ aspect: "간격", prd: "12px", figma: "8px" });
  a.deltas.push({
    id: "D-3",
    title: "알림 문구가 다르다",
    kind: "mismatch",
    requirement_ids: ["요구-4"],
    comparison: {
      prd_source: "S-1",
      figma_source: "S-2",
      rows: [
        { aspect: "시간", prd: "24시간 이내", figma: "12시간 이내" },
        { aspect: "위치", prd: "화면 위", figma: "화면 아래" },
      ],
    },
    prd_evidence: [{ unit_id: "U-10", quote: "24시간 이내" }],
    figma_evidence: [{ unit_id: "U-7", quote: "배너 영역" }],
    audience: ["po"],
    recommendation: { decision: "follow_figma" },
  });
  a.coverage[1].unit_ids = ["U-2"];
  a.coverage[2].unit_ids = ["U-5", "U-9", "U-11", "U-13"];
  a.coverage.push({ id: "C-5", unit_ids: ["U-10", "U-12"], disposition: "covered", requirement_ids: ["요구-4"], screen_ids: [] });
  return a;
}

export interface EvalSourceOptions {
  analysis?: (doc: Doc) => void;
  units?: Unit[];
  /** 시나리오 문서를 고친다. */
  scenarios?: (doc: Doc) => void;
}

/** buildEvalAnalysis 가 통과해 qa_designed 가 된 원본 실행을 만든다(이미지 파일도 둔다). */
export function setupEvalSource(opts: EvalSourceOptions = {}): { dir: string } {
  const { dir } = setupRun({ units: opts.units ?? buildEvalUnits() });
  const image = join(runPaths(dir).dir, IMG);
  mkdirSync(dirname(image), { recursive: true });
  writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const analysis = buildEvalAnalysis();
  opts.analysis?.(analysis);
  const scenarios = clone(buildScenarios());
  scenarios.scenarios[1].requirement_ids.push("요구-4");
  scenarios.scenarios[1].ac_ids.push("요구-4/AC-1");
  opts.scenarios?.(scenarios);
  submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "analysis-in.json", analysis) });
  submitArtifact({ runDir: dir, kind: "scenarios", file: writeItemsFile(dir, "scenarios-in.json", scenarios) });
  return { dir };
}
