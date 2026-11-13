/** plan 테스트용 합성 자료: buildAnalysis()·buildScenarios() 와 짝이 맞는 통과하는 분해안, 답이 모두 찬 answers.json, answers_applied 실행 준비 도우미. */
import "../src/core/analysis/index.js";
import "../src/core/scenarios/index.js";
import "../src/core/plan/index.js";
import { submitFindingsBatch, type SubmitBatchResult } from "../src/core/findings/submit.js";
import type { Finding } from "../src/core/findings/schema.js";
import { loadRun, saveRun } from "../src/core/run.js";
import { createPlan } from "../src/core/sasu/plan.js";
import type { BatchFile, SasuPlan } from "../src/core/sasu/types.js";
import { submitArtifact, type SubmitResult } from "../src/core/submit.js";
import { answersPath, clone, writeJson, type Doc } from "./analysis-fixtures.js";
import { writeItemsFile } from "./helpers.js";
import { readBatch, setupQaDesigned, type QaDesignedOptions } from "./sasu-fixtures.js";

export { clone, readBatch };

const AT = "2026-11-14T09:00:00.000Z";

/** 통과하는 완전한 분해안(items). 요구-1(변경 2개)·요구-2·요구-3 을 티켓 4개가 맡고, T5 가 플래그 제거다. */
export function buildPlan(): Doc {
  const body = (background: string, work: string[], extra: Doc = {}): Doc => ({ background, work, checks: [], refs: [], ...extra });
  return {
    epic_name: "배너 노출",
    parent: "APP-1000",
    tickets: [
      {
        id: "T1",
        title: "[MO] 배너 노출 / 홈 상단 배너 영역",
        body: body("PRD 에서 홈 상단에 배너를 노출하기로 했다.", ["홈 상단에 배너를 노출한다"], {
          tracker_events: [{ name: "home_banner_view", when: "홈에서 배너가 화면에 보일 때", properties: ["banner_id"] }],
        }),
        requirement_ids: ["요구-1"],
        changes: [{ requirement_id: "요구-1", index: 0 }],
        sp: 3,
        depends_on: [],
        pr: "PR-1",
      },
      {
        id: "T2",
        title: "[MO] 배너 노출 / 배너가 없을 때 빈 상태",
        body: body("시안에 빈 상태가 추가되었다.", ["배너가 없으면 빈 상태를 보인다"], { depends_note: "T1 의 배너 영역 위에 얹는다" }),
        requirement_ids: ["요구-1"],
        changes: [{ requirement_id: "요구-1", index: 1 }],
        sp: 2,
        depends_on: ["T1"],
        pr: "PR-1",
      },
      {
        id: "T3",
        title: "[MO] 배너 노출 / 배너 최대 개수",
        body: body("배너는 최대 5개까지만 보이기로 했다.", ["6번째 배너부터는 그리지 않는다"]),
        requirement_ids: ["요구-2"],
        sp: 2,
        depends_on: ["T1"],
        pr: "PR-2",
      },
      {
        id: "T4",
        title: "[MO] 배너 노출 / 원가 없는 팩의 가격",
        body: body("원가가 없는 팩은 판매가만 보여 준다.", ["원가가 없으면 판매가만 그린다"]),
        requirement_ids: ["요구-3"],
        sp: 2,
        depends_on: [],
        pr: "PR-2",
      },
      {
        id: "T5",
        title: "[MO] 배너 노출 / 피처플래그 제거",
        body: body("모든 PR 이 병합된 뒤 플래그를 걷어낸다.", ["피처플래그 FF_BANNER 를 걷어낸다"]),
        requirement_ids: [],
        sp: 2,
        depends_on: ["T3", "T4"],
        pr: "PR-3",
      },
    ],
    prs: [
      { id: "PR-1", title: "홈 배너 영역과 빈 상태", ticket_ids: ["T1", "T2"], base: "develop", order: 1 },
      { id: "PR-2", title: "배너 개수와 가격", ticket_ids: ["T3", "T4"], base: "PR-1", order: 2 },
      { id: "PR-3", title: "피처플래그 제거", ticket_ids: ["T5"], base: "PR-2", order: 3 },
    ],
    feature_flag: { used: true, name: "FF_BANNER", removal_ticket: "T5" },
    excluded: [],
  };
}

