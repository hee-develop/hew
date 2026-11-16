import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Issue } from "../src/core/errors.js";
import { runPaths } from "../src/core/paths.js";
import { loadRun } from "../src/core/run.js";
import { submitArtifact } from "../src/core/submit.js";
import { scenariosCheck } from "../src/core/scenarios/checks.js";
import { answersPath, clone, setState, setupRun, writeJson, type Doc } from "./analysis-fixtures.js";
import { useTempRunsDir, writeItemsFile } from "./helpers.js";
import { buildScenarios, setupAnalyzed } from "./scenarios-fixtures.js";

useTempRunsDir();

interface Case {
  dir: string;
  run: (doc: Doc, withdraw?: string[]) => Issue[];
}

function make(): Case {
  const { dir } = setupAnalyzed();
  return { dir, run: (doc, withdraw) => scenariosCheck(doc, { kind: "scenarios", for: null, run: loadRun(dir), runDir: dir, withdraw }) };
}

const rejects = (issues: Issue[]): string[] => [...new Set(issues.filter((i) => i.severity === "reject").map((i) => i.code))];
const codes = (issues: Issue[]): string[] => [...new Set(issues.map((i) => i.code))];
const sc = (doc: Doc, id: string): Doc => doc.scenarios.find((s: Doc) => s.id === id);
const readAnalysis = (dir: string): Doc => JSON.parse(readFileSync(runPaths(dir).analysis, "utf8"));

/** 변형 하나를 가해 그 코드만 거부로 나오는지 확인한다. */
function expectReject(code: string, mutate: (doc: Doc) => void): Issue[] {
  const c = make();
  const doc = clone(buildScenarios());
  mutate(doc);
  const issues = c.run(doc);
  expect(rejects(issues)).toEqual([code]);
  return issues;
}

/** 변형 하나를 가해 거부 없이 그 코드가 경고로 나오는지 확인한다. */
function expectWarn(code: string, mutate: (doc: Doc) => void): Issue[] {
  const c = make();
  const doc = clone(buildScenarios());
  mutate(doc);
  const issues = c.run(doc);
  expect(rejects(issues)).toEqual([]);
  expect(issues.filter((i) => i.code === code && i.severity === "warn").length).toBeGreaterThan(0);
  return issues;
}

describe("scenarios 검사: 통과", () => {
  it("합성 시나리오 문서는 거부 0, 경고 0 이고 정보만 남는다", () => {
    const issues = make().run(buildScenarios());
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "accounts_unavailable", severity: "info" });
  });

  it("정본 analysis 가 없으면 analysis_missing 하나만 거부한다", () => {
    const { dir } = setupRun({ state: "analyzed" });
    const issues = scenariosCheck(buildScenarios(), { kind: "scenarios", for: null, run: loadRun(dir), runDir: dir });
    expect(issues.map((i) => i.code)).toEqual(["analysis_missing"]);
    expect(issues[0]?.severity).toBe("reject");
  });

  it("스키마가 틀리면 schema_invalid 만 낸다", () => {
    const issues = expectReject("schema_invalid", (d) => (sc(d, "시나리오-1").backend = "maybe"));
    expect(issues[0]?.ref).toBe("scenarios.0.backend");
  });

  it("reach 와 platforms 를 비우면 unknown 과 둘 다로 읽는다", () => {
    const doc = clone(buildScenarios());
    delete sc(doc, "시나리오-1").reach;
    delete sc(doc, "시나리오-1").platforms;
    const issues = make().run(doc);
    expect(issues.filter((i) => i.code === "reach_unknown").map((i) => i.ref)).toEqual(["시나리오-1"]);
  });
});

