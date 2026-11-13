import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analysisCheck, normalizeText } from "../src/core/analysis/checks.js";
import type { Issue } from "../src/core/errors.js";
import { runPaths } from "../src/core/paths.js";
import { loadRun } from "../src/core/run.js";
import type { RunState } from "../src/core/state-machine.js";
import { answersPath, buildAnalysis, buildUnits, clone, IMG, setupRun, writeJson, type Doc, type SetupOptions } from "./analysis-fixtures.js";
import { useTempRunsDir } from "./helpers.js";

useTempRunsDir();

interface Case {
  dir: string;
  run: (doc: Doc, withdraw?: string[]) => Issue[];
}

function make(opts: SetupOptions = {}): Case {
  const { dir } = setupRun(opts);
  return { dir, run: (doc, withdraw) => analysisCheck(doc, { kind: "analysis", for: null, run: loadRun(dir), runDir: dir, withdraw }) };
}

const rejects = (issues: Issue[]): string[] => [...new Set(issues.filter((i) => i.severity === "reject").map((i) => i.code))];
const codes = (issues: Issue[]): string[] => [...new Set(issues.map((i) => i.code))];

/** 변형 하나를 가해 그 코드가 거부로 나오고 다른 거부는 없음을 확인한다. */
function expectReject(code: string, mutate: (doc: Doc) => void, opts: SetupOptions = {}): Issue[] {
  const c = make(opts);
  const doc = clone(buildAnalysis());
  mutate(doc);
  const issues = c.run(doc);
  expect(rejects(issues)).toEqual([code]);
  return issues;
}

/** 변형 하나를 가해 그 코드가 경고로 나오고 거부는 없음을 확인한다. */
function expectWarn(code: string, mutate: (doc: Doc) => void, opts: SetupOptions = {}): Issue[] {
  const c = make(opts);
  const doc = clone(buildAnalysis());
  mutate(doc);
  const issues = c.run(doc);
  expect(rejects(issues)).toEqual([]);
  expect(issues.find((i) => i.code === code)?.severity).toBe("warn");
  return issues;
}

describe("통과", () => {
  it("완전한 분석 문서는 거부 없이 통과하고 정보 지적 mismatch_ratio 만 남는다", () => {
    const issues = make().run(buildAnalysis());
    expect(rejects(issues)).toEqual([]);
    expect(codes(issues)).toEqual(["mismatch_ratio"]);
  });

  it("공백·줄바꿈·Markdown 강조 표시를 지우고 대조한다", () => {
    expect(normalizeText("**가** `나`\n__다__ 라")).toBe("가나다라");
    const doc = buildAnalysis();
    doc.requirements[0].changes[0].evidence[0].quote = "배너를\n노출 한다";
    expect(rejects(make().run(doc))).toEqual([]);
  });

  it("운영자 행도 Mobile(App) 열이 채워져 있으면 근거로 쓸 수 있다", () => {
    const doc = buildAnalysis();
    doc.requirements[0].changes[0].evidence = [{ unit_id: "U-9", quote: "앱 설정 노출" }];
    expect(rejects(make().run(doc))).toEqual([]);
  });

  it("이미지 근거는 단위에 image 가 있거나 파일이 실행 폴더에 있으면 통과한다", () => {
    const c = make();
    const doc = buildAnalysis();
    doc.requirements[0].changes[1].evidence = [{ unit_id: "U-7", image: "sources/figma/none.png" }];
    expect(rejects(c.run(doc))).toEqual(["quote_not_found"]);
    mkdirSync(join(c.dir, "sources", "figma"), { recursive: true });
    writeFileSync(join(c.dir, "sources", "figma", "none.png"), "x");
    expect(rejects(c.run(doc))).toEqual([]);
  });

  it("ai.code 의 modify·reuse 경로가 저장소에 있으면 통과한다", () => {
    const c = make({ repoPath: "" });
    const repo = join(c.dir, "repo");
    mkdirSync(join(repo, "app"), { recursive: true });
    writeFileSync(join(repo, "app", "Home.tsx"), "");
    writeJson(runPaths(c.dir).runJson, { ...loadRun(c.dir), repo: { path: repo, base: null } });
    const doc = buildAnalysis();
    doc.requirements[0].ai.code = [{ path: "app/Home.tsx", role: "modify" }];
    expect(rejects(c.run(doc))).toEqual([]);
  });
});

