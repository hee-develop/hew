/** analysis 테스트용 합성 자료: 통과하는 완전한 분석 문서, 그에 맞는 units.json, 실행 준비 도우미. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import "../src/core/analysis/index.js";
import { runPaths } from "../src/core/paths.js";
import { saveManifest } from "../src/core/manifest.js";
import { loadRun, saveRun, type Run } from "../src/core/run.js";
import type { RunState } from "../src/core/state-machine.js";
import type { Unit } from "../src/core/units/types.js";
import { makeRun } from "./helpers.js";

export type Doc = Record<string, any>;

export const IMG = "sources/figma/s1.png";

export function buildUnits(): Unit[] {
  const doc = (n: number, kind: Unit["kind"], text: string, extra: Partial<Unit> = {}): Unit => ({
    id: `U-${n}`,
    source_id: "S-1",
    kind,
    locator: { section: ["요구"], index: n },
    text,
    ...extra,
  });
  return [
    doc(1, "table_row", "판매자가 홈에서 배너를 본다 | **배너를** 노출한다", { actor: "provider", columns: { "User Journey": "판매자가 홈에서 배너를 본다", 기능: "배너를 노출한다" } }),
    doc(2, "table_row", "운영자가 배너를 등록한다 | 어드민에서 입력한다", { actor: "operator", columns: { "User Journey": "운영자가 배너를 등록한다", 기능: "어드민에서 입력한다", "Mobile(App)": "" } }),
    doc(3, "bullet", "원가가 입력되지 않은 팩은 판매가만 노출한다"),
    doc(4, "bullet", "배너는 최대 5개까지 노출한다"),
    doc(5, "paragraph", "배경 설명 문단입니다"),
    { id: "U-6", source_id: "S-2", kind: "figma_screen", locator: { node_id: "1:2", name: "앱/홈" }, text: "앱/홈", platform: "app", image: IMG },
    { id: "U-7", source_id: "S-2", kind: "figma_desc", locator: { node_id: "1:3", name: "desc" }, text: "배너 영역은 최대 5개", platform: "app" },
    { id: "U-8", source_id: "S-2", kind: "figma_screen", locator: { node_id: "1:4", name: "웹/홈" }, text: "웹/홈", platform: "web" },
    doc(9, "table_row", "앱 설정 노출 | 운영자 세팅", { actor: "operator", columns: { "작업 구분": "운영자 세팅", "Mobile(App)": "앱 설정 화면에 노출" } }),
  ];
}

/** 통과하는 완전한 분석 문서(items). 열린 항목은 Q-1, Q-2, D-1, D-2, A-1. */
export function buildAnalysis(): Doc {
  return {
    screens: [
      {
        id: "화면-1",
        name: "홈",
        figma: { file_key: "FigK", node_id: "1:2", url: "https://www.figma.com/design/FigK?node-id=1-2" },
        images: [{ role: "both", path: IMG, hash: "abc" }],
        variants: [{ id: "화면-1.1", name: "빈 상태", images: [] }],
        change: "changed",
      },
      { id: "화면-2", name: "상세", images: [{ role: "to_be", path: IMG }], variants: [], change: "new" },
    ],
    requirements: [
      {
        id: "요구-1",
        title: "홈에 배너를 노출한다",
        screen_ids: ["화면-1"],
        changes: [
          { text: "홈 상단에 배너를 노출한다", screen_id: "화면-1", evidence: [{ unit_id: "U-1", quote: "배너를 노출한다" }] },
          { text: "배너가 없으면 빈 상태를 보인다", screen_id: "화면-1.1", evidence: [{ unit_id: "U-6", image: IMG }] },
        ],
        status: "pending",
        acceptance: [{ id: "요구-1/AC-1", when: "홈에 진입한다", then: "배너가 보인다", verify: { method: "unit_test", detail: "test/home.test.ts" } }],
        ai: {
          code: [{ path: "app/Home.tsx", symbol: "Home", role: "reference" }],
          verify: [{ ac_id: "요구-1/AC-1", detail: "test/home.test.ts 의 배너 케이스" }],
          rules: ["heka-1"],
          notes: [{ text: "배너는 최대 5개", evidence: [{ unit_id: "U-4", quote: "최대 5개" }] }],
        },
        depends_on: [],
      },
      {
        id: "요구-2",
        title: "배너는 최대 5개",
        screen_ids: ["화면-1"],
        changes: [{ text: "6번째부터는 그리지 않는다", screen_id: "화면-1", evidence: [{ unit_id: "U-4", quote: "최대 5개까지" }] }],
        status: "pending",
        acceptance: [{ id: "요구-2/AC-1", given: "배너가 6개", when: "홈에 진입한다", then: "5개만 보인다", verify: { method: "visual_compare" } }],
        ai: { code: [], verify: [], rules: [], notes: [] },
        depends_on: ["요구-1"],
      },
      {
        id: "요구-3",
        title: "원가 없는 팩은 판매가만",
        screen_ids: ["화면-2"],
        changes: [{ text: "원가가 없으면 판매가만 그린다", screen_id: "화면-2", evidence: [{ unit_id: "U-3", quote: "판매가만 노출한다" }] }],
        status: "confirmed",
        acceptance: [{ id: "요구-3/AC-1", when: "원가가 없다", then: "판매가만 보인다", verify: { method: "qa_scenario" } }],
        ai: { code: [], verify: [], rules: [], notes: [] },
        depends_on: [],
      },
    ],
    deltas: [
      {
        id: "D-1",
        title: "배너 개수 상한이 다르다",
        kind: "mismatch",
        requirement_ids: ["요구-2"],
        comparison: {
          prd_source: "S-1",
          figma_source: "S-2",
          rows: [{ aspect: "최대 개수", prd: "5개", figma: "3개" }],
        },
        prd_evidence: [{ unit_id: "U-4", quote: "최대 5개" }],
        figma_evidence: [{ unit_id: "U-7", quote: "최대 5개" }],
        audience: ["po", "designer"],
        recommendation: { decision: "follow_figma", reason: "시안이 최신" },
      },
      {
        id: "D-2",
        title: "빈 상태는 시안에만 있다",
        kind: "figma_only",
        requirement_ids: ["요구-1"],
        comparison: { rows: [{ aspect: "빈 상태", figma: "문구 노출" }] },
        prd_evidence: [],
        figma_evidence: [{ unit_id: "U-7", quote: "배너 영역" }],
        audience: ["dev"],
        recommendation: { decision: "follow_figma" },
      },
    ],
    questions: [
      {
        id: "Q-1",
        text: "배너를 탭하면 어디로 이동하나요",
        origin: "analysis",
        blocking: true,
        options: [
          { key: "a", label: "상세", consequence: "상세 화면으로 라우팅을 추가한다" },
          { key: "b", label: "외부", consequence: "외부 링크 처리를 추가한다" },
        ],
        recommended: "a",
        rationale: [{ unit_id: "U-3", quote: "판매가만 노출한다" }],
        affects: ["요구-1"],
        audience: ["po"],
      },
      {
        id: "Q-2",
        text: "배너 아이콘 에셋을 받을 수 있나요",
        origin: "impact",
        blocking: false,
        options: [{ key: "a", label: "받는다", consequence: "에셋을 추가한다" }],
        rationale: [],
        affects: [],
        audience: ["designer"],
      },
    ],
    assumptions: [{ id: "A-1", text: "배너는 서버가 정렬해 준다", basis: "원문에 정렬 언급이 없어 추정", requirement_ids: ["요구-2"] }],
    coverage: [
      { id: "C-1", unit_ids: ["U-1", "U-3", "U-4"], disposition: "covered", requirement_ids: ["요구-1", "요구-2", "요구-3"], screen_ids: [] },
      { id: "C-2", unit_ids: ["U-2"], disposition: "not_app", requirement_ids: [], screen_ids: [], reason: "운영자 어드민 입력" },
      { id: "C-3", unit_ids: ["U-5", "U-9"], disposition: "context", requirement_ids: [], screen_ids: [] },
      { id: "C-4", unit_ids: ["U-6", "U-7"], disposition: "covered", requirement_ids: [], screen_ids: ["화면-1"] },
    ],
    impact: {
      areas: [{ id: "I-1", screen_ids: ["화면-1"], paths: ["app/Home.tsx"], components: ["BannerList"], feature_flag: "FF_BANNER" }],
      apis: [{ method: "GET", path: "/v1/banners", fields: ["id", "image"], presence: { dev: true, prod: false } }],
      assets: [{ name: "banner-empty.svg", exists: false }],
      blockers: [{ id: "B-1", kind: "missing_asset", detail: "빈 상태 아이콘이 저장소에 없다", question_id: "Q-2" }],
      environment: { name: "dev", basis: "prod 에 API 가 아직 없다" },
    },
  };
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export interface SetupOptions {
  state?: RunState;
  runId?: string;
  repoPath?: string | null;
  figmaMeta?: boolean;
  units?: Unit[];
}

/** collected 상태의 실행에 units.json(과 선택적으로 manifest, repo 경로)을 깔아 둔다. */
let runCounter = 0;

export function setupRun(opts: SetupOptions = {}): { dir: string; run: Run } {
  const { dir } = makeRun(opts.state ?? "collected", { repo: { path: opts.repoPath ?? null, base: null } }, opts.runId ?? `an-${++runCounter}`);
  const p = runPaths(dir);
  mkdirSync(dirname(p.units), { recursive: true });
  writeFileSync(p.units, JSON.stringify({ units: opts.units ?? buildUnits() }), "utf8");
  if (opts.figmaMeta === true) {
    saveManifest(dir, { sources: [{ id: "S-2", kind: "figma_meta", ref: "FigK", added_at: "2026-11-14T00:00:00Z", meta: {} }] });
  }
  return { dir, run: loadRun(dir) };
}

export function setState(dir: string, state: RunState): Run {
  return saveRun(dir, { ...loadRun(dir), state });
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value), "utf8");
}

export const answersPath = (dir: string): string => join(dir, "doc", "answers.json");
