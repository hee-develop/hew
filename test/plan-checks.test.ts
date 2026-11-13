import { describe, expect, it } from "vitest";
import type { Issue } from "../src/core/errors.js";
import { loadRun } from "../src/core/run.js";
import { planCheck, planScope } from "../src/core/plan/checks.js";
import { loadPlanRules } from "../src/core/plan/rules.js";
import { PlanItemsSchema } from "../src/core/plan/schema.js";
import { sanitizePlan } from "../src/core/plan/sanitize.js";
import { loadAnswers } from "../src/core/analysis/answers.js";
import { AnalysisItemsSchema } from "../src/core/analysis/schema.js";
import { buildAnalysis, answersPath, writeJson, type Doc } from "./analysis-fixtures.js";
import { useTempRunsDir } from "./helpers.js";
import { buildAnswers, buildPlan, clone, setupAnswersApplied } from "./plan-fixtures.js";

useTempRunsDir();

interface Case {
  dir: string;
  run: (doc: Doc) => Issue[];
}

function make(opts: Parameters<typeof setupAnswersApplied>[0] = {}): Case {
  const { dir } = setupAnswersApplied(opts);
  return { dir, run: (doc) => planCheck(doc, { kind: "plan", for: null, run: loadRun(dir), runDir: dir }) };
}

const rejects = (issues: Issue[]): string[] => [...new Set(issues.filter((i) => i.severity === "reject").map((i) => i.code))];
const ticket = (doc: Doc, id: string): Doc => doc.tickets.find((t: Doc) => t.id === id);
const pr = (doc: Doc, id: string): Doc => doc.prs.find((p: Doc) => p.id === id);

/** 변형 하나를 가해 그 코드만 거부로 나오는지 확인한다. */
function expectReject(code: string, mutate: (doc: Doc) => void, opts: Parameters<typeof setupAnswersApplied>[0] = {}): Issue[] {
  const c = make(opts);
  const doc = clone(buildPlan());
  mutate(doc);
  const issues = c.run(doc);
  expect(rejects(issues)).toEqual([code]);
  return issues;
}

/** 변형 하나를 가해 거부 없이 그 코드가 경고로 나오는지 확인한다. */
function expectWarn(code: string, mutate: (doc: Doc) => void, opts: Parameters<typeof setupAnswersApplied>[0] = {}): Issue[] {
  const c = make(opts);
  const doc = clone(buildPlan());
  mutate(doc);
  const issues = c.run(doc);
  expect(rejects(issues)).toEqual([]);
  expect(issues.filter((i) => i.code === code && i.severity === "warn").length).toBeGreaterThan(0);
  return issues;
}

const hold = (id: string) => (a: Doc): void => {
  a.scope[id] = { decision: "hold", at: "2026-11-14T09:00:00.000Z" };
};

describe("plan 검사: 통과", () => {
  it("합성 분해안은 거부 0, 경고 0 이다", () => {
    expect(make().run(buildPlan())).toEqual([]);
  });

  it("정본 analysis 가 없으면 analysis_missing 하나만 거부한다", () => {
    const { dir } = make();
    const issues = planCheck(buildPlan(), { kind: "plan", for: null, run: loadRun(dir), runDir: `${dir}/없는곳` });
    expect(issues.map((i) => i.code)).toEqual(["analysis_missing"]);
  });

  it("스키마가 틀리면 schema_invalid 만 낸다", () => {
    const c = make();
    const issues = c.run({ epic_name: "x" });
    expect(rejects(issues)).toEqual(["schema_invalid"]);
  });

  it("분해 규칙 파일은 값과 정규식을 가진다", () => {
    const rules = loadPlanRules();
    expect(rules.sp).toEqual({ min: 2, max: 4, hours_per_sp: 1 });
    expect(rules.title_pattern).toBe("^\\[MO\\] .+ / .+$");
    expect(rules.pr.max_tickets).toBe(6);
    expect(rules.body_forbidden.length).toBeGreaterThanOrEqual(6);
  });
});