describe("스키마", () => {
  it("스키마에 맞지 않으면 schema_invalid 만 낸다", () => {
    const doc = buildAnalysis();
    doc.requirements[0].status = "maybe";
    expect(codes(make().run(doc))).toEqual(["schema_invalid"]);
  });

  it("근거는 인용 또는 이미지 형태여야 한다", () => {
    const doc = buildAnalysis();
    doc.requirements[0].changes[0].evidence = [{ unit_id: "U-1" }];
    expect(codes(make().run(doc))).toEqual(["schema_invalid"]);
  });
});

describe("id", () => {
  it("id_format: 형식이 틀린 id", () => {
    expectReject("id_format", (d) => {
      d.questions[1].id = "질문-2";
      d.impact.blockers[0].question_id = "질문-2";
    });
  });
  it("id_format: 인수 조건 id 의 앞부분이 요구 id 와 다르다", () => {
    expectReject("id_format", (d) => {
      d.requirements[0].acceptance[0].id = "요구-2/AC-5";
      d.requirements[0].ai.verify = [];
    });
  });
  it("id_format: 변형 id 의 앞부분이 화면 id 와 다르다", () => {
    expectReject("id_format", (d) => {
      d.screens[0].variants[0].id = "화면-2.1";
      d.requirements[0].changes[1].screen_id = "화면-2.1";
    });
  });
  it("id_duplicate: 같은 종류 안의 id 중복", () => {
    expectReject("id_duplicate", (d) => {
      d.assumptions.push({ ...d.assumptions[0] });
    });
  });
});

describe("참조", () => {
  const cases: [string, (d: Doc) => void][] = [
    ["요구의 screen_ids", (d) => (d.requirements[0].screen_ids = ["화면-9"])],
    ["변경 항목의 screen_id", (d) => (d.requirements[0].changes[0].screen_id = "화면-1.9")],
    ["depends_on", (d) => (d.requirements[1].depends_on = ["요구-9"])],
    ["차이의 requirement_ids", (d) => (d.deltas[0].requirement_ids = ["요구-9"])],
    ["질문의 affects", (d) => (d.questions[0].affects = ["요구-9"])],
    ["가정의 requirement_ids", (d) => (d.assumptions[0].requirement_ids = ["요구-9"])],
    ["범위 장부의 unit_ids", (d) => (d.coverage[2].unit_ids = ["U-5", "U-9", "U-99"])],
    ["범위 장부의 requirement_ids", (d) => (d.coverage[0].requirement_ids = ["요구-1", "요구-2", "요구-3", "요구-9"])],
    ["범위 장부의 screen_ids", (d) => (d.coverage[3].screen_ids = ["화면-9"])],
    ["범위 장부의 delta_id", (d) => (d.coverage[2].delta_id = "D-9")],
    ["막힘의 question_id", (d) => (d.impact.blockers[0].question_id = "Q-9")],
    ["ai.verify 의 인수 조건", (d) => (d.requirements[0].ai.verify[0].ac_id = "요구-1/AC-9")],
    ["영향 영역의 screen_ids", (d) => (d.impact.areas[0].screen_ids = ["화면-9"])],
    ["근거의 unit_id", (d) => (d.requirements[0].changes[0].evidence[0].unit_id = "U-99")],
    ["차이 근거의 unit_id", (d) => (d.deltas[0].prd_evidence[0].unit_id = "U-99")],
  ];
  for (const [name, mutate] of cases) {
    it(`ref_missing: ${name}`, () => {
      expectReject("ref_missing", mutate);
    });
  }

  it("질문의 affects 에 있는 시나리오 id 는 아직 없어도 허용한다", () => {
    const c = make();
    const doc = buildAnalysis();
    doc.questions[1].affects = ["시나리오-1"];
    expect(rejects(c.run(doc))).toEqual([]);
  });
});

