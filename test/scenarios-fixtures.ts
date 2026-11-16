/** scenarios 테스트용 합성 자료: buildAnalysis() 와 짝이 맞는 통과하는 시나리오 문서, analyzed 상태 실행 준비 도우미. */
import "../src/core/analysis/index.js";
import "../src/core/scenarios/index.js";
import { submitArtifact } from "../src/core/submit.js";
import { buildAnalysis, setState, setupRun, type Doc, type SetupOptions } from "./analysis-fixtures.js";
import { writeItemsFile } from "./helpers.js";

/** 통과하는 완전한 시나리오 문서(items). 열린 항목은 Q-3 하나, 정보 지적은 accounts_unavailable. */
export function buildScenarios(): Doc {
  return {
    scenarios: [
      {
        id: "시나리오-1",
        title: "원가 없는 팩은 판매가만 본다",
        journey: "구매자가 원가가 없는 팩의 상세 화면에 들어가 가격을 확인한다",
        requirement_ids: ["요구-3"],
        ac_ids: ["요구-3/AC-1"],
        preconditions: { account_state: "원가가 입력되지 않은 팩을 가진 판매자의 팩을 보는 구매자", feature_flags: [], data: "원가 없는 팩 1개" },
        steps: [
          { n: 1, action: "홈에서 팩 목록을 연다", screen_id: "화면-1" },
          { n: 2, action: "원가가 없는 팩을 눌러 상세로 들어간다", screen_id: "화면-2" },
        ],
        expected: [
          { id: "시나리오-1/E-1", text: "판매가만 보인다", screen_id: "화면-2" },
          { id: "시나리오-1/E-2", text: "원가는 보이지 않는다", screen_id: "화면-2" },
        ],
        backend: "real",
        environment: "dev",
        reach: "navigation",
        platforms: ["ios", "android"],
      },
      {
        id: "시나리오-2",
        title: "홈에서 배너를 본다",
        journey: "구매자가 홈에 들어와 배너를 보고 최대 5개까지만 노출되는 것을 확인한다",
        requirement_ids: ["요구-1", "요구-2"],
        ac_ids: ["요구-1/AC-1", "요구-2/AC-1"],
        preconditions: { account_state: "배너가 6개 등록된 환경의 구매자", feature_flags: ["FF_BANNER"] },
        steps: [{ n: 1, action: "앱을 열어 홈에 들어간다", screen_id: "화면-1" }],
        expected: [
          { id: "시나리오-2/E-1", text: "홈 상단에 배너가 보인다", screen_id: "화면-1" },
          { id: "시나리오-2/E-2", text: "배너가 5개만 보인다", screen_id: "화면-1" },
        ],
        backend: "real",
        environment: "dev",
        reach: "deeplink",
        platforms: ["ios", "android"],
      },
      {
        id: "시나리오-3",
        title: "배너가 없으면 빈 상태를 본다",
        journey: "구매자가 배너가 없는 홈에 들어와 빈 상태를 확인한다",
        requirement_ids: ["요구-1"],
        ac_ids: [],
        preconditions: { account_state: "배너를 받지 못한 구매자", feature_flags: ["FF_BANNER"] },
        steps: [
          { n: 1, action: "앱을 열어 홈에 들어간다", screen_id: "화면-1" },
          { n: 2, action: "배너 영역을 확인한다", screen_id: "화면-1.1" },
        ],
        expected: [{ id: "시나리오-3/E-1", text: "배너 영역에 빈 상태 문구가 보인다", screen_id: "화면-1.1" }],
        backend: "mock",
        mock: {
          endpoints: [{ method: "GET", path: "/v1/banners", case: "빈 목록을 돌려준다" }],
          reason: "실서버에서 배너가 없는 상태를 만들 수 없다",
        },
        reach: "navigation",
        platforms: ["ios", "android"],
      },
    ],
    preflight: [
      {
        id: "PF-1",
        text: "QA 하는 날 배너 설정 변경이 staging 에 반영돼 있다",
        kind: "deploy",
        scenario_ids: ["시나리오-2"],
        check: "어드민에서 배너를 6개 등록한 환경의 홈을 열어 배너가 6개 내려오는지 본다",
        fallback: "hold",
      },
    ],
    accounts: [
      { id: "AC-1", state: "원가가 입력되지 않은 팩을 가진 판매자", available: true, scenario_ids: ["시나리오-1"] },
      { id: "AC-2", state: "배너를 받지 못한 구매자", available: false, scenario_ids: ["시나리오-3"], note: "지금 가진 테스트 계정은 모두 배너를 받는다" },
    ],
    questions: [
      {
        id: "Q-3",
        text: "배너를 받지 못한 구매자 시나리오를 모킹으로만 확인해도 되나요",
        origin: "qa",
        blocking: false,
        options: [
          { key: "a", label: "모킹으로 충분하다", consequence: "시나리오-3 은 모킹으로 남는다" },
          { key: "b", label: "실서버로 확인해야 한다", consequence: "시나리오-3 을 실서버로 바꾼다" },
        ],
        recommended: "a",
        rationale: [],
        affects: ["시나리오-3"],
        audience: ["backend"],
      },
    ],
  };
}

/** 분석 정본이 들어가고 사수가 확인해 vetted 상태가 된 실행을 만든다. */
export function setupVetted(opts: SetupOptions = {}): { dir: string } {
  const { dir } = setupRun({ ...opts, state: "collected" });
  submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "analysis-in.json", buildAnalysis()) });
  setState(dir, "vetted");
  return { dir };
}