describe("plan 검사: 거부 코드 하나씩", () => {
  it("requirement_unmapped: 변경 항목을 맡은 티켓이 없다", () => {
    const issues = expectReject("requirement_unmapped", (d) => {
      d.tickets = d.tickets.filter((t: Doc) => t.id !== "T4");
      pr(d, "PR-2").ticket_ids = ["T3"];
      ticket(d, "T5").depends_on = ["T3"];
    });
    expect(issues.find((i) => i.code === "requirement_unmapped")?.ref).toBe("요구-3#0");
  });

  it("requirement_unmapped: changes 로 일부만 맡았는데 나머지를 맡은 티켓이 없다", () => {
    const issues = expectReject("requirement_unmapped", (d) => {
      d.tickets = d.tickets.filter((t: Doc) => t.id !== "T2");
      pr(d, "PR-1").ticket_ids = ["T1"];
    });
    expect(issues.find((i) => i.code === "requirement_unmapped")?.ref).toBe("요구-1#1");
  });

  it("changes 없이 요구를 적은 티켓은 그 요구의 변경 전부를 맡은 것이다", () => {
    const c = make();
    const doc = clone(buildPlan());
    ticket(doc, "T1").changes = [];
    doc.tickets = doc.tickets.filter((t: Doc) => t.id !== "T2");
    pr(doc, "PR-1").ticket_ids = ["T1"];
    expect(rejects(c.run(doc))).toEqual([]);
  });

  it("ticket_orphan: 요구가 없고 플래그 제거 티켓도 아니다", () => {
    expectReject("ticket_orphan", (d) => {
      ticket(d, "T4").requirement_ids = [];
      d.tickets.push({ ...clone(ticket(d, "T4")), id: "T6" });
      ticket(d, "T6").requirement_ids = ["요구-3"];
      pr(d, "PR-2").ticket_ids.push("T6");
      ticket(d, "T6").pr = "PR-2";
    });
  });

  it("hold_included: 보류 결정이 걸린 요구를 티켓이 맡았다(그 요구 전체가 범위 밖)", () => {
    const issues = expectReject("hold_included", () => {}, { answers: hold("D-1") });
    expect(issues.some((i) => i.code === "hold_included" && i.ref === "T3")).toBe(true);
    // 요구-2 가 excluded 에 없어 경고도 함께 난다.
    expect(issues.some((i) => i.code === "excluded_missing" && i.ref === "요구-2")).toBe(true);
  });

  it("drop 결정도 보류와 같이 범위 밖으로 본다", () => {
    expectReject("hold_included", () => {}, { answers: (a) => (a.scope["D-2"] = { decision: "drop", at: "2026-11-14T09:00:00.000Z" }) });
  });

  it("보류된 요구의 티켓을 빼고 excluded 에 적으면 통과한다(requirement_unmapped 도 없다)", () => {
    const c = make({ answers: hold("D-1") });
    const doc = clone(buildPlan());
    doc.tickets = doc.tickets.filter((t: Doc) => t.id !== "T3");
    pr(doc, "PR-2").ticket_ids = ["T4"];
    ticket(doc, "T5").depends_on = ["T4"];
    doc.excluded = [{ kind: "delta", ref: "D-1", reason: "보류" }];
    expect(c.run(doc)).toEqual([]);
  });

  it("excluded_missing(경고): 범위 밖 요구가 excluded 에 없다. 요구·변경 항목으로 적어도 인정된다", () => {
    const base = (d: Doc): void => {
      d.tickets = d.tickets.filter((t: Doc) => t.id !== "T3");
      pr(d, "PR-2").ticket_ids = ["T4"];
      ticket(d, "T5").depends_on = ["T4"];
    };
    expectWarn("excluded_missing", base, { answers: hold("D-1") });
    for (const excluded of [{ kind: "requirement", ref: "요구-2", reason: "보류" }, { kind: "change", ref: "요구-2#0", reason: "보류" }]) {
      const c = make({ answers: hold("D-1") });
      const doc = clone(buildPlan());
      base(doc);
      doc.excluded = [excluded];
      expect(c.run(doc).filter((i) => i.code === "excluded_missing")).toEqual([]);
    }
  });

  it("title_format: 패턴 불일치", () => {
    expectReject("title_format", (d) => (ticket(d, "T2").title = "배너 노출 / 빈 상태"));
  });

  it("title_format: 일감명이 epic_name 과 다르다", () => {
    const issues = expectReject("title_format", (d) => (ticket(d, "T2").title = "[MO] 다른 일감 / 빈 상태"));
    expect(issues[0]?.message).toContain("epic_name");
  });

  it("body_sections: 배경이 비었다", () => {
    expectReject("body_sections", (d) => (ticket(d, "T1").body.background = "  "));
  });

  it("body_sections: 작업 내용이 비었다", () => {
    expectReject("body_sections", (d) => (ticket(d, "T1").body.work = []));
  });

  it("body_code_detail: 확장자·경로·줄 번호·함수 호출 모양을 걸러 내고 걸린 문구를 메시지에 싣는다", () => {
    const cases: [string, string][] = [
      ["Home.tsx 를 고친다", ".tsx"],
      ["app/screens/Home 을 고친다", "app/screens/Home"],
      ["Home.tsx:42 근처를 본다", "Home.tsx:42"],
      ["line 12 를 본다", "line 12"],
      ["12번째 줄을 본다", "12번째 줄"],
      ["renderBanner() 를 호출한다", "renderBanner()"],
    ];
    for (const [text, hit] of cases) {
      const issues = expectReject("body_code_detail", (d) => ticket(d, "T1").body.work.push(text));
      expect(issues.some((i) => i.message.includes(`"${hit}"`))).toBe(true);
    }
  });

  it("body_code_detail: 배경·확인 사항·선행 의존 문자열도 본다", () => {
    expectReject("body_code_detail", (d) => (ticket(d, "T1").body.background = "src/home 에서 시작한다"));
    expectReject("body_code_detail", (d) => (ticket(d, "T1").body.checks = ["data.json 을 본다"]));
    expectReject("body_code_detail", (d) => (ticket(d, "T2").body.depends_note = "init() 이 먼저"));
  });

  it("본문에 시각(10:30)이나 일반 숫자가 있어도 줄 번호로 오인하지 않는다", () => {
    const c = make();
    const doc = clone(buildPlan());
    ticket(doc, "T1").body.work.push("오전 10:30 에 배너가 바뀐다", "5개까지 노출한다");
    expect(rejects(c.run(doc))).toEqual([]);
  });

  it("dependency_cycle: 티켓 의존 순환", () => {
    expectReject("dependency_cycle", (d) => {
      ticket(d, "T3").depends_on = ["T1", "T4"];
      ticket(d, "T4").depends_on = ["T3"];
    });
  });

  it("dependency_cycle: 자기 자신에 의존", () => {
    expectReject("dependency_cycle", (d) => (ticket(d, "T4").depends_on = ["T4"]));
  });

  it("dependency_cycle: PR base 사슬 순환", () => {
    const c = make();
    const doc = clone(buildPlan());
    pr(doc, "PR-1").base = "PR-3";
    const codes = rejects(c.run(doc));
    expect(codes).toContain("dependency_cycle");
  });

  it("plan_ref_missing: 없는 티켓·PR·요구를 가리킨다", () => {
    expectReject("plan_ref_missing", (d) => (ticket(d, "T4").depends_on = ["T9"]));
    expectReject("plan_ref_missing", (d) => pr(d, "PR-2").ticket_ids.push("T9"));
    expectReject("plan_ref_missing", (d) => (pr(d, "PR-2").base = "PR-9"));
    expectReject("plan_ref_missing", (d) => (ticket(d, "T4").requirement_ids = ["요구-3", "요구-9"]));
    expectReject("plan_ref_missing", (d) => ticket(d, "T2").changes.push({ requirement_id: "요구-1", index: 9 }));
    expectReject("plan_ref_missing", (d) => (ticket(d, "T1").changes = [{ requirement_id: "요구-2", index: 0 }]));
  });

  it("plan_ref_missing: 없는 티켓을 removal_ticket 으로 지정하면 플래그 검사도 함께 걸린다", () => {
    const c = make();
    const doc = clone(buildPlan());
    doc.feature_flag.removal_ticket = "T9";
    ticket(doc, "T5").requirement_ids = ["요구-3"];
    expect(rejects(c.run(doc)).sort()).toEqual(["flag_removal_last", "plan_ref_missing"]);
  });

  it("pr_base_order: 의존하는 티켓의 PR 이 먼저 병합된다", () => {
    const issues = expectReject("pr_base_order", (d) => {
      ticket(d, "T5").depends_on = ["T3"];
      ticket(d, "T4").depends_on = ["T5"];
    });
    expect(issues.find((i) => i.code === "pr_base_order")?.ref).toBe("T4");
  });

  it("pr_base_order: base PR 의 순서가 더 크거나 같다", () => {
    const issues = expectReject("pr_base_order", (d) => (pr(d, "PR-3").order = 2));
    expect(issues.find((i) => i.code === "pr_base_order")?.ref).toBe("PR-3");
  });

  it("pr_base_order: 같은 PR 의 티켓끼리는 통과한다", () => {
    const c = make();
    expect(rejects(c.run(buildPlan()))).toEqual([]);
  });

  it("ticket_without_pr: 티켓의 pr 이 없는 PR 이다", () => {
    expectReject("ticket_without_pr", (d) => (ticket(d, "T4").pr = "PR-9"));
  });

  it("pr_ticket_mismatch: 티켓의 pr 과 PR 의 ticket_ids 가 맞지 않는다", () => {
    expectReject("pr_ticket_mismatch", (d) => (pr(d, "PR-2").ticket_ids = ["T3"]));
    expectReject("pr_ticket_mismatch", (d) => pr(d, "PR-1").ticket_ids.push("T4"));
  });

  it("flag_removal_last: 플래그를 쓰는데 removal_ticket 이 없다", () => {
    expectReject("flag_removal_last", (d) => {
      delete d.feature_flag.removal_ticket;
      ticket(d, "T5").requirement_ids = ["요구-3"];
    });
  });

  it("flag_removal_last: 제거 티켓의 PR 이 마지막 순서가 아니다", () => {
    const issues = expectReject("flag_removal_last", (d) => {
      ticket(d, "T4").pr = "PR-4";
      pr(d, "PR-2").ticket_ids = ["T3"];
      d.prs.push({ id: "PR-4", title: "가격", ticket_ids: ["T4"], base: "PR-3", order: 4 });
      ticket(d, "T5").depends_on = ["T3"];
    });
    expect(issues.find((i) => i.code === "flag_removal_last")?.ref).toBe("T5");
  });

  it("플래그를 쓰지 않으면 제거 티켓이 없어도 된다", () => {
    const c = make();
    const doc = clone(buildPlan());
    doc.feature_flag = { used: false };
    doc.tickets = doc.tickets.filter((t: Doc) => t.id !== "T5");
    pr(doc, "PR-3").ticket_ids = [];
    doc.prs = doc.prs.filter((p: Doc) => p.id !== "PR-3");
    expect(rejects(c.run(doc))).toEqual([]);
  });

  it("requirement_dependency_broken: 요구의 의존 순서가 PR 순서에서 뒤집혔다", () => {
    expectReject("requirement_dependency_broken", (d) => {
      // 요구-2(T3)가 요구-1(T1·T2)에 의존하는데 T3 의 PR 을 앞으로 보낸다. 티켓 의존 T3→T1 도 끊는다.
      ticket(d, "T3").depends_on = [];
      ticket(d, "T3").pr = "PR-4";
      pr(d, "PR-2").ticket_ids = ["T4"];
      d.prs.push({ id: "PR-4", title: "개수", ticket_ids: ["T3"], base: "develop", order: 0 });
    });
  });

  it("id_format: 티켓·PR id 형식", () => {
    const c = make();
    const doc = clone(buildPlan());
    ticket(doc, "T4").id = "티켓4";
    pr(doc, "PR-2").ticket_ids = ["T3", "티켓4"];
    expect(rejects(c.run(doc))).toContain("id_format");
    const doc2 = clone(buildPlan());
    pr(doc2, "PR-3").id = "P3";
    expect(rejects(c.run(doc2))).toContain("id_format");
  });

  it("id_duplicate: 티켓·PR id 중복", () => {
    const c = make();
    const doc = clone(buildPlan());
    doc.tickets.push(clone(ticket(doc, "T4")));
    expect(rejects(c.run(doc))).toContain("id_duplicate");
    const doc2 = clone(buildPlan());
    doc2.prs.push(clone(pr(doc2, "PR-3")));
    expect(rejects(c.run(doc2))).toContain("id_duplicate");
  });
});