describe("근거", () => {
  it("quote_not_found: 인용이 본문에 없다", () => {
    expectReject("quote_not_found", (d) => (d.requirements[0].changes[0].evidence[0].quote = "존재하지 않는 문장"));
  });
  it("quote_not_found: 인용이 빈 문자열이다", () => {
    expectReject("quote_not_found", (d) => (d.requirements[0].changes[0].evidence[0].quote = " "));
  });
  it("quote_not_found: 질문 rationale 과 차이 근거도 대조한다", () => {
    expectReject("quote_not_found", (d) => (d.questions[0].rationale[0].quote = "없는 문장"));
    expectReject("quote_not_found", (d) => (d.deltas[1].figma_evidence[0].quote = "없는 문장"));
  });
  it("change_without_evidence", () => {
    expectReject("change_without_evidence", (d) => (d.requirements[0].changes[0].evidence = []));
  });
  it("evidence_operator_row: 운영자 행을 근거로 썼다", () => {
    expectReject("evidence_operator_row", (d) => (d.requirements[0].changes[0].evidence = [{ unit_id: "U-2", quote: "어드민에서 입력한다" }]));
  });
  it("evidence_operator_row: 차이·질문·ai.notes 근거에도 적용한다", () => {
    expectReject("evidence_operator_row", (d) => (d.deltas[0].prd_evidence = [{ unit_id: "U-2", quote: "어드민" }]));
    expectReject("evidence_operator_row", (d) => (d.questions[0].rationale = [{ unit_id: "U-2", quote: "어드민" }]));
    expectReject("evidence_operator_row", (d) => (d.requirements[0].ai.notes[0].evidence = [{ unit_id: "U-2", quote: "어드민" }]));
  });
  it("evidence_wrong_lane: 웹·모웹 시안만 근거인 요구는 경고", () => {
    const units = buildUnits();
    units.push({ id: "U-10", source_id: "S-2", kind: "figma_desc", locator: { node_id: "9:9", name: "d" }, text: "웹 전용 문구", platform: "web" });
    const issues = expectWarn(
      "evidence_wrong_lane",
      (d) => {
        d.requirements[2].changes[0].evidence = [{ unit_id: "U-10", quote: "웹 전용 문구" }];
        d.coverage[2].unit_ids.push("U-10");
      },
      { units },
    );
    expect(issues.find((i) => i.code === "evidence_wrong_lane")?.ref).toBe("요구-3");
  });
});

describe("요구와 확정도", () => {
  it("confirmed_with_open: 열린 항목에 걸린 confirmed", () => {
    expectReject("confirmed_with_open", (d) => (d.requirements[0].status = "confirmed"));
  });
  it("pending_without_open: 걸린 열린 항목이 없는 pending 은 경고", () => {
    expectWarn("pending_without_open", (d) => (d.requirements[2].status = "pending"));
  });
  it("ac_missing", () => {
    expectReject("ac_missing", (d) => {
      d.requirements[2].acceptance = [];
    });
  });
  it("ac_without_verify", () => {
    expectReject("ac_without_verify", (d) => delete d.requirements[2].acceptance[0].verify);
  });
  it("ai_note_without_evidence", () => {
    expectReject("ai_note_without_evidence", (d) => (d.requirements[0].ai.notes[0].evidence = []));
  });
  it("ai_code_path_missing: modify·reuse 경로가 저장소에 없다", () => {
    const c = make({ repoPath: "" });
    writeJson(runPaths(c.dir).runJson, { ...loadRun(c.dir), repo: { path: join(c.dir, "repo"), base: null } });
    const doc = buildAnalysis();
    doc.requirements[0].ai.code = [
      { path: "app/Nope.tsx", role: "modify" },
      { path: "app/Nope2.tsx", role: "reuse" },
      { path: "app/Nope3.tsx", role: "reference" },
    ];
    const issues = c.run(doc).filter((i) => i.code === "ai_code_path_missing");
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.severity === "reject")).toBe(true);
  });
  it("repo_path_unset: 저장소 경로가 없으면 검사를 건너뛰고 경고를 한 번 낸다", () => {
    const issues = expectWarn("repo_path_unset", (d) => {
      d.requirements[0].ai.code = [
        { path: "a.ts", role: "modify" },
        { path: "b.ts", role: "reuse" },
      ];
    });
    expect(issues.filter((i) => i.code === "repo_path_unset")).toHaveLength(1);
    expect(codes(issues)).not.toContain("ai_code_path_missing");
  });
});

describe("화면", () => {
  it("screen_without_image: figma_meta 원천이 있는 실행에서만 경고", () => {
    const mutate = (d: Doc): void => {
      d.screens[1].images = [];
    };
    expectWarn("screen_without_image", mutate, { figmaMeta: true });
    expect(codes(make().run((() => { const d = buildAnalysis(); mutate(d); return d; })()))).not.toContain("screen_without_image");
  });
  it("variant_without_change: 변경 항목이 걸리지 않은 변형은 경고", () => {
    expectWarn("variant_without_change", (d) => d.screens[1].variants.push({ id: "화면-2.1", name: "오류", images: [] }));
  });
});

