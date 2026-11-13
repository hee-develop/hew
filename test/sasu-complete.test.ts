import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { QuestionSchema } from "../src/core/analysis/schema.js";
import { readEvents } from "../src/core/events.js";
import { readMistakes } from "../src/core/mistakes.js";
import { nextAction } from "../src/core/next.js";
import { buildPacket } from "../src/core/packet.js";
import { runPaths } from "../src/core/paths.js";
import { computeRevision } from "../src/core/revision.js";
import { loadRun, saveRun, type Run } from "../src/core/run.js";
import { createPlan } from "../src/core/sasu/plan.js";
import { collectRunOpen } from "../src/core/open.js";
import { getKindSpec, submitArtifact } from "../src/core/submit.js";
import { buildAnalysis, clone } from "./analysis-fixtures.js";
import { useTempRunsDir, writeItemsFile } from "./helpers.js";
import { buildScenarios } from "./scenarios-fixtures.js";
import { FAKE_HEKA } from "./runner-helpers.js";
import { batchOf, findingsRound, planNow, respond, setupQaDesigned, startNextRound, submitAll, type Overrides } from "./sasu-fixtures.js";

useTempRunsDir();

const analysisDoc = (dir: string): { items: Record<string, any>; open: string[] } => JSON.parse(readFileSync(runPaths(dir).analysis, "utf8"));
const patchRun = (dir: string, patch: Partial<Run>): Run => saveRun(dir, { ...loadRun(dir), ...patch });

const fixIssue = (quote: string, kind = "unsupported", action = "fix"): Overrides[string] =>
  ({ verdict: "issue", kind, claim: "지적 내용", evidence: { unit_id: "U-4", quote }, action }) as Overrides[string];

describe("회차 완료: 차단 0 -> checked", () => {
  it("모든 묶음이 ok 이면 checked 로 가고 합친 정본과 제출 기록이 남는다", () => {
    const { dir } = setupQaDesigned();
    const plan = planNow(dir);
    const r = submitAll(dir, plan);
    expect(r.completed).toMatchObject({ round: 1, previous_state: "qa_designed", state: "checked", blocking: 0, remaining: 0, questions_added: [] });
    const run = loadRun(dir);
    expect(run).toMatchObject({ state: "checked", rework: { analysis: 0, plan: 0 } });
    expect(run.submissions.findings_analysis?.attempt).toBe(1);
    const doc = JSON.parse(readFileSync(join(runPaths(dir).findingsDir, "analysis-1.json"), "utf8"));
    expect(doc).toMatchObject({ schema: "hew.findings/1", stage: "findings_analysis", attempt: 1, verdict: { status: "pass" } });
    expect(doc.items.findings).toHaveLength(plan.units.length);
    expect(doc.items.findings.map((f: any) => f.work)).toEqual(plan.units.map((u) => u.id));
    expect(doc.items.findings.map((f: any) => f.id)).toEqual(plan.units.map((_, i) => `F-${i + 1}`));
    expect(readEvents(runPaths(dir).events).some((e) => e.type === "sasu_round_completed")).toBe(true);
    expect(readMistakes(dir)).toEqual([]);
  });

  it("차단하지 않는 issue 만 있어도 checked 로 간다", () => {
    const { dir } = setupQaDesigned();
    const plan = planNow(dir);
    const r = submitAll(dir, plan, { "W2:요구-1": { verdict: "issue", kind: "unsupported", claim: "참고", action: "fix" } });
    expect(r.completed).toMatchObject({ state: "checked", blocking: 0 });
    expect(readMistakes(dir)).toEqual([]);
  });
});