describe("plan 검사: 경고와 정보", () => {
  it("sp_range: 범위를 벗어난 SP", () => {
    expectWarn("sp_range", (d) => (ticket(d, "T4").sp = 1));
    expectWarn("sp_range", (d) => (ticket(d, "T4").sp = 5));
  });

  it("pr_too_large: PR 의 티켓 수가 상한을 넘는다", () => {
    expectWarn("pr_too_large", (d) => {
      for (let n = 6; n <= 10; n += 1) {
        d.tickets.push({ ...clone(ticket(d, "T4")), id: `T${n}`, pr: "PR-2" });
        pr(d, "PR-2").ticket_ids.push(`T${n}`);
        ticket(d, "T5").depends_on.push(`T${n}`);
      }
    });
  });

  it("plan_change_unaddressed(정보): 수정 요청 수만 알린다", () => {
    const issues = make({
      answers: (a) => a.plan_requests.push({ target: "T1", text: "제목을 줄여 주세요", at: "2026-11-15T09:00:00.000Z" }, { target: "전체", text: "SP 를 낮춰 주세요", at: "2026-11-15T09:01:00.000Z" }),
    }).run(buildPlan());
    const info = issues.filter((i) => i.code === "plan_change_unaddressed");
    expect(info).toHaveLength(1);
    expect(info[0]).toMatchObject({ severity: "info" });
    expect(info[0]?.message).toContain("2건");
    expect(rejects(issues)).toEqual([]);
  });
});