describe("scenarios 검사: 거부", () => {
  describe("ac_uncovered", () => {
    it("qa_scenario 인수 조건을 덮는 시나리오가 없으면 거부한다", () => {
      const issues = expectReject("ac_uncovered", (d) => (sc(d, "시나리오-1").ac_ids = []));
      expect(issues.find((i) => i.code === "ac_uncovered")?.ref).toBe("요구-3/AC-1");
    });

    it("qa_scenario 가 아닌 인수 조건은 덮지 않아도 된다", () => {
      const doc = clone(buildScenarios());
      sc(doc, "시나리오-2").ac_ids = [];
      expect(rejects(make().run(doc))).toEqual([]);
    });

    function dropRequirement(dir: string, decision: string): void {
      const doc = readAnalysis(dir);
      doc.items.deltas[0].requirement_ids.push("요구-3");
      writeJson(runPaths(dir).analysis, doc);
      writeJson(answersPath(dir), { scope: { "D-1": { decision, at: "t" } } });
    }

    it("그 요구에 걸린 차이를 사람이 drop 으로 결정했으면 면제한다", () => {
      const c = make();
      dropRequirement(c.dir, "drop");
      const doc = clone(buildScenarios());
      doc.scenarios = doc.scenarios.filter((s: Doc) => s.id !== "시나리오-1");
      doc.questions[0].affects = ["요구-1"];
      expect(rejects(c.run(doc))).toEqual([]);
    });

    it("drop 이 아닌 결정은 면제하지 않는다", () => {
      const c = make();
      dropRequirement(c.dir, "hold");
      const doc = clone(buildScenarios());
      doc.scenarios = doc.scenarios.filter((s: Doc) => s.id !== "시나리오-1");
      doc.questions[0].affects = ["요구-1"];
      expect(rejects(c.run(doc))).toEqual(["ac_uncovered"]);
    });
  });

  describe("scenario_ref_missing", () => {
    it("없는 요구", () => expectReject("scenario_ref_missing", (d) => sc(d, "시나리오-1").requirement_ids.push("요구-9")));
    it("없는 인수 조건", () => expectReject("scenario_ref_missing", (d) => sc(d, "시나리오-2").ac_ids.push("요구-1/AC-9")));
    it("인수 조건이 속한 요구가 requirement_ids 에 없다", () => {
      const issues = expectReject("scenario_ref_missing", (d) => sc(d, "시나리오-2").ac_ids.push("요구-3/AC-1"));
      expect(issues.find((i) => i.code === "scenario_ref_missing")?.message).toContain("요구-3");
    });
    it("없는 화면(단계)", () => expectReject("scenario_ref_missing", (d) => (sc(d, "시나리오-1").steps[0].screen_id = "화면-9")));
    it("없는 화면(기대 결과)", () => expectReject("scenario_ref_missing", (d) => (sc(d, "시나리오-1").expected[0].screen_id = "화면-9.1")));
    it("상태 변형 id 는 화면으로 받아들인다", () => {
      const doc = clone(buildScenarios());
      sc(doc, "시나리오-1").expected[0].screen_id = "화면-1.1";
      expect(rejects(make().run(doc))).toEqual([]);
    });
    it("질문의 affects 가 없는 요구", () => expectReject("scenario_ref_missing", (d) => d.questions[0].affects.push("요구-9")));
    it("질문의 affects 가 없는 시나리오", () => expectReject("scenario_ref_missing", (d) => d.questions[0].affects.push("시나리오-9")));
    it("질문의 affects 는 요구 id 도 받아들인다", () => {
      const doc = clone(buildScenarios());
      doc.questions[0].affects = ["요구-1", "시나리오-2"];
      expect(rejects(make().run(doc))).toEqual([]);
    });
  });

  describe("id_format, id_duplicate", () => {
    it("시나리오 id 형식", () => expectReject("id_format", (d) => (sc(d, "시나리오-2").id = "시나리오-02")));
    it("기대 결과 id 형식", () => expectReject("id_format", (d) => (sc(d, "시나리오-1").expected[0].id = "E-1")));
    it("기대 결과 id 의 앞부분이 소속 시나리오와 다르다", () => expectReject("id_format", (d) => (sc(d, "시나리오-1").expected[0].id = "시나리오-2/E-9")));
    it("질문 id 형식", () => expectReject("id_format", (d) => (d.questions[0].id = "질문-3")));
    it("시나리오 id 중복", () => expectReject("id_duplicate", (d) => d.scenarios.push(clone(sc(d, "시나리오-3")))));
    it("기대 결과 id 중복", () => expectReject("id_duplicate", (d) => (sc(d, "시나리오-1").expected[1].id = "시나리오-1/E-1")));
    it("질문 id 중복", () => expectReject("id_duplicate", (d) => d.questions.push(clone(d.questions[0]))));
    it("분석 문서의 질문 id 와 겹침", () => expectReject("id_duplicate", (d) => (d.questions[0].id = "Q-1")));
  });

  describe("expected_empty, steps_empty", () => {
    it("기대 결과가 없다", () => expectReject("expected_empty", (d) => (sc(d, "시나리오-1").expected = [])));
    it("기대 결과 text 가 비었다", () => expectReject("expected_empty", (d) => (sc(d, "시나리오-1").expected[0].text = "  ")));
    it("expected 칸을 빼도 같다", () => expectReject("expected_empty", (d) => delete sc(d, "시나리오-1").expected));
    it("steps 가 비었다", () => expectReject("steps_empty", (d) => (sc(d, "시나리오-1").steps = [])));
  });

  describe("mock_without_reason", () => {
    it("이유가 비었다", () => expectReject("mock_without_reason", (d) => (sc(d, "시나리오-3").mock.reason = " ")));
    it("엔드포인트가 비었다", () => expectReject("mock_without_reason", (d) => (sc(d, "시나리오-3").mock.endpoints = [])));
    it("mock 칸이 통째로 없다", () => {
      const issues = expectReject("mock_without_reason", (d) => delete sc(d, "시나리오-3").mock);
      expect(issues.filter((i) => i.code === "mock_without_reason")).toHaveLength(2);
    });
  });

  describe("real_without_presence", () => {
    it("environment 가 없다", () => expectReject("real_without_presence", (d) => delete sc(d, "시나리오-1").environment));
    it("API 가 모두 그 환경에서 없다(false)", () => {
      const issues = expectReject("real_without_presence", (d) => (sc(d, "시나리오-1").environment = "prod"));
      expect(codes(issues)).toContain("environment_differs");
    });
    it("API 가 모두 그 환경 키가 없다", () => expectReject("real_without_presence", (d) => (sc(d, "시나리오-1").environment = "staging")));
    it("API 가 하나라도 그 환경에 있으면 통과한다", () => {
      const c = make();
      const analysis = readAnalysis(c.dir);
      analysis.items.impact.apis.push({ method: "GET", path: "/v1/other", fields: [], presence: { prod: true } });
      writeJson(runPaths(c.dir).analysis, analysis);
      const doc = clone(buildScenarios());
      sc(doc, "시나리오-1").environment = "prod";
      const issues = c.run(doc);
      expect(rejects(issues)).toEqual([]);
      expect(codes(issues)).toContain("environment_differs");
    });
    it("영향 분석에 API 가 없으면 환경 이름만 있으면 된다", () => {
      const c = make();
      const analysis = readAnalysis(c.dir);
      analysis.items.impact.apis = [];
      writeJson(runPaths(c.dir).analysis, analysis);
      const issues = c.run(clone(buildScenarios()));
      expect(rejects(issues)).toEqual([]);
      expect(codes(issues)).not.toContain("environment_differs");
    });
  });

  describe("질문", () => {
    it("origin 이 qa 가 아니다", () => expectReject("question_origin", (d) => (d.questions[0].origin = "analysis")));
    it("선택지도 affects 도 없다", () =>
      expectReject("question_without_options", (d) => {
        d.questions[0].options = [];
        d.questions[0].affects = [];
      }));
    it("선택지에 consequence 가 없다", () => expectReject("question_without_options", (d) => (d.questions[0].options[0].consequence = "")));
  });
});