describe("회차 완료: fix 차단 -> collected", () => {
  it("collected 로 가고 반송 회차가 +1 이며 열린 항목·분석 정본은 그대로", () => {
    const { dir } = setupQaDesigned();
    const before = analysisDoc(dir);
    const plan = planNow(dir);
    const r = submitAll(dir, plan, { "W2:요구-1": fixIssue("홈 상단에 배너를 노출한다") });
    expect(r.completed).toMatchObject({ state: "collected", blocking: 1, remaining: 1, questions_added: [] });
    expect(loadRun(dir)).toMatchObject({ state: "collected", rework: { analysis: 1, plan: 0 } });
    expect(analysisDoc(dir)).toEqual(before);
    expect(nextAction("collected", { rework: loadRun(dir).rework, progress: loadRun(dir).progress })).toEqual({ action: "spawn", role: "technical-manager", purpose: "rework" });
  });

  it("반송 패킷에 차단 지적이 종류·주장·근거·처리와 함께 실린다", () => {
    const { dir } = setupQaDesigned();
    submitAll(dir, planNow(dir), {
      "W2:요구-1": fixIssue("홈 상단에 배너를 노출한다"),
      "W2:요구-2": { verdict: "issue", kind: "unsupported", claim: "근거 없는 참고 지적", action: "fix" },
    });
    const packet = buildPacket({ runDir: dir, role: "technical-manager", env: { ...process.env, HEW_HEKA_BIN: FAKE_HEKA } });
    const text = readFileSync(packet.path, "utf8");
    expect(packet.purpose).toBe("rework");
    expect(text).toContain(join(runPaths(dir).findingsDir, "analysis-1.json"));
    expect(text).toContain("| F-1 | W2:요구-1 | unsupported | 지적 내용 | U-4: 홈 상단에 배너를 노출한다 | fix |");
    expect(text).not.toContain("근거 없는 참고 지적");
  });

  it("drop 차단도 남은 지적이라 반송된다", () => {
    const { dir } = setupQaDesigned();
    const r = submitAll(dir, planNow(dir), { "W5:요구-1": fixIssue("배너는 최대 5개", "ai_only_behavior", "drop") });
    expect(r.completed).toMatchObject({ state: "collected", remaining: 1 });
  });
});

const askOf = (quote: string, claim = "c", kind = "missing"): Overrides[string] =>
  ({ verdict: "issue", kind, claim, evidence: { unit_id: "U-1", quote }, action: "ask" }) as Overrides[string];

describe("회차 완료: ask 차단은 먼저 반송한다", () => {
  it("ask 차단도 collected 로 반송하고 질문은 바로 만들지 않는다", () => {
    const { dir } = setupQaDesigned();
    const openBefore = loadRun(dir).open;
    const before = analysisDoc(dir);
    const r = submitAll(dir, planNow(dir), { "W4:요구-3": { verdict: "issue", kind: "false_confirmed", claim: "원문에 조건부 표시가 있다", evidence: { unit_id: "U-3", quote: "판매가만 노출한다" }, action: "ask" } });
    expect(r.completed).toMatchObject({ state: "collected", blocking: 1, remaining: 1, questions_added: [] });
    expect(loadRun(dir)).toMatchObject({ state: "collected", rework: { analysis: 1, plan: 0 }, open: openBefore });
    expect(analysisDoc(dir)).toEqual(before);
    expect(readEvents(runPaths(dir).events).some((e) => e.type === "sasu_questions_added")).toBe(false);
    expect(readMistakes(dir)).toEqual([]);
  });

  it("반송 패킷의 지적 표에 ask 도 실린다", () => {
    const { dir } = setupQaDesigned();
    submitAll(dir, planNow(dir), { "W3:U-1": askOf("배너를 노출한다", "물어야 함") });
    const packet = buildPacket({ runDir: dir, role: "technical-manager", env: { ...process.env, HEW_HEKA_BIN: FAKE_HEKA } });
    expect(readFileSync(packet.path, "utf8")).toContain("| F-");
    expect(readFileSync(packet.path, "utf8")).toContain("| 물어야 함 | U-1: 배너를 노출한다 | ask |");
  });

  it("ask 와 fix 가 섞여도 둘 다 반송 대상이다", () => {
    const { dir } = setupQaDesigned();
    const r = submitAll(dir, planNow(dir), {
      "W3:U-1": askOf("배너를 노출한다", "물어야 함"),
      "W2:요구-1": fixIssue("홈 상단에 배너를 노출한다"),
    });
    expect(r.completed).toMatchObject({ state: "collected", blocking: 2, remaining: 2, questions_added: [] });
    expect(loadRun(dir).rework.analysis).toBe(1);
  });

  it("차단하지 않는 ask 는 반송도 질문도 일으키지 않는다", () => {
    const { dir } = setupQaDesigned();
    const r = submitAll(dir, planNow(dir), { "W3:U-1": { verdict: "issue", kind: "missing", claim: "c", action: "ask" } });
    expect(r.completed).toMatchObject({ state: "checked", blocking: 0, questions_added: [] });
  });
});

