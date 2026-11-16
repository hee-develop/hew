import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HewError } from "../src/core/errors.js";
import { readEvents } from "../src/core/events.js";
import { checkBatchFindings, classifyFindings } from "../src/core/findings/checks.js";
import { submitFindingsBatch } from "../src/core/findings/submit.js";
import { readMistakes } from "../src/core/mistakes.js";
import { buildPacket } from "../src/core/packet.js";
import { HEW_ROOT, findingsPath, runPaths, sasuPlanPath, sasuResponsesPath } from "../src/core/paths.js";
import { loadRun, saveRun } from "../src/core/run.js";
import { createPlan } from "../src/core/sasu/plan.js";
import { respondToFindings } from "../src/core/sasu/respond.js";
import { readResponses } from "../src/core/sasu/store.js";
import { BatchFileSchema, type Response } from "../src/core/sasu/types.js";
import { buildTicketUnits } from "../src/core/sasu/ticket-units.js";
import type { Doc } from "./analysis-fixtures.js";
import { useTempRunsDir, writeItemsFile } from "./helpers.js";
import {
  T1_QUOTE,
  blockIssue,
  buildPlan,
  clone,
  planSasu,
  readBatch,
  setupAnswersApplied,
  setupPlanned,
  submitPlan,
  submitPlanAll,
  submitPlanBatch,
  writePlanFindings,
  type Overrides,
} from "./plan-fixtures.js";
import { FAKE_HEKA } from "./runner-helpers.js";

useTempRunsDir();

const env = (): NodeJS.ProcessEnv => ({ ...process.env, HEW_HEKA_BIN: FAKE_HEKA });
const read = (path: string): string => readFileSync(path, "utf8");
const roundFindings = (dir: string, round: number): Record<string, any>[] => JSON.parse(read(findingsPath(runPaths(dir), "plan", round))).items.findings;
const failure = (fn: () => unknown): HewError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof HewError) return e;
    throw e;
  }
  throw new Error("오류가 나야 합니다");
};
const codes = (fn: () => unknown): string[] => failure(fn).issues.map((i) => i.code);

