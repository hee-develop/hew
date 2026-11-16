import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAnswers } from "../src/core/analysis/answers.js";
import { buildGate } from "../src/core/gate/build.js";
import { importAnswers } from "../src/core/gate/import.js";
import { buildGateModel } from "../src/core/gate/model.js";
import { buildPacket } from "../src/core/packet.js";
import { runPaths } from "../src/core/paths.js";
import { computeRevision } from "../src/core/revision.js";
import { loadRun, saveRun } from "../src/core/run.js";
import type { Doc } from "./analysis-fixtures.js";
import { readTemplate, scriptBlock } from "./gate-helpers.js";
import { useTempRunsDir } from "./helpers.js";
import { blockIssue, buildPlan, clone, planSasu, setupPlanned, submitPlan, submitPlanAll } from "./plan-fixtures.js";
import { FAKE_HEKA } from "./runner-helpers.js";

useTempRunsDir();

const hold = (a: Doc): void => {
  a.scope["D-1"] = { decision: "hold", at: "2026-11-14T09:00:00.000Z" };
};
const approveModel = (dir: string): any => JSON.parse(JSON.stringify(buildGateModel(dir, "approve").model));

/** 분해안과 사수 통과까지 끝난 plan_checked 실행. */
function checked(opts: Parameters<typeof setupPlanned>[0] = {}): { dir: string } {
  const { dir } = setupPlanned(opts);
  submitPlanAll(dir, planSasu(dir));
  return { dir };
}

describe("게이트 모델: 분해안 영역", () => {
  it("승인 단계 모델에 티켓 표·PR 묶음·의존·피처플래그·본문이 실린다", () => {
    const { dir } = checked();
    const plan = approveModel(dir).plan;
    expect(plan).toMatchObject({ epic_name: "배너 노출", parent: "APP-1000" });
    expect(plan.tickets.map((t: Doc) => [t.id, t.title, t.sp, t.pr, t.depends_on])).toEqual([
      ["T1", "[MO] 배너 노출 / 홈 상단 배너 영역", 3, "PR-1", []],
      ["T2", "[MO] 배너 노출 / 배너가 없을 때 빈 상태", 2, "PR-1", ["T1"]],
      ["T3", "[MO] 배너 노출 / 배너 최대 개수", 2, "PR-2", ["T1"]],
      ["T4", "[MO] 배너 노출 / 원가 없는 팩의 가격", 2, "PR-2", []],
      ["T5", "[MO] 배너 노출 / 피처플래그 제거", 2, "PR-3", ["T3", "T4"]],
    ]);
    expect(plan.tickets[0].requirements).toEqual([{ id: "요구-1", label: "홈에 배너를 노출한다" }]);
    expect(plan.tickets[0].partial_changes).toEqual([{ requirement_id: "요구-1", text: "홈 상단에 배너를 노출한다" }]);
    expect(plan.tickets[2].partial_changes).toEqual([]);
    expect(plan.tickets[0].body).toMatchObject({ background: "PRD 에서 홈 상단에 배너를 노출하기로 했다.", work: ["홈 상단에 배너를 노출한다"] });
    expect(plan.tickets[0].body.tracker_events[0].name).toBe("home_banner_view");
    expect(plan.tickets[1].body.depends_note).toBe("T1 의 배너 영역 위에 얹는다");
    expect(plan.prs.map((p: Doc) => [p.id, p.base, p.order, p.ticket_ids])).toEqual([
      ["PR-1", "develop", 1, ["T1", "T2"]],
      ["PR-2", "PR-1", 2, ["T3", "T4"]],
      ["PR-3", "PR-2", 3, ["T5"]],
    ]);
    expect(plan.feature_flag).toEqual({ used: true, name: "FF_BANNER", removal_ticket: "T5" });
    expect(plan.excluded).toEqual([]);
  });

  it("뺀 항목(excluded)이 이름표와 함께 실린다", () => {
    const { dir } = checked({
      answers: hold,
      plan: (d) => {
        d.tickets = d.tickets.filter((t: Doc) => t.id !== "T3");
        d.prs[1].ticket_ids = ["T4"];
        d.tickets[3].depends_on = ["T4"];
        d.excluded = [
          { kind: "delta", ref: "D-1", reason: "보류" },
          { kind: "change", ref: "요구-2#0", reason: "구현 안 함" },
        ];
      },
    });
    expect(approveModel(dir).plan.excluded).toEqual([
      { kind: "delta", ref: "D-1", label: "배너 개수 상한이 다르다", reason: "보류" },
      { kind: "change", ref: "요구-2#0", label: "배너는 최대 5개: 6번째부터는 그리지 않는다", reason: "구현 안 함" },
    ]);
  });

  it("검사 경고(sp_range)가 확인 필요에 오고, 사수 지적이 없으면 plan_sasu 항목도 없다", () => {
    const { dir } = checked({ plan: (d) => (d.tickets[3].sp = 6) });
    const needs = approveModel(dir).needs;
    expect(needs.filter((n: Doc) => n.code === "sp_range")).toMatchObject([{ kind: "warning", ref: "T4" }]);
    expect(needs.filter((n: Doc) => n.kind === "plan_sasu")).toEqual([]);
  });

  it("반송 상한 뒤 남은 차단 지적을 '티켓 사수 지적(미해결)' 으로 확인 필요에 싣는다", () => {
    const { dir } = setupPlanned();
    saveRun(dir, { ...loadRun(dir), rework: { analysis: 0, plan: 2 } });
    submitPlanAll(dir, planSasu(dir), { "T1:T1": blockIssue() });
    expect(loadRun(dir).state).toBe("plan_checked");
    const needs = approveModel(dir).needs.filter((n: Doc) => n.kind === "plan_sasu");
    expect(needs).toEqual([{ kind: "plan_sasu", code: "ticket_contradicts", ref: "T1", message: "티켓 사수 지적(미해결): 지적 내용 (대상 T1)" }]);
  });

  it("차단 지적이 상한 이전에 해결되면(반송 후 ok) 싣지 않는다", () => {
    const { dir } = setupPlanned();
    submitPlanAll(dir, planSasu(dir), { "T1:T1": blockIssue() });
    const doc = clone(buildPlan());
    doc.tickets[0].body.work = ["홈 상단에 배너 영역을 노출한다"];
    submitPlan(dir, doc);
    submitPlanAll(dir, planSasu(dir));
    expect(approveModel(dir).needs.filter((n: Doc) => n.kind === "plan_sasu")).toEqual([]);
  });

  it("답변 단계에서는 plan 이 null 이다", () => {
    const { dir } = checked();
    expect(buildGateModel(dir, "answer").model.plan).toBeNull();
  });
});