/** buildAnalysis·buildScenarios 의 질문·차이·가정에 모두 답한 answers.json(차이는 모두 따른다). */
export function buildAnswers(): Doc {
  return {
    answers: { "Q-1": { option: "a", at: AT }, "Q-2": { option: "a", at: AT }, "Q-3": { option: "b", at: AT } },
    scope: { "D-1": { decision: "follow_figma", at: AT }, "D-2": { decision: "follow_figma", at: AT } },
    assumptions: { "A-1": { status: "confirmed", at: AT } },
    scenarios: {},
    plan_requests: [],
    approvals: {},
  };
}

export interface AnswersAppliedOptions extends QaDesignedOptions {
  answers?: (doc: Doc) => void;
}

/** 분석·시나리오 정본과 답이 갖춰진 answers_applied 상태의 실행을 만든다. */
export function setupAnswersApplied(opts: AnswersAppliedOptions = {}): { dir: string } {
  const { dir } = setupQaDesigned(opts);
  const answers = buildAnswers();
  opts.answers?.(answers);
  writeJson(answersPath(dir), answers);
  saveRun(dir, { ...loadRun(dir), state: "answers_applied", open: 0 });
  return { dir };
}

export function submitPlan(dir: string, doc: Doc = buildPlan(), name = "plan-in.json"): SubmitResult {
  return submitArtifact({ runDir: dir, kind: "plan", file: writeItemsFile(dir, name, doc) });
}

/** 분해안까지 통과해 planned 가 된 실행을 만든다. */
export function setupPlanned(opts: AnswersAppliedOptions & { plan?: (doc: Doc) => void } = {}): { dir: string } {
  const { dir } = setupAnswersApplied(opts);
  const doc = buildPlan();
  opts.plan?.(doc);
  submitPlan(dir, doc);
  return { dir };
}

/** 현재 회차의 티켓 사수 계획을 만들어(없으면) 돌려준다. */
export function planSasu(dir: string): SasuPlan {
  return createPlan(dir, "plan").plan;
}

export type Overrides = Record<string, Partial<Finding>>;

/** 묶음 k 의 모든 단위에 ok 를 내고, overrides 에 든 단위는 그 값으로 바꾼 지적 파일을 쓰고 경로를 돌려준다. */
export function writePlanFindings(dir: string, plan: SasuPlan, k: number, overrides: Overrides = {}): string {
  const batch: BatchFile = readBatch(plan.batches.find((b) => b.k === k)?.path ?? "");
  const findings = batch.units.map((u, i) => ({ id: `F-${i + 1}`, work: u.id, verdict: "ok", ...overrides[u.id] }) as Finding);
  return writeItemsFile(dir, `plan-findings-r${plan.round}-b${k}.json`, { findings });
}

export function submitPlanBatch(dir: string, plan: SasuPlan, k: number, overrides: Overrides = {}): SubmitBatchResult {
  return submitFindingsBatch({ runDir: dir, target: "plan", batch: k, file: writePlanFindings(dir, plan, k, overrides) });
}

/** 모든 묶음을 낸다. 마지막 결과를 돌려준다. */
export function submitPlanAll(dir: string, plan: SasuPlan, overrides: Overrides = {}): SubmitBatchResult {
  let last: SubmitBatchResult | null = null;
  for (const b of plan.batches) last = submitPlanBatch(dir, plan, b.k, overrides);
  if (last === null) throw new Error("묶음이 없습니다");
  return last;
}

/** 티켓 id 의 첫 인용 가능한 문장(근거 인용으로 쓴다). */
export const T1_QUOTE = "홈 상단에 배너를 노출한다";

/** 차단 지적(근거 있음). */
export const blockIssue = (quote = T1_QUOTE, kind = "ticket_contradicts", action = "fix"): Overrides[string] =>
  ({ verdict: "issue", kind, claim: "지적 내용", evidence: { quote }, action }) as Overrides[string];