describe("티켓 사수 작업 단위(T1)", () => {
  it("티켓마다 단위 하나(T1:<티켓 id>)를 만들고 계획·묶음 파일을 쓴다", () => {
    const { dir } = setupPlanned();
    const r = createPlan(dir, "plan");
    expect(r).toMatchObject({ created: true, completed: null });
    expect(r.plan).toMatchObject({ for: "plan", round: 1 });
    expect(r.plan.units.map((u) => [u.id, u.code, u.target, u.batch])).toEqual(["T1", "T2", "T3", "T4", "T5"].map((t) => [`T1:${t}`, "T1", t, 1]));
    expect(r.plan.batches).toHaveLength(1);
    const p = runPaths(dir);
    expect(existsSync(sasuPlanPath(p, "plan", 1))).toBe(true);
    expect(r.plan.batches[0]?.path).toBe(join(p.work, "sasu-plan-1", "batch-1.json"));
    const batch = readBatch(r.plan.batches[0]?.path ?? "");
    expect(batch).toMatchObject({ for: "plan", round: 1, batch: 1, code: "T1" });
    expect(batch.question).toContain("ticket_missing_change");
    expect(createPlan(dir, "plan")).toMatchObject({ created: false });
    expect(readEvents(p.events).find((e) => e.type === "sasu_planned")?.data).toMatchObject({ for: "plan", units: 5, batches: 1 });
  });

  it("일부 변경만 맡은 티켓의 inputs 는 맡은 변경 항목의 문장만, 전부 맡은 티켓은 전부를 싣는다", () => {
    const { dir } = setupPlanned();
    const units = new Map(buildTicketUnits(dir).map((u) => [u.target, u]));
    const t1 = units.get("T1")?.inputs as Doc;
    expect(t1.epic_name).toBe("배너 노출");
    expect(t1.title).toBe("[MO] 배너 노출 / 홈 상단 배너 영역");
    expect(t1.body).toMatchObject({ background: "PRD 에서 홈 상단에 배너를 노출하기로 했다.", work: ["홈 상단에 배너를 노출한다"] });
    expect(t1.body.tracker_events).toHaveLength(1);
    expect(t1.requirements).toEqual([{ id: "요구-1", title: "홈에 배너를 노출한다", changes: ["홈 상단에 배너를 노출한다"] }]);
    expect((units.get("T2")?.inputs as Doc).requirements).toEqual([{ id: "요구-1", title: "홈에 배너를 노출한다", changes: ["배너가 없으면 빈 상태를 보인다"] }]);
    expect((units.get("T4")?.inputs as Doc).requirements).toEqual([{ id: "요구-3", title: "원가 없는 팩은 판매가만", changes: ["원가가 없으면 판매가만 그린다"] }]);
    expect((units.get("T5")?.inputs as Doc).requirements).toEqual([]);
    expect(units.get("T1")?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes 없이 요구를 적은 티켓은 요구의 변경 전부를 맡은 것으로 싣는다", () => {
    const { dir } = setupPlanned({
      plan: (d) => {
        d.tickets[0].changes = [];
        d.tickets = d.tickets.filter((t: Doc) => t.id !== "T2");
        d.prs[0].ticket_ids = ["T1"];
      },
    });
    const t1 = buildTicketUnits(dir).find((u) => u.target === "T1");
    expect((t1?.inputs as Doc).requirements[0].changes).toEqual(["홈 상단에 배너를 노출한다", "배너가 없으면 빈 상태를 보인다"]);
  });

  it("묶음은 10개 이하로 나눈다", () => {
    const { dir } = setupPlanned({
      plan: (d) => {
        for (let n = 6; n <= 12; n += 1) {
          d.tickets.push({ ...clone(d.tickets[3]), id: `T${n}`, pr: "PR-2" });
          d.prs[1].ticket_ids.push(`T${n}`);
          d.tickets[4].depends_on.push(`T${n}`);
        }
      },
    });
    const plan = planSasu(dir);
    expect(plan.units).toHaveLength(12);
    expect(plan.batches.map((b) => b.unit_ids.length)).toEqual([10, 2]);
  });

  it("분해안 정본이 없으면 종료 4, 사수 차례가 아니면 종료 4", () => {
    const { dir } = setupAnswersApplied();
    expect(failure(() => createPlan(dir, "plan")).exitCode).toBe(4);
    saveRun(dir, { ...loadRun(dir), state: "planned" });
    expect(failure(() => createPlan(dir, "plan")).exitCode).toBe(4);
  });
});

describe("티켓 사수 지적 제출과 검사", () => {
  it("모든 묶음이 ok 이면 회차가 완료되어 plan_checked 가 되고 합친 정본이 남는다", () => {
    const { dir } = setupPlanned();
    const plan = planSasu(dir);
    const r = submitPlanAll(dir, plan);
    expect(r.completed).toMatchObject({ round: 1, previous_state: "planned", state: "plan_checked", blocking: 0, remaining: 0, questions_added: [] });
    expect(loadRun(dir)).toMatchObject({ state: "plan_checked", rework: { plan: 0 } });
    expect(loadRun(dir).submissions.findings_plan?.attempt).toBe(1);
    const doc = JSON.parse(read(findingsPath(runPaths(dir), "plan", 1)));
    expect(doc).toMatchObject({ schema: "hew.findings/1", stage: "findings_plan", attempt: 1, verdict: { status: "pass" } });
    expect(doc.items.findings.map((f: Doc) => [f.id, f.work])).toEqual(plan.units.map((u, i) => [`F-${i + 1}`, u.id]));
    expect(readEvents(runPaths(dir).events).find((e) => e.type === "sasu_round_completed")?.data).toMatchObject({ for: "plan", to: "plan_checked", row: 12 });
  });

  it("근거 있는 지적은 차단: answers_applied 로 반송되고 반송 회차가 1 늘며 질문은 늘지 않는다", () => {
    const { dir } = setupPlanned();
    const openBefore = loadRun(dir).open;
    const r = submitPlanAll(dir, planSasu(dir), { "T1:T1": blockIssue() });
    expect(r.completed).toMatchObject({ state: "answers_applied", blocking: 1, remaining: 1, questions_added: [] });
    expect(loadRun(dir)).toMatchObject({ state: "answers_applied", rework: { analysis: 0, plan: 1 }, open: openBefore });
    const f = roundFindings(dir, 1).find((x) => x.work === "T1:T1");
    expect(f).toMatchObject({ verdict: "issue", blocking: true, kind: "ticket_contradicts" });
    expect(f?.to_gate).toBeUndefined();
    expect(JSON.parse(read(findingsPath(runPaths(dir), "plan", 1))).verdict).toMatchObject({ status: "blocked", reasons: ["ticket_contradicts"] });
  });

  it("근거로 티켓 본문이나 요구 문장 어느 쪽 인용이든 인정하고, 단위에 없는 인용은 차단하지 않는다", () => {
    for (const [quote, blocking] of [["PRD 에서 홈 상단에 배너를 노출하기로 했다", true], ["홈에 배너를 노출한다", true], ["원가가 없으면 판매가만 그린다", false]] as const) {
      const { dir } = setupPlanned();
      const r = submitPlanBatch(dir, planSasu(dir), 1, { "T1:T1": blockIssue(quote, "ticket_missing_context", "ask") });
      expect(r.blocking, quote).toBe(blocking ? 1 : 0);
      expect(r.warnings.map((w) => w.code)).toEqual(blocking ? [] : ["finding_evidence_unverified"]);
      expect(r.completed?.state).toBe(blocking ? "answers_applied" : "plan_checked");
    }
  });

  it("근거 없는 issue 는 차단하지 않는 참고로만 남는다", () => {
    const { dir } = setupPlanned();
    const r = submitPlanBatch(dir, planSasu(dir), 1, { "T1:T2": { verdict: "issue", kind: "ticket_missing_change", claim: "빠짐", action: "fix" } });
    expect(r).toMatchObject({ issues: 1, blocking: 0 });
    expect(r.completed?.state).toBe("plan_checked");
  });

  it("거부 코드: 허용되지 않는 kind·action, 빠진 단위, 묶음 중복·번호", () => {
    const { dir } = setupPlanned();
    const plan = planSasu(dir);
    const submit = (over: Overrides): unknown => submitFindingsBatch({ runDir: dir, target: "plan", batch: 1, file: writePlanFindings(dir, plan, 1, over) });
    expect(codes(() => submit({ "T1:T1": blockIssue(T1_QUOTE, "unsupported") }))).toEqual(["finding_kind_mismatch"]);
    expect(codes(() => submit({ "T1:T1": blockIssue(T1_QUOTE, "ticket_contradicts", "drop") }))).toEqual(["finding_action_mismatch"]);
    const partial = writeItemsFile(dir, "partial.json", { findings: [{ id: "F-1", work: "T1:T1", verdict: "ok" }] });
    expect(codes(() => submitFindingsBatch({ runDir: dir, target: "plan", batch: 1, file: partial }))).toEqual(["finding_missing", "finding_missing", "finding_missing", "finding_missing"]);
    expect(codes(() => submitFindingsBatch({ runDir: dir, target: "plan", batch: 7, file: partial }))).toEqual(["batch_unknown"]);
    submitPlanBatch(dir, plan, 1);
    expect(loadRun(dir).state).toBe("plan_checked");
  });

  it("상태가 맞지 않으면 종료 4(분해안용은 planned 에서만, 분석용은 받지 않는다)", () => {
    const { dir } = setupPlanned();
    const plan = planSasu(dir);
    const file = writePlanFindings(dir, plan, 1);
    expect(failure(() => submitFindingsBatch({ runDir: dir, target: "analysis", batch: 1, file })).exitCode).toBe(4);
    saveRun(dir, { ...loadRun(dir), state: "answers_applied" });
    expect(failure(() => submitFindingsBatch({ runDir: dir, target: "plan", batch: 1, file })).exitCode).toBe(4);
  });

  it("묶음이 둘일 때 마지막 묶음에서 회차가 완료된다", () => {
    const { dir } = setupPlanned({
      plan: (d) => {
        for (let n = 6; n <= 12; n += 1) {
          d.tickets.push({ ...clone(d.tickets[3]), id: `T${n}`, pr: "PR-2" });
          d.prs[1].ticket_ids.push(`T${n}`);
          d.tickets[4].depends_on.push(`T${n}`);
        }
      },
    });
    const plan = planSasu(dir);
    expect(submitPlanBatch(dir, plan, 1).completed).toBeNull();
    expect(loadRun(dir).state).toBe("planned");
    expect(submitPlanBatch(dir, plan, 2).completed).toMatchObject({ state: "plan_checked" });
  });
});

describe("반송 상한: 질문으로 바꾸지 않고 to_gate 로 게이트에 올린다", () => {
  it("상한(2회)을 채우고도 남은 차단 지적은 plan_checked 로 가고 to_gate 가 붙으며 분석 정본·질문은 그대로다", () => {
    const { dir } = setupPlanned();
    saveRun(dir, { ...loadRun(dir), rework: { analysis: 0, plan: 2 } });
    const analysisBefore = read(runPaths(dir).analysis);
    const openBefore = loadRun(dir).open;
    const r = submitPlanAll(dir, planSasu(dir), { "T1:T1": blockIssue(T1_QUOTE, "ticket_missing_context", "ask") });
    expect(r.completed).toMatchObject({ state: "plan_checked", blocking: 1, remaining: 0, questions_added: [] });
    expect(loadRun(dir)).toMatchObject({ state: "plan_checked", rework: { analysis: 0, plan: 2 }, open: openBefore });
    expect(read(runPaths(dir).analysis)).toBe(analysisBefore);
    const f = roundFindings(dir, 1).find((x) => x.work === "T1:T1");
    expect(f).toMatchObject({ blocking: true, to_gate: true });
    expect(f?.to_question).toBeUndefined();
    // 정본 분해안의 verdict 에는 사유를 넣지 않는다.
    expect(JSON.parse(read(runPaths(dir).plan)).verdict.reasons).toEqual([]);
  });
});

describe("다음 회차: previous·재사용·실수 기록", () => {
  /** 1회차에서 T1 이 차단되어 반송된 뒤 T1 을 고쳐 다시 낸 실행(2회차 계획 직전). */
  function setupSecondRound(responses?: Partial<Response>[]): { dir: string } {
    const { dir } = setupPlanned();
    submitPlanAll(dir, planSasu(dir), { "T1:T1": blockIssue() });
    if (responses !== undefined) {
      respondToFindings({ runDir: dir, target: "plan", file: writeItemsFile(dir, "r.json", { responses }) });
    }
    const doc = clone(buildPlan());
    doc.tickets[0].body.work = ["홈 상단에 배너 영역을 노출한다"];
    submitPlan(dir, doc);
    return { dir };
  }

  it("바뀌지 않은 ok 단위는 재사용하고 직전에 issue 였던 단위만 다시 돌며 inputs.previous 에 지적·답변이 실린다", () => {
    const { dir } = setupSecondRound([{ finding: "F-1", response: "fixed", reason: "문구를 고쳤다" }]);
    const plan = planSasu(dir);
    expect(plan.round).toBe(2);
    expect(plan.units.filter((u) => u.reuse === true).map((u) => u.id)).toEqual(["T1:T2", "T1:T3", "T1:T4", "T1:T5"]);
    expect(plan.batches).toHaveLength(1);
    const batch = readBatch(plan.batches[0]?.path ?? "");
    expect(batch.units.map((u) => u.id)).toEqual(["T1:T1"]);
    expect(batch.units[0]?.inputs.previous).toEqual({ claim: "지적 내용", kind: "ticket_contradicts", response: { response: "fixed", reason: "문구를 고쳤다" } });
    expect(batch.question).toContain("티켓 메이커");
    submitPlanBatch(dir, plan, 1);
    expect(loadRun(dir).state).toBe("plan_checked");
    expect(roundFindings(dir, 2).filter((f) => f.reused === true)).toHaveLength(4);
  });

  it("고쳐져 ok 가 된 지적은 실수 기록에 남고(cause_stage plan, type bad_plan), 반박이 맞았으면 오탐 이벤트로만 남는다", () => {
    const fixed = setupSecondRound([{ finding: "F-1", response: "fixed", reason: "고쳤다" }]);
    submitPlanBatch(fixed.dir, planSasu(fixed.dir), 1);
    expect(readMistakes(fixed.dir)).toMatchObject([{ found_stage: "sasu", cause_stage: "plan", found_by: "sasu", type: "bad_plan", target: "T1" }]);
    const rejected = setupSecondRound([{ finding: "F-1", response: "rejected", reason: "요구 문장 그대로다" }]);
    submitPlanBatch(rejected.dir, planSasu(rejected.dir), 1);
    expect(readMistakes(rejected.dir)).toEqual([]);
    expect(readEvents(runPaths(rejected.dir).events).some((e) => e.type === "sasu_false_positive")).toBe(true);
  });
});

describe("hew sasu respond --for plan", () => {
  function setupReturned(): { dir: string } {
    const { dir } = setupPlanned();
    submitPlanAll(dir, planSasu(dir), { "T1:T1": blockIssue(), "T1:T2": blockIssue("배너가 없으면 빈 상태를 보인다", "ticket_missing_change", "ask") });
    return { dir };
  }
  const respond = (dir: string, responses: Partial<Response>[]): ReturnType<typeof respondToFindings> =>
    respondToFindings({ runDir: dir, target: "plan", file: writeItemsFile(dir, "r.json", { responses }) });

  it("반송 중에 지적마다 답변을 저장하고(plan-<회차>.responses.json) 상태는 바꾸지 않는다", () => {
    const { dir } = setupReturned();
    const before = loadRun(dir);
    const r = respond(dir, [
      { finding: "F-1", response: "fixed", reason: "고쳤다" },
      { finding: "F-2", response: "rejected", reason: "요구 문장 그대로", evidence: { unit_id: "T2", quote: "배너가 없으면 빈 상태를 보인다" } },
    ]);
    expect(r).toMatchObject({ round: 1, saved: 2, total: 2, path: sasuResponsesPath(runPaths(dir), "plan", 1) });
    expect(readResponses(dir, 1, "plan")).toHaveLength(2);
    expect(JSON.parse(read(r.path))).toMatchObject({ for: "plan", round: 1 });
    expect(loadRun(dir)).toEqual(before);
    // 같은 지적에 다시 내면 덮어쓴다.
    respond(dir, [{ finding: "F-1", response: "asked", reason: "사람 확인 필요" }]);
    expect(readResponses(dir, 1, "plan").find((x) => x.finding === "F-1")?.response).toBe("asked");
    expect(readEvents(runPaths(dir).events).filter((e) => e.type === "sasu_responded").at(-1)?.data).toMatchObject({ for: "plan" });
  });

  it("evidence.quote 는 그 지적 단위의 inputs 텍스트에 있어야 한다(원문 단위가 아니다)", () => {
    const { dir } = setupReturned();
    // F-1(T1:T1)의 inputs 에는 T2 의 문장이 없다.
    expect(codes(() => respond(dir, [{ finding: "F-1", response: "rejected", reason: "r", evidence: { unit_id: "T1", quote: "배너가 없으면 빈 상태를 보인다" } }]))).toEqual(["quote_not_found"]);
    expect(respond(dir, [{ finding: "F-1", response: "rejected", reason: "r", evidence: { unit_id: "T1", quote: "홈에 배너를 노출한다" } }]).saved).toBe(1);
  });

  it("거부 코드: 차단 지적이 아닌 id, 같은 지적 중복, rejected 에 이유 없음", () => {
    const { dir } = setupReturned();
    expect(codes(() => respond(dir, [{ finding: "F-4", response: "fixed" }]))).toEqual(["response_unknown_finding"]);
    expect(codes(() => respond(dir, [{ finding: "F-1", response: "fixed" }, { finding: "F-1", response: "asked" }]))).toEqual(["response_duplicate"]);
    expect(codes(() => respond(dir, [{ finding: "F-1", response: "rejected" }]))).toEqual(["response_without_reason"]);
    expect(existsSync(sasuResponsesPath(runPaths(dir), "plan", 1))).toBe(false);
  });

  it("분해안 반송 중이 아니면 종료 4(분석 반송 중에도 --for plan 은 받지 않는다)", () => {
    const { dir } = setupPlanned();
    expect(failure(() => respond(dir, [])).exitCode).toBe(4);
    saveRun(dir, { ...loadRun(dir), state: "answers_applied", rework: { analysis: 0, plan: 0 } });
    expect(failure(() => respond(dir, [])).exitCode).toBe(4);
  });
});

describe("패킷: ticket-maker 와 ticket-sasu", () => {
  it("ticket-maker 처음: 정본·답·분해 규칙·형식 안내를 읽을 것에 싣고 대상 저장소와 분해 규칙 폴더를 읽기 뿌리로 준다", () => {
    const { dir } = setupAnswersApplied();
    const p = runPaths(dir);
    const text = read(buildPacket({ runDir: dir, role: "ticket-maker", env: env() }).path);
    for (const path of [p.analysis, p.scenarios, p.answers]) expect(text).toContain(`\`${path}\``);
    for (const ref of ["refs/plan-format.md", "refs/plan.example.json", "rules/plan.yaml"]) expect(text).toContain(join(HEW_ROOT, ref));
    expect(text).toContain(`${join(HEW_ROOT, "rules", "plan.yaml")}\` — 분해 규칙`);
    expect(text).not.toContain("사람의 수정 요청");
    expect(text).toContain("jira-ticket-title-format");
    expect(text).toContain("app-feature-story-role-prefixed-subtasks");
    expect(text).toContain("submit plan --run");
  });

  it("수정 요청이 있으면 표로 싣고 지금의 분해안을 고칠 대상으로 올린다", () => {
    const { dir } = setupAnswersApplied({
      answers: (a) => a.plan_requests.push({ target: "T1", text: "제목을 짧게 | 해 주세요", at: "2026-11-15T09:00:00.000Z" }, { target: "전체", text: "SP 를 낮춰 주세요", at: "2026-11-15T09:01:00.000Z" }),
    });
    submitPlan(dir);
    saveRun(dir, { ...loadRun(dir), state: "answers_applied", rework: { analysis: 0, plan: 0 } });
    const text = read(buildPacket({ runDir: dir, role: "ticket-maker", env: env() }).path);
    expect(text).toContain("## 사람의 수정 요청");
    expect(text).toContain("| T1 | 제목을 짧게 \\| 해 주세요 | 2026-11-15T09:00:00.000Z |");
    expect(text).toContain("| 전체 | SP 를 낮춰 주세요 |");
    expect(text).toContain(`\`${runPaths(dir).plan}\` — 지금의 분해안 정본(고칠 대상)`);
  });

  it("반송 패킷: 지적 표(같은 지적은 한 줄)와 --for plan 답변 안내, 지금의 분해안", () => {
    const { dir } = setupPlanned();
    submitPlanAll(dir, planSasu(dir), { "T1:T1": blockIssue(), "T1:T2": blockIssue("배너가 없으면 빈 상태를 보인다") });
    const r = buildPacket({ runDir: dir, role: "ticket-maker", env: env() });
    expect(r.purpose).toBe("rework");
    const text = read(r.path);
    expect(text).toContain("| F-1, F-2 | T1:T1, T1:T2 | ticket_contradicts | 지적 내용 |");
    expect(text).toContain(`sasu respond --for plan --run ${dir} --file ${join(runPaths(dir).work, "ticket-maker-1", "responses.json")}`);
    expect(text).toContain("지금의 분해안 정본(고칠 대상)");
  });

  it("ticket-sasu 패킷: 묶음 파일·형식 안내·제출 명령만 싣고 저장소는 주지 않는다", () => {
    const { dir } = setupPlanned();
    const raw = JSON.parse(read(runPaths(dir).runJson));
    raw.repo = { path: "/some/repo", base: "abc" };
    saveRun(dir, raw);
    const plan = planSasu(dir);
    const r = buildPacket({ runDir: dir, role: "ticket-sasu", env: env() });
    expect(r).toMatchObject({ role: "ticket-sasu", purpose: "first" });
    const text = read(r.path);
    expect(text).toContain(`\`${plan.batches[0]?.path}\``);
    expect(text).toContain("분해안, 회차 1, 묶음 1 (종류 T1, 단위 5개)");
    expect(text).toContain("ticket_missing_context");
    expect(text).toContain(`submit findings --for plan --batch 1 --run ${dir} --file ${join(runPaths(dir).work, "ticket-sasu-1", "findings.json")}`);
    for (const ref of ["findings-format.md", "findings.plan.example.json", "sasu-batch.plan.example.json"]) expect(text).toContain(join(HEW_ROOT, "refs", ref));
    expect(text).not.toContain("/some/repo");
  });

  it("ticket-sasu 형식 안내 예시는 스키마와 검사를 통과한다", () => {
    const { dir } = setupPlanned();
    const batch = JSON.parse(read(join(HEW_ROOT, "refs", "sasu-batch.plan.example.json"))) as Doc;
    const findings = JSON.parse(read(join(HEW_ROOT, "refs", "findings.plan.example.json"))) as Doc;
    expect(batch.units.map((u: Doc) => u.id)).toEqual(findings.findings.map((f: Doc) => f.work));
    expect(BatchFileSchema.safeParse(batch).success).toBe(true);
    expect(checkBatchFindings(findings.findings, batch as never)).toEqual([]);
    const { stored, warnings } = classifyFindings(findings.findings, batch as never, dir);
    expect(warnings).toEqual([]);
    expect(stored.map((f) => f.blocking)).toEqual([false, true]);
  });
});