describe("scenarios 검사: 경고와 정보", () => {
  it("mock_ignored: real 인데 mock 이 채워져 있다", () => {
    expectWarn("mock_ignored", (d) => (sc(d, "시나리오-1").mock = { endpoints: [{ method: "GET", path: "/v1/x", case: "c" }], reason: "r" }));
  });

  it("environment_differs: 분석이 고른 환경과 다르지만 API 는 있다", () => {
    const c = make();
    const analysis = readAnalysis(c.dir);
    analysis.items.impact.apis[0].presence.prod = true;
    writeJson(runPaths(c.dir).analysis, analysis);
    const doc = clone(buildScenarios());
    sc(doc, "시나리오-1").environment = "prod";
    const issues = c.run(doc);
    expect(rejects(issues)).toEqual([]);
    expect(issues.find((i) => i.code === "environment_differs")).toMatchObject({ severity: "warn", ref: "시나리오-1" });
  });

  it("mock_only_requirement: 요구를 덮는 시나리오가 모두 mock 이다", () => {
    const issues = expectWarn("mock_only_requirement", (d) => {
      const s = sc(d, "시나리오-2");
      s.backend = "mock";
      s.mock = { endpoints: [{ method: "GET", path: "/v1/banners", case: "배너 6개" }], reason: "배너 6개를 만들 수 없다" };
    });
    expect(issues.filter((i) => i.code === "mock_only_requirement").map((i) => i.ref)).toEqual(["요구-1", "요구-2"]);
  });

  it("mock_only_requirement: real 시나리오가 하나라도 있으면 경고가 없다", () => {
    expect(codes(make().run(buildScenarios()))).not.toContain("mock_only_requirement");
  });

  it("reach_unknown", () => {
    const issues = expectWarn("reach_unknown", (d) => (sc(d, "시나리오-3").reach = "unknown"));
    expect(issues.find((i) => i.code === "reach_unknown")?.ref).toBe("시나리오-3");
  });

  it("accounts_unavailable: 되지 않는 계정을 묻는 질문이 없으면 경고", () => {
    const issues = expectWarn("accounts_unavailable", (d) => {
      d.questions = [];
    });
    expect(issues.find((i) => i.code === "accounts_unavailable")?.severity).toBe("warn");
  });

  it("accounts_unavailable: 계정이 모두 되면 아무것도 내지 않는다", () => {
    const doc = clone(buildScenarios());
    for (const a of doc.accounts) a.available = true;
    expect(make().run(doc)).toEqual([]);
  });
});