describe("차이", () => {
  it("delta_decision_kind: 추천 결정이 종류에 허용되지 않으면 거부", () => {
    expectReject("delta_decision_kind", (d) => (d.deltas[1].recommendation = { decision: "follow_prd" }));
    expectReject("delta_decision_kind", (d) => (d.deltas[0].recommendation = { decision: "maybe" }));
  });
  it("delta_comparison_missing: 비교 행이 없으면 경고", () => {
    expectWarn("delta_comparison_missing", (d) => delete d.deltas[1].comparison);
    expectWarn("delta_comparison_missing", (d) => (d.deltas[1].comparison.rows = []));
  });
  it("delta_comparison_unpaired: mismatch 인데 짝이 있는 행이 없으면 경고", () => {
    expectWarn("delta_comparison_unpaired", (d) => (d.deltas[0].comparison.rows = [{ aspect: "개수", prd: "5개" }]));
  });
  it("delta_multi_decision: 걸린 요구가 4개 이상이면 경고", () => {
    expectWarn("delta_multi_decision", (d) => {
      for (const n of [4, 5]) {
        d.requirements.push({ ...clone(d.requirements[2]), id: `요구-${n}`, status: "pending", acceptance: [{ id: `요구-${n}/AC-1`, when: "w", then: "t", verify: { method: "review" } }] });
      }
      d.deltas[0].requirement_ids = ["요구-1", "요구-2", "요구-4", "요구-5"];
    });
  });
});

describe("질문", () => {
  it("question_without_options: 선택지도 affects 도 없다", () => {
    expectReject("question_without_options", (d) => {
      d.questions[1].options = [];
    });
  });
  it("question_without_options: 선택지에 consequence 가 없다", () => {
    expectReject("question_without_options", (d) => (d.questions[0].options[0].consequence = ""));
  });
  it("blocker_without_question: 질문으로 이어지지 않은 막힘", () => {
    expectReject("blocker_without_question", (d) => delete d.impact.blockers[0].question_id);
  });
});

describe("범위 장부", () => {
  it("coverage_incomplete: 어느 행에도 없는 단위", () => {
    const issues = expectReject("coverage_incomplete", (d) => (d.coverage[2].unit_ids = ["U-5"]));
    expect(issues.find((i) => i.code === "coverage_incomplete")?.ref).toBe("U-9");
  });
  it("coverage_incomplete: 두 행에 든 단위", () => {
    expectReject("coverage_incomplete", (d) => d.coverage[1].unit_ids.push("U-5"));
  });
  it("coverage_incomplete: 웹·모웹 Figma 단위는 행이 없어도 되고, 앱 Figma 단위는 있어야 한다", () => {
    expectReject("coverage_incomplete", (d) => (d.coverage[3].unit_ids = ["U-6"]));
  });
  it("coverage_covered_without_target", () => {
    expectReject("coverage_covered_without_target", (d) => (d.coverage[3].screen_ids = []));
  });
  it("scope_out_without_quote: not_app 에 reason 이 없다", () => {
    expectReject("scope_out_without_quote", (d) => delete d.coverage[1].reason);
  });
  const outOfScope = (d: Doc, extra: Record<string, unknown>): void => {
    d.coverage[2] = { id: "C-3", unit_ids: ["U-5", "U-9"], disposition: "out_of_scope", requirement_ids: [], screen_ids: [], ...extra };
  };
  it("scope_out_without_quote: out_of_scope 에 quote 가 없거나 본문에 없다", () => {
    expectReject("scope_out_without_quote", (d) => outOfScope(d, { reason: "이번 범위 밖" }));
    expectReject("scope_out_without_quote", (d) => outOfScope(d, { reason: "이번 범위 밖", quote: "없는 문장" }));
    expectReject("scope_out_without_quote", (d) => outOfScope(d, { quote: "배경 설명" }));
  });
  it("out_of_scope 는 행의 단위 본문에 있는 인용이 있으면 통과한다", () => {
    const doc = buildAnalysis();
    outOfScope(doc, { reason: "이번 범위 밖", quote: "배경 설명" });
    expect(rejects(make().run(doc))).toEqual([]);
  });
  it("delta_id 의 사람 결정이 drop 이면 인용 없이 통과한다", () => {
    const c = make();
    const doc = buildAnalysis();
    outOfScope(doc, { reason: "drop 결정", delta_id: "D-2" });
    expect(rejects(c.run(doc))).toEqual(["scope_out_without_quote"]);
    writeJson(answersPath(c.dir), { scope: { "D-2": { decision: "drop", at: "t" } } });
    expect(rejects(c.run(doc))).toEqual([]);
  });
});