describe("plan 범위 계산과 스키마", () => {
  it("planScope: drop·hold 인 차이의 요구 전체가 범위 밖이고 follow 는 범위 안이다", () => {
    const analysis = AnalysisItemsSchema.parse(buildAnalysis());
    const answers = buildAnswers();
    answers.scope["D-1"] = { decision: "drop", at: "t" };
    const { dir } = setupAnswersApplied({ answers: (a) => Object.assign(a, { scope: answers.scope }) });
    const scope = planScope(analysis, loadAnswers(dir));
    expect([...scope.outOfScope]).toEqual(["요구-2"]);
    expect(scope.deltasOf.get("요구-2")).toEqual(["D-1"]);
    writeJson(answersPath(dir), { ...buildAnswers(), scope: { "D-1": { decision: "hold", at: "t" }, "D-2": { decision: "hold", at: "t" } } });
    expect([...planScope(analysis, loadAnswers(dir)).outOfScope].sort()).toEqual(["요구-1", "요구-2"]);
  });

  it("합성 분해안은 스키마를 통과하고 알 수 없는 키는 떨어뜨리며 경고한다", () => {
    expect(PlanItemsSchema.safeParse(buildPlan()).success).toBe(true);
    const doc = clone(buildPlan());
    doc.extra = 1;
    ticket(doc, "T1").body.memo = "x";
    const { raw, issues } = sanitizePlan(doc);
    expect(issues.map((i) => i.code)).toEqual(["unknown_field_dropped", "unknown_field_dropped"]);
    expect((raw as Doc).extra).toBeUndefined();
    expect(ticket(raw as Doc, "T1").body.memo).toBeUndefined();
  });
});