describe("scenarios 검사: 사람이 바꾼 backend", () => {
  it("mock 으로 바꾸면 mock 검사를 받는다", () => {
    const c = make();
    writeJson(answersPath(c.dir), { scenarios: { "시나리오-1": { backend: "mock", at: "t" } } });
    const issues = c.run(clone(buildScenarios()));
    expect(rejects(issues)).toEqual(["mock_without_reason"]);
    expect(issues.filter((i) => i.code === "mock_without_reason" && i.ref === "시나리오-1")).toHaveLength(2);
  });

  it("real 로 바꾸면 environment 검사를 받고 mock 칸은 무시한다", () => {
    const c = make();
    writeJson(answersPath(c.dir), { scenarios: { "시나리오-3": { backend: "real", at: "t" } } });
    const issues = c.run(clone(buildScenarios()));
    expect(rejects(issues)).toEqual(["real_without_presence"]);
    expect(codes(issues)).toContain("mock_ignored");
  });

  it("바꾼 값이 요구의 mock_only 판정에 반영된다", () => {
    const c = make();
    writeJson(answersPath(c.dir), { scenarios: { "시나리오-2": { backend: "mock", at: "t" } } });
    const doc = clone(buildScenarios());
    sc(doc, "시나리오-2").mock = { endpoints: [{ method: "GET", path: "/v1/banners", case: "배너 6개" }], reason: "배너 6개를 만들 수 없다" };
    const issues = c.run(doc);
    expect(rejects(issues)).toEqual([]);
    expect(issues.filter((i) => i.code === "mock_only_requirement").map((i) => i.ref)).toEqual(["요구-1", "요구-2"]);
  });

  it("real·mock 이 아닌 값은 제출한 값을 쓰고 경고한다", () => {
    const c = make();
    writeJson(answersPath(c.dir), { scenarios: { "시나리오-1": { backend: "fake", at: "t" } } });
    const issues = c.run(clone(buildScenarios()));
    expect(rejects(issues)).toEqual([]);
    expect(issues.find((i) => i.code === "backend_override_invalid")).toMatchObject({ severity: "warn", ref: "시나리오-1" });
  });
});

describe("scenarios 검사: 게이트 게시 뒤 질문 철회", () => {
  function published(): Case {
    const c = make();
    submitArtifact({ runDir: c.dir, kind: "scenarios", file: writeItemsFile(c.dir, "first.json", buildScenarios()) });
    setState(c.dir, "gate_answering");
    return c;
  }
  const withoutQuestion = (): Doc => {
    const d = clone(buildScenarios());
    d.questions = [];
    return d;
  };

  it("게시 전에는 질문을 지워도 된다", () => {
    const c = make();
    submitArtifact({ runDir: c.dir, kind: "scenarios", file: writeItemsFile(c.dir, "first.json", buildScenarios()) });
    expect(rejects(c.run(withoutQuestion()))).toEqual([]);
  });

  it("--withdraw 없이 사라지면 id_removed", () => {
    const c = published();
    const issues = c.run(withoutQuestion());
    expect(rejects(issues)).toEqual(["id_removed"]);
    expect(issues.find((i) => i.code === "id_removed")?.ref).toBe("Q-3");
  });

  it("--withdraw 로 명시하면 item_withdrawn 경고", () => {
    const c = published();
    const issues = c.run(withoutQuestion(), ["Q-3"]);
    expect(rejects(issues)).toEqual([]);
    expect(issues.find((i) => i.code === "item_withdrawn")).toMatchObject({ severity: "warn", ref: "Q-3" });
  });

  it("사람의 답이 있는 질문은 철회해도 withdraw_has_human_input", () => {
    const c = published();
    writeJson(answersPath(c.dir), { answers: { "Q-3": { option: "a", at: "t" } } });
    expect(rejects(c.run(withoutQuestion(), ["Q-3"]))).toEqual(["withdraw_has_human_input"]);
  });
});