describe("회차 완료: 반송 상한을 채운 뒤 남은 지적은 질문", () => {
  it("origin sasu 질문을 더하고 run.open 이 늘며 걸린 confirmed 요구는 pending 이 된다", () => {
    const { dir } = setupQaDesigned();
    patchRun(dir, { rework: { analysis: 2, plan: 0 } });
    const revisionBefore = loadRun(dir).revision;
    const openBefore = loadRun(dir).open;
    const plan = planNow(dir);
    const r = submitAll(dir, plan, { "W4:요구-3": { verdict: "issue", kind: "false_confirmed", claim: "원문에 조건부 표시가 있다", evidence: { unit_id: "U-3", quote: "판매가만 노출한다" }, action: "ask" } });
    expect(r.completed).toMatchObject({ state: "checked", blocking: 1, remaining: 0, questions_added: ["Q-4"] });
    const doc = analysisDoc(dir);
    const q = doc.items.questions.find((x: any) => x.id === "Q-4");
    expect(QuestionSchema.safeParse(q).success).toBe(true);
    expect(q).toMatchObject({ origin: "sasu", blocking: true, affects: ["요구-3"] });
    expect(q.text).toBe("사수 확인(W4:요구-3, false_confirmed): 원문에 조건부 표시가 있다 어떻게 처리할까요?");
    expect(q.options.map((o: any) => o.key)).toEqual(["fix", "keep"]);
    expect(q.options.every((o: any) => o.consequence.length > 0)).toBe(true);
    expect(q.rationale).toEqual([{ unit_id: "U-3", quote: "판매가만 노출한다" }]);
    expect(doc.items.requirements.find((x: any) => x.id === "요구-3").status).toBe("pending");
    expect(doc.open).toContain("Q-4");
    const run = loadRun(dir);
    expect(run.open).toBe(openBefore + 1);
    expect(run.open).toBe(collectRunOpen(dir).length);
    expect(run.revision).not.toBe(revisionBefore);
    expect(run.revision).toBe(computeRevision(dir));
    expect(run.state).toBe("checked");
    const event = readEvents(runPaths(dir).events).find((e) => e.type === "sasu_questions_added");
    expect(event?.data).toMatchObject({ round: 1, questions: ["Q-4"], pended: ["요구-3"] });
    expect(getKindSpec("analysis").collectOpen(doc.items, dir)).toContain("Q-4");
    expect(findingsRound(dir, 1).find((f) => f.work === "W4:요구-3")).toMatchObject({ blocking: true, to_question: true });
  });

  it("질문을 더한 정본이 결정적 검사를 통과한다(confirmed_with_open 등)", () => {
    const { dir } = setupQaDesigned();
    patchRun(dir, { rework: { analysis: 2, plan: 0 } });
    submitAll(dir, planNow(dir), { "W4:요구-3": { verdict: "issue", kind: "false_confirmed", claim: "c", evidence: { quote: "판매가만 노출한다" }, action: "ask" } });
    const items = analysisDoc(dir).items;
    const run = loadRun(dir);
    const issues = getKindSpec("analysis").checks.flatMap((c) => c(items, { kind: "analysis", for: null, run, runDir: dir }));
    expect(issues.filter((i) => i.severity === "reject")).toEqual([]);
  });

  it("단위가 대상이면 그 단위를 근거로 든 요구들이 affects 에 걸린다", () => {
    const { dir } = setupQaDesigned();
    patchRun(dir, { rework: { analysis: 2, plan: 0 } });
    submitAll(dir, planNow(dir), { "W3:U-1": askOf("배너를 노출한다", "빠졌다") });
    const q = analysisDoc(dir).items.questions.find((x: any) => x.origin === "sasu");
    expect(q.affects).toEqual(["요구-1"]);
  });

  it("질문 id 는 analysis·scenarios 질문 전체에서 다음 번호이고 서로 다른 지적은 순서대로", () => {
    const { dir } = setupQaDesigned();
    patchRun(dir, { rework: { analysis: 2, plan: 0 } });
    const r = submitAll(dir, planNow(dir), {
      "W3:U-1": askOf("배너를 노출한다", "첫째"),
      "W3:U-3": askOf("판매가만 노출한다", "둘째"),
    });
    expect(r.completed?.questions_added).toEqual(["Q-4", "Q-5"]);
  });

  it("같은 kind·같은 claim(공백만 다름)인 지적은 질문 하나로 합치고 affects 는 합집합, 본문에 대상 목록을 적는다", () => {
    const { dir } = setupQaDesigned();
    patchRun(dir, { rework: { analysis: 2, plan: 0 } });
    const r = submitAll(dir, planNow(dir), {
      "W3:U-1": askOf("배너를 노출한다", "같은 지적 문장"),
      "W3:U-2": askOf("어드민에서 입력한다", "같은 지적  문장"),
      "W3:U-3": askOf("판매가만 노출한다", "같은지적문장"),
      "W3:U-4": askOf("배너는 최대 5개까지 노출한다", "같은 지적 문장", "wrong_disposition"),
    });
    expect(r.completed).toMatchObject({ blocking: 4, questions_added: ["Q-4", "Q-5"] });
    const qs = analysisDoc(dir).items.questions.filter((q: any) => q.origin === "sasu");
    expect(qs[0].text).toBe("사수 확인(W3:U-1, missing): 같은 지적 문장 어떻게 처리할까요? (같은 지적 3건: U-1, U-2, U-3)");
    expect(qs[0].affects).toEqual(expect.arrayContaining(["요구-1", "요구-3"]));
    expect(new Set<string>(qs[0].affects).size).toBe(qs[0].affects.length);
    expect(qs[1].text).toBe("사수 확인(W3:U-4, wrong_disposition): 같은 지적 문장 어떻게 처리할까요?");
  });

  it("같은 대상·같은 kind 의 sasu 질문이 이미 있으면 다시 만들지 않는다(합친 질문의 대상 목록도 포함)", () => {
    const { dir } = setupQaDesigned();
    patchRun(dir, { rework: { analysis: 2, plan: 0 } });
    const ask = { "W3:U-1": askOf("배너를 노출한다", "빠졌다"), "W3:U-2": askOf("어드민에서 입력한다", "빠졌다") } as Overrides;
    submitAll(dir, planNow(dir), ask);
    expect(analysisDoc(dir).items.questions.filter((q: any) => q.origin === "sasu")).toHaveLength(1);
    // 같은 분석·시나리오로 answers_complete 에서 사수를 다시 돌린다(직전 issue 는 다시 돈다).
    patchRun(dir, { state: "answers_complete", progress: { analysis: true, scenarios: true, sasu: false } });
    const plan2 = planNow(dir);
    expect(plan2.round).toBe(2);
    const r2 = submitAll(dir, plan2, ask);
    expect(r2.completed?.questions_added).toEqual([]);
    expect(analysisDoc(dir).items.questions.filter((q: any) => q.origin === "sasu")).toHaveLength(1);
  });
});