describe("영향 분석과 비율", () => {
  it("api_presence_unchecked: presence 가 빈 API", () => {
    expectReject("api_presence_unchecked", (d) => (d.impact.apis[0].presence = {}));
  });
  it("mismatch_ratio: 10% 를 넘으면 확인 요청서 필요를 알린다", () => {
    const issues = make().run(buildAnalysis());
    const info = issues.find((i) => i.code === "mismatch_ratio");
    expect(info).toMatchObject({ severity: "info", ref: null });
    expect(info?.message).toContain("1/3");
    expect(info?.message).toContain("확인 요청서 필요");
  });
  it("mismatch_ratio: 10% 이하이면 필요 없음", () => {
    const doc = buildAnalysis();
    doc.deltas = doc.deltas.filter((d: Doc) => d.kind !== "mismatch");
    const info = make().run(doc).find((i) => i.code === "mismatch_ratio");
    expect(info?.message).not.toContain("확인 요청서 필요");
    expect(info?.message).toContain("0/3");
  });
  it("mismatch_ratio: 같은 요구에 걸린 mismatch 여러 건은 한 번만 센다", () => {
    const doc = buildAnalysis();
    doc.deltas.push({ ...clone(doc.deltas[0]), id: "D-3" });
    expect(make().run(doc).find((i) => i.code === "mismatch_ratio")?.message).toContain("1/3");
  });
});

describe("사람의 답과 열린 항목", () => {
  it("답이 들어오면 confirmed_with_open 이 풀린다", () => {
    const c = make();
    const doc = buildAnalysis();
    doc.requirements[0].status = "confirmed";
    expect(rejects(c.run(doc))).toEqual(["confirmed_with_open"]);
    writeJson(answersPath(c.dir), { answers: { "Q-1": { option: "a", at: "t" } }, scope: { "D-2": { decision: "hold", at: "t" } } });
    expect(rejects(c.run(doc))).toEqual([]);
  });
  it("delta_decision_kind: 사람의 결정이 종류에 허용되지 않으면 경고하고 결정 안 됨으로 다룬다", () => {
    const c = make();
    const doc = buildAnalysis();
    doc.requirements[0].status = "confirmed";
    writeJson(answersPath(c.dir), { answers: { "Q-1": { text: "자유 답", at: "t" } }, scope: { "D-2": { decision: "follow_prd", at: "t" } } });
    const issues = c.run(doc);
    expect(issues.find((i) => i.code === "delta_decision_kind")).toMatchObject({ severity: "warn", ref: "D-2" });
    expect(rejects(issues)).toEqual(["confirmed_with_open"]);
  });
});

describe("게이트 게시 뒤의 재제출", () => {
  const POST: RunState = "answers_complete";
  const prior = (c: Case): void => writeJson(runPaths(c.dir).analysis, { items: buildAnalysis() });
  const withoutD2 = (): Doc => {
    const d = buildAnalysis();
    d.deltas = d.deltas.filter((x: Doc) => x.id !== "D-2");
    return d;
  };

  it("id_removed: --withdraw 없이 사라진 질문·차이·가정", () => {
    const c = make({ state: POST });
    prior(c);
    const issues = c.run(withoutD2());
    expect(rejects(issues)).toEqual(["id_removed"]);
    expect(issues.find((i) => i.code === "id_removed")?.ref).toBe("D-2");
  });
  it("item_withdrawn: 명시적 철회는 사람 입력이 없으면 통과하고 경고를 낸다", () => {
    const c = make({ state: POST });
    prior(c);
    const issues = c.run(withoutD2(), ["D-2"]);
    expect(rejects(issues)).toEqual([]);
    expect(issues.find((i) => i.code === "item_withdrawn")).toMatchObject({ severity: "warn", ref: "D-2" });
  });
  it("withdraw_has_human_input: 사람 입력이 있는 항목의 철회는 거부", () => {
    const c = make({ state: POST });
    prior(c);
    writeJson(answersPath(c.dir), { scope: { "D-2": { decision: "follow_figma", at: "t" } } });
    expect(rejects(c.run(withoutD2(), ["D-2"]))).toEqual(["withdraw_has_human_input"]);
    expect(rejects(c.run(withoutD2()))).toEqual(["id_removed"]);
  });
  it("게이트 게시 전에는 --withdraw 없이도 id 를 바꿀 수 있다", () => {
    for (const state of ["collected", "analyzed", "checked"] as RunState[]) {
      const c = make({ state });
      prior(c);
      expect(rejects(c.run(withoutD2()))).toEqual([]);
    }
  });
  it("게이트 게시 뒤 상태에서 새 항목을 더하는 것은 자유다", () => {
    const c = make({ state: "gate_answering" });
    prior(c);
    const d = buildAnalysis();
    d.assumptions.push({ id: "A-2", text: "t", basis: "b", requirement_ids: ["요구-2"] });
    expect(rejects(c.run(d))).toEqual([]);
  });
});