describe("게이트 페이지: 분해안", () => {
  it("승인 단계 페이지가 만들어지고 티켓 본문·뺀 항목·미해결 지적이 데이터에 담기며 스크립트 문법이 맞다", () => {
    const { dir } = setupPlanned();
    saveRun(dir, { ...loadRun(dir), rework: { analysis: 0, plan: 2 } });
    submitPlanAll(dir, planSasu(dir), { "T1:T1": blockIssue() });
    const r = buildGate({ runDir: dir });
    expect(r).toMatchObject({ phase: "approve", state: "gate_plan_review" });
    const html = readFileSync(r.path, "utf8");
    for (const text of ["[MO] 배너 노출 / 홈 상단 배너 영역", "티켓 사수 지적(미해결)", "home_banner_view", "FF_BANNER"]) expect(html).toContain(text);
    for (const id of ["gate-logic", "gate-ui"]) expect(() => new Function(scriptBlock(html, id))).not.toThrow();
    const template = readTemplate();
    for (const text of ["본문 보기", "뺀 항목", "피처플래그", "맡은 변경 항목", "트래커 이벤트"]) expect(template).toContain(text);
  });
});

describe("수정 요청 → answers_applied → 재제출", () => {
  it("수정 요청을 들여오면 answers_applied(반송 회차 0)로 가고, 패킷에 요청이 실리며 재제출하면 planned", () => {
    const { dir } = checked();
    buildGate({ runDir: dir });
    expect(loadRun(dir).state).toBe("gate_plan_review");
    const file = join(dir, "export.json");
    writeFileSync(file, JSON.stringify({ exported_at: "2026-11-15T09:00:00.000Z", run_id: loadRun(dir).run_id, revision: computeRevision(dir), plan_requests: [{ target: "T1", text: "작업 내용을 둘로 나눠 주세요", at: "2026-11-15T09:00:00.000Z" }] }));
    const r = importAnswers({ runDir: dir, file });
    expect(r).toMatchObject({ state: "answers_applied", approved: false, applied: { plan_requests: 1 } });
    expect(loadRun(dir)).toMatchObject({ state: "answers_applied", rework: { analysis: 0, plan: 0 } });
    expect(loadAnswers(dir).plan_requests).toHaveLength(1);

    const packet = buildPacket({ runDir: dir, role: "ticket-maker", env: { ...process.env, HEW_HEKA_BIN: FAKE_HEKA } });
    expect(packet.purpose).toBe("first");
    const text = readFileSync(packet.path, "utf8");
    expect(text).toContain("| T1 | 작업 내용을 둘로 나눠 주세요 |");
    expect(text).toContain("지금의 분해안 정본(고칠 대상)");

    const doc = clone(buildPlan());
    doc.tickets[0].body.work = ["홈 상단에 배너 영역을 노출한다", "배너 영역의 위치는 시안을 따른다"];
    const again = submitPlan(dir, doc);
    expect(again).toMatchObject({ attempt: 2, state: "planned", previous_state: "answers_applied" });
    expect(again.warnings.map((w) => w.code)).toEqual(["plan_change_unaddressed"]);
    expect(readFileSync(runPaths(dir).plan, "utf8")).toContain("배너 영역의 위치는 시안을 따른다");
  });
});