describe("회차 완료: 반송 상한", () => {
  it("상한(2회)을 채웠으면 남은 fix·drop 도 질문이 되고 checked 로 간다", () => {
    const { dir } = setupQaDesigned();
    patchRun(dir, { rework: { analysis: 2, plan: 0 } });
    const plan = planNow(dir);
    const r = submitAll(dir, plan, {
      "W2:요구-1": fixIssue("홈 상단에 배너를 노출한다"),
      "W5:요구-1": fixIssue("배너는 최대 5개", "ai_only_behavior", "drop"),
    });
    expect(r.completed).toMatchObject({ state: "checked", blocking: 2, remaining: 0, questions_added: ["Q-4", "Q-5"] });
    const run = loadRun(dir);
    expect(run.rework.analysis).toBe(2);
    expect(run.open).toBe(collectRunOpen(dir).length);
    const qs = analysisDoc(dir).items.questions.filter((q: any) => q.origin === "sasu");
    expect(qs.map((q: any) => q.affects)).toEqual([["요구-1"], ["요구-1"]]);
  });

  it("상한 미만이면 fix 는 질문이 되지 않는다", () => {
    const { dir } = setupQaDesigned();
    patchRun(dir, { rework: { analysis: 1, plan: 0 } });
    const r = submitAll(dir, planNow(dir), { "W2:요구-1": fixIssue("홈 상단에 배너를 노출한다") });
    expect(r.completed).toMatchObject({ state: "collected", questions_added: [] });
    expect(loadRun(dir).rework.analysis).toBe(2);
  });
});

describe("실수 기록: 다음 회차 완료 때 직전 지적을 판정한다", () => {
  /** 1회차에서 W2:요구-1 이 fix 차단으로 반송된 실행. */
  function setupReturned(): { dir: string } {
    const { dir } = setupQaDesigned();
    const analysis = JSON.parse(readFileSync(runPaths(dir).analysis, "utf8"));
    analysis.produced_by = { role: "technical-manager", model: "claude-opus-5-5", effort: "high", role_sha: "abc123", session_id: "s" };
    writeItemsFile(dir, "doc/analysis.json", analysis);
    submitAll(dir, planNow(dir), { "W2:요구-1": fixIssue("홈 상단에 배너를 노출한다") });
    return { dir };
  }
  const falsePositives = (dir: string) => readEvents(runPaths(dir).events).filter((e) => e.type === "sasu_false_positive");

  it("회차를 완료하는 시점에는 차단 지적이 있어도 기록하지 않는다", () => {
    const { dir } = setupReturned();
    expect(readMistakes(dir)).toEqual([]);
  });

  it("답변 fixed + 이번 판정 ok -> 실수로 기록(§12 형식, 직전 지적 내용)", () => {
    const { dir } = setupReturned();
    respond(dir, [{ finding: "F-1", response: "fixed", reason: "고쳤다" }]);
    const plan2 = startNextRound(dir);
    const r = submitAll(dir, plan2);
    expect(r.completed).toMatchObject({ state: "checked", blocking: 0 });
    const mistakes = readMistakes(dir);
    expect(mistakes).toHaveLength(1);
    expect(mistakes[0]).toMatchObject({
      id: "M-1",
      run_id: loadRun(dir).run_id,
      found_stage: "sasu",
      cause_stage: "analysis",
      found_by: "sasu",
      type: "wrong_evidence",
      target: "요구-1",
      versions: { role: "technical-manager", role_sha: "abc123", model: "claude-opus-5-5", effort: "high" },
    });
    expect(mistakes[0]?.evidence).toContain("지적 내용");
    expect(mistakes[0]?.evidence).toContain("홈 상단에 배너를 노출한다");
    expect(mistakes[0]?.versions?.core).toBe("0.1.0-stage1");
    expect(falsePositives(dir)).toEqual([]);
  });

  it("답변 없음 + 이번 판정 ok -> 실수로 기록", () => {
    const { dir } = setupReturned();
    submitAll(dir, startNextRound(dir));
    expect(readMistakes(dir).map((m) => m.target)).toEqual(["요구-1"]);
  });

  it("답변 asked + 이번 판정 ok -> 실수로 기록", () => {
    const { dir } = setupReturned();
    respond(dir, [{ finding: "F-1", response: "asked", reason: "질문으로 올렸다" }]);
    submitAll(dir, startNextRound(dir));
    expect(readMistakes(dir)).toHaveLength(1);
  });

  it("답변 rejected + 이번 판정 ok -> 기록하지 않고 sasu_false_positive 이벤트를 남긴다", () => {
    const { dir } = setupReturned();
    respond(dir, [{ finding: "F-1", response: "rejected", reason: "원문이 뒷받침한다", evidence: { unit_id: "U-4", quote: "배너는 최대 5개까지 노출한다" } }]);
    submitAll(dir, startNextRound(dir));
    expect(readMistakes(dir)).toEqual([]);
    const events = falsePositives(dir);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({ round: 2, finding: "F-1", work: "W2:요구-1", kind: "unsupported", claim: "지적 내용", reason: "원문이 뒷받침한다" });
  });

  it("이번에도 같은 지적이면(issue) 아직 판정하지 않는다", () => {
    const { dir } = setupReturned();
    respond(dir, [{ finding: "F-1", response: "rejected", reason: "틀린 지적이다" }]);
    const r = submitAll(dir, startNextRound(dir), { "W2:요구-1": fixIssue("홈 상단에 배너를 노출한다") });
    expect(r.completed).toMatchObject({ state: "collected", blocking: 1 });
    expect(readMistakes(dir)).toEqual([]);
    expect(falsePositives(dir)).toEqual([]);
  });

  it("상한에 닿아 질문이 된 지적은 기록하지 않고, 그 뒤 회차에서 ok 가 되어도 기록하지 않는다", () => {
    const { dir } = setupQaDesigned();
    patchRun(dir, { rework: { analysis: 2, plan: 0 } });
    const r = submitAll(dir, planNow(dir), { "W2:요구-1": fixIssue("홈 상단에 배너를 노출한다") });
    expect(r.completed).toMatchObject({ state: "checked", questions_added: ["Q-4"] });
    expect(readMistakes(dir)).toEqual([]);
    patchRun(dir, { state: "answers_complete", progress: { analysis: true, scenarios: true, sasu: false } });
    submitAll(dir, planNow(dir));
    expect(readMistakes(dir)).toEqual([]);
    expect(falsePositives(dir)).toEqual([]);
  });
});

describe("answers_complete: 사수 재확인", () => {
  function setupAnswersComplete(): { dir: string } {
    const { dir } = setupQaDesigned();
    patchRun(dir, { state: "answers_complete", progress: { analysis: true, scenarios: true, sasu: false } });
    return { dir };
  }

  it("차단(fix) 이 있고 반송이 상한 미만이면 answers_complete 에 머물고 반송 +1, 분석·사수 진행만 false", () => {
    const { dir } = setupAnswersComplete();
    const r = submitAll(dir, planNow(dir), { "W2:요구-1": fixIssue("홈 상단에 배너를 노출한다") });
    expect(r.completed).toMatchObject({ previous_state: "answers_complete", state: "answers_complete", remaining: 1 });
    expect(loadRun(dir)).toMatchObject({ state: "answers_complete", rework: { analysis: 1, plan: 0 }, progress: { analysis: false, scenarios: true, sasu: false } });
    const run = loadRun(dir);
    expect(nextAction(run.state, { rework: run.rework, progress: run.progress })).toEqual({ action: "spawn", role: "technical-manager", purpose: "rework" });
    const events = readEvents(runPaths(dir).events).filter((e) => e.type === "sasu_round_completed");
    expect(events[0]?.data).toMatchObject({ row: 18 });
  });

  it("반송 뒤 분석을 다시 내면 시나리오 진행이 유지되어 곧바로 사수 차례", () => {
    const { dir } = setupAnswersComplete();
    submitAll(dir, planNow(dir), { "W2:요구-1": fixIssue("홈 상단에 배너를 노출한다") });
    const doc = clone(buildAnalysis());
    doc.requirements[0].title = "수정한 제목";
    // 답 반영 이후의 재제출이라 철회 규칙이 걸리지 않게 같은 id 를 유지한다.
    const sub = submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "a2.json", doc) });
    expect(sub.state).toBe("answers_complete");
    const run = loadRun(dir);
    expect(run.progress).toEqual({ analysis: true, scenarios: true, sasu: false });
    expect(nextAction(run.state, { rework: run.rework, progress: run.progress })).toEqual({ action: "sasu", for: "analysis" });
    // 2회차는 바뀐 요구만 다시 돈다.
    const plan2 = createPlan(dir, "analysis").plan;
    expect(plan2.round).toBe(2);
    expect(plan2.units.some((u) => u.reuse === true)).toBe(true);
    expect(plan2.units.find((u) => u.id === "W2:요구-1")?.reuse).toBeUndefined();
  });

  it("차단 없이 통과하고 열린 항목이 있으면 checked", () => {
    const { dir } = setupAnswersComplete();
    const r = submitAll(dir, planNow(dir));
    expect(r.completed).toMatchObject({ state: "checked" });
    expect(loadRun(dir).progress).toEqual({ analysis: false, scenarios: false, sasu: false });
  });

  it("상한을 채웠으면 남은 지적이 질문이 되고 열린 항목이 있으므로 checked", () => {
    const { dir } = setupAnswersComplete();
    patchRun(dir, { rework: { analysis: 2, plan: 0 } });
    const r = submitAll(dir, planNow(dir), { "W2:요구-1": fixIssue("홈 상단에 배너를 노출한다") });
    expect(r.completed).toMatchObject({ state: "checked", blocking: 1, remaining: 0, questions_added: ["Q-4"] });
    expect(loadRun(dir).open).toBe(collectRunOpen(dir).length);
  });
});

describe("회차 완료: 시나리오 정본과 batchOf 도우미", () => {
  it("W9 질문 대상이 scenarios 의 질문이어도 상한 뒤에는 질문이 된다", () => {
    const { dir } = setupQaDesigned();
    patchRun(dir, { rework: { analysis: 2, plan: 0 } });
    const plan = planNow(dir);
    expect(batchOf(plan, "W9:Q-3")).toBeGreaterThan(0);
    const r = submitAll(dir, plan, { "W9:Q-3": { verdict: "issue", kind: "already_answered", claim: "원문에 답이 있다", evidence: { quote: "받지 못한 상태의 테스트 계정을 만들 수 있나요" }, action: "ask" } });
    expect(r.completed?.questions_added).toEqual(["Q-4"]);
    const q = analysisDoc(dir).items.questions.find((x: any) => x.id === "Q-4");
    expect(q.affects).toEqual(["요구-1"]);
    expect(findingsRound(dir, 1).find((f) => f.work === "W9:Q-3")).toMatchObject({ blocking: true });
    expect(buildScenarios().questions[0].id).toBe("Q-3");
  });
});
