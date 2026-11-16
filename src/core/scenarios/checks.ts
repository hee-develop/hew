/** scenarios 의 결정적 검사(§5). 검증을 통과한 본문과 정본 analysis·사람의 답을 대조한다. */
import { existsSync } from "node:fs";
import type { Issue, Severity } from "../errors.js";
import { readJsonFile } from "../fsx.js";
import { isId } from "../ids.js";
import { runPaths } from "../paths.js";
import type { CheckContext } from "../submit.js";
import { loadAnswers, type AnswersFile } from "../analysis/answers.js";
import { POST_GATE_STATES } from "../analysis/checks.js";
import { AnalysisItemsSchema, type AnalysisItems } from "../analysis/schema.js";
import { BACKENDS, ScenarioItemsSchema, type Backend, type Scenario, type ScenarioItems } from "./schema.js";

interface Env {
  items: ScenarioItems;
  ctx: CheckContext;
  analysis: AnalysisItems;
  answers: AnswersFile;
  screenIds: Set<string>;
  reqIds: Set<string>;
  /** 인수 조건 id → 그 인수 조건이 속한 요구 id. */
  acOwner: Map<string, string>;
  scenarioIds: Set<string>;
}

const issue = (code: string, severity: Severity, ref: string | null, message: string): Issue => ({ code, severity, ref, message });

const isBackend = (value: string): value is Backend => (BACKENDS as readonly string[]).includes(value);

/** 사람이 게이트에서 바꾼 값이 있으면 그 값, 없으면 제출한 값. */
function effectiveBackend(s: Scenario, answers: AnswersFile): Backend {
  const human = answers.scenarios[s.id]?.backend;
  return human !== undefined && isBackend(human) ? human : s.backend;
}

/** 정본 분석 문서의 본문. 없거나 스키마가 맞지 않으면 null. */
export function loadAnalysis(runDir: string): AnalysisItems | null {
  const file = runPaths(runDir).analysis;
  if (!existsSync(file)) return null;
  const doc = readJsonFile(file) as { items?: unknown } | null;
  const parsed = AnalysisItemsSchema.safeParse(doc?.items);
  return parsed.success ? parsed.data : null;
}

function buildEnv(items: ScenarioItems, ctx: CheckContext, analysis: AnalysisItems): Env {
  const screenIds = new Set<string>();
  for (const s of analysis.screens) {
    screenIds.add(s.id);
    for (const v of s.variants) screenIds.add(v.id);
  }
  const acOwner = new Map<string, string>();
  for (const r of analysis.requirements) for (const a of r.acceptance) acOwner.set(a.id, r.id);
  return {
    items,
    ctx,
    analysis,
    answers: loadAnswers(ctx.runDir),
    screenIds,
    reqIds: new Set(analysis.requirements.map((r) => r.id)),
    acOwner,
    scenarioIds: new Set(items.scenarios.map((s) => s.id)),
  };
}

// ---- id ----

function checkIds(env: Env): Issue[] {
  const { items } = env;
  const out: Issue[] = [];
  const seen = new Set<string>();
  const dup = (label: string, id: string): void => {
    if (seen.has(id)) out.push(issue("id_duplicate", "reject", id, `${label} id '${id}' 가 두 번 이상 쓰였습니다`));
    seen.add(id);
  };
  for (const s of items.scenarios) {
    if (!isId("scenario", s.id)) out.push(issue("id_format", "reject", s.id, `시나리오 id '${s.id}' 의 형식이 올바르지 않습니다`));
    dup("시나리오", s.id);
  }
  for (const s of items.scenarios) {
    for (const e of s.expected) {
      if (!isId("expectation", e.id)) {
        out.push(issue("id_format", "reject", s.id, `기대 결과 id '${e.id}' 의 형식이 올바르지 않습니다(시나리오-n/E-k)`));
      } else if (!e.id.startsWith(`${s.id}/`)) {
        out.push(issue("id_format", "reject", s.id, `기대 결과 id '${e.id}' 의 앞부분이 소속 시나리오 '${s.id}' 와 다릅니다`));
      }
      dup("기대 결과", e.id);
    }
  }
  for (const pf of items.preflight) {
    if (!isId("preflight", pf.id)) out.push(issue("id_format", "reject", pf.id, `실행 전 확인 id '${pf.id}' 의 형식이 올바르지 않습니다(PF-n)`));
    dup("실행 전 확인", pf.id);
  }
  for (const a of items.accounts) {
    if (!isId("account", a.id)) out.push(issue("id_format", "reject", a.id, `계정 id '${a.id}' 의 형식이 올바르지 않습니다(AC-n)`));
    dup("계정", a.id);
  }
  const analysisQuestions = new Set(env.analysis.questions.map((q) => q.id));
  for (const q of items.questions) {
    if (!isId("question", q.id)) out.push(issue("id_format", "reject", q.id, `질문 id '${q.id}' 의 형식이 올바르지 않습니다`));
    if (analysisQuestions.has(q.id)) {
      out.push(issue("id_duplicate", "reject", q.id, `질문 id '${q.id}' 가 분석 문서의 질문 id 와 겹칩니다`));
    }
    dup("질문", q.id);
  }
  return out;
}

// ---- 참조 ----

function checkRefs(env: Env): Issue[] {
  const out: Issue[] = [];
  const missing = (owner: string, what: string, id: string): void =>
    void out.push(issue("scenario_ref_missing", "reject", owner, `${owner} 이(가) 없는 ${what} '${id}' 를 가리킵니다`));
  for (const s of env.items.scenarios) {
    for (const id of s.requirement_ids) if (!env.reqIds.has(id)) missing(s.id, "요구", id);
    for (const id of s.ac_ids) {
      const owner = env.acOwner.get(id);
      if (owner === undefined) missing(s.id, "인수 조건", id);
      else if (!s.requirement_ids.includes(owner)) {
        out.push(issue("scenario_ref_missing", "reject", s.id, `${s.id} 의 인수 조건 '${id}' 가 속한 요구 '${owner}' 가 requirement_ids 에 없습니다`));
      }
    }
    for (const step of s.steps) if (step.screen_id !== undefined && !env.screenIds.has(step.screen_id)) missing(s.id, "화면", step.screen_id);
    for (const e of s.expected) if (e.screen_id !== undefined && !env.screenIds.has(e.screen_id)) missing(s.id, "화면", e.screen_id);
  }
  for (const q of env.items.questions) {
    for (const id of q.affects) {
      if (!env.reqIds.has(id) && !env.scenarioIds.has(id)) missing(q.id, "요구 또는 시나리오", id);
    }
  }
  for (const item of [...env.items.preflight, ...env.items.accounts]) {
    for (const id of item.scenario_ids) if (!env.scenarioIds.has(id)) missing(item.id, "시나리오", id);
  }
  return out;
}

// ---- 시나리오 본문 ----

function checkBodies(env: Env): Issue[] {
  const out: Issue[] = [];
  for (const s of env.items.scenarios) {
    if (s.steps.length === 0) out.push(issue("steps_empty", "reject", s.id, `${s.id} 에 단계(steps)가 없습니다`));
    if (s.expected.length === 0) out.push(issue("expected_empty", "reject", s.id, `${s.id} 에 기대 결과(expected)가 없습니다`));
    for (const e of s.expected) {
      if (e.text.trim().length === 0) out.push(issue("expected_empty", "reject", s.id, `${s.id} 의 기대 결과 ${e.id} 의 text 가 비어 있습니다`));
    }
  }
  return out;
}

/** 실행하는 날의 환경·계정 상태를 묻는 질문으로 보게 하는 낱말. */
const GATE_UNFIT_WORDS = [
  "staging", "스테이징", "dev-", "QA 시점", "QA 하는", "실행 시점", "배포돼", "배포되어", "켜져", "준비돼", "준비되어", "테스트 계정", "계정이 있", "계정이 필요",
];

/**
 * 질문 문장이 실행하는 날의 상태를 묻는 것으로 보이는가. 위 낱말이 들어 있으면 맞다.
 * `questions` 의 항목은 모두 질문이므로 물음표로 끝나는지는 보지 않는다(실제 실행의 질문 7건 중 2건이 물음표 없이 끝났다).
 */
export function isRunTimeQuestion(text: string): boolean {
  const body = text.trim();
  const lower = body.toLowerCase();
  return GATE_UNFIT_WORDS.some((word) => lower.includes(word.toLowerCase()));
}

function checkQuestions(env: Env): Issue[] {
  const out: Issue[] = [];
  for (const q of env.items.questions) {
    if (isRunTimeQuestion(q.text)) {
      out.push(issue("qa_question_not_for_gate", "warn", q.id, `${q.id} 는 실행하는 날의 환경·계정 상태를 묻는 것으로 보입니다. 실행하는 날 확인할 것은 preflight 로, 필요한 계정은 accounts 로 옮기세요`));
    }
    if (q.origin !== "qa") out.push(issue("question_origin", "reject", q.id, `${q.id} 의 origin 은 'qa' 여야 합니다(받은 값: ${q.origin})`));
    if (q.options.length === 0 && q.affects.length === 0) {
      out.push(issue("question_without_options", "reject", q.id, `${q.id} 에 선택지도, 답이 걸린 요구·시나리오(affects)도 없습니다`));
    }
    for (const o of q.options) {
      if (o.consequence.trim().length === 0) {
        out.push(issue("question_without_options", "reject", q.id, `${q.id} 의 선택지 '${o.key}' 에 이 답이 바꾸는 시나리오(consequence)가 없습니다`));
      }
    }
  }
  return out;
}

// ---- 실서버·모킹 ----

function checkBackends(env: Env): Issue[] {
  const out: Issue[] = [];
  const { apis, environment } = env.analysis.impact;
  // 실행 전 확인이 안 되면 모킹으로 돌리기로 한 시나리오는 real 이어도 mock 칸을 채워 둬야 한다.
  const mockFallback = new Set(env.items.preflight.filter((pf) => pf.fallback === "mock").flatMap((pf) => pf.scenario_ids));
  for (const s of env.items.scenarios) {
    const human = env.answers.scenarios[s.id]?.backend;
    if (human !== undefined && !isBackend(human)) {
      out.push(issue("backend_override_invalid", "warn", s.id, `${s.id} 에 들어온 사람의 backend '${human}' 는 real·mock 이 아니라 제출한 값을 씁니다`));
    }
    const backend = effectiveBackend(s, env.answers);
    const endpoints = s.mock?.endpoints ?? [];
    const reason = (s.mock?.reason ?? "").trim();
    if (backend === "mock") {
      if (reason.length === 0) out.push(issue("mock_without_reason", "reject", s.id, `${s.id} 는 mock 인데 mock.reason(이유)이 비어 있습니다`));
      if (endpoints.length === 0) out.push(issue("mock_without_reason", "reject", s.id, `${s.id} 는 mock 인데 mock.endpoints 가 비어 있습니다`));
      continue;
    }
    if ((endpoints.length > 0 || reason.length > 0) && !mockFallback.has(s.id)) {
      out.push(issue("mock_ignored", "warn", s.id, `${s.id} 는 real 이라 mock 칸을 쓰지 않습니다`));
    }
    const name = (s.environment ?? "").trim();
    if (name.length === 0) {
      out.push(issue("real_without_presence", "reject", s.id, `${s.id} 는 real 인데 environment(서버 환경)가 없습니다`));
      continue;
    }
    if (apis.length === 0) continue;
    if (environment?.name !== undefined && environment.name !== name) {
      out.push(issue("environment_differs", "warn", s.id, `${s.id} 의 환경 '${name}' 가 분석이 고른 환경 '${environment.name}' 와 다릅니다`));
    }
    if (apis.every((api) => api.presence[name] !== true)) {
      out.push(issue("real_without_presence", "reject", s.id, `${s.id} 는 real 인데 영향 분석의 API 가 모두 환경 '${name}' 에 없습니다`));
    }
  }
  return out;
}

function checkMockOnly(env: Env): Issue[] {
  const covering = new Map<string, Backend[]>();
  for (const s of env.items.scenarios) {
    const backend = effectiveBackend(s, env.answers);
    for (const id of new Set(s.requirement_ids)) covering.set(id, [...(covering.get(id) ?? []), backend]);
  }
  const out: Issue[] = [];
  for (const [id, list] of covering) {
    if (list.every((b) => b === "mock")) out.push(issue("mock_only_requirement", "warn", id, `${id} 는 모킹 시나리오로만 덮여 통합이 검증되지 않습니다`));
  }
  return out;
}

function checkReach(env: Env): Issue[] {
  return env.items.scenarios
    .filter((s) => s.reach === "unknown")
    .map((s) => issue("reach_unknown", "warn", s.id, `${s.id} 는 화면에 도달하는 방법을 모릅니다`));
}

// ---- 덮임 ----

/** 요구에 걸린 차이 중 하나라도 사람이 drop 으로 결정했으면 범위 밖이다. */
function droppedRequirements(env: Env): Set<string> {
  const out = new Set<string>();
  for (const d of env.analysis.deltas) {
    if (env.answers.scope[d.id]?.decision === "drop") for (const id of d.requirement_ids) out.add(id);
  }
  return out;
}

function checkCoverage(env: Env): Issue[] {
  const covered = new Set(env.items.scenarios.flatMap((s) => s.ac_ids));
  const dropped = droppedRequirements(env);
  const out: Issue[] = [];
  for (const r of env.analysis.requirements) {
    if (dropped.has(r.id)) continue;
    for (const a of r.acceptance) {
      if (a.verify?.method === "qa_scenario" && !covered.has(a.id)) {
        out.push(issue("ac_uncovered", "reject", a.id, `인수 조건 ${a.id} 는 검증 수단이 qa_scenario 인데 덮는 시나리오가 없습니다`));
      }
    }
  }
  return out;
}

// ---- 실행 전 확인, 계정 ----

function checkPreflight(env: Env): Issue[] {
  const out: Issue[] = [];
  const byId = new Map(env.items.scenarios.map((s) => [s.id, s]));
  for (const pf of env.items.preflight) {
    if (pf.check.trim().length === 0) {
      out.push(issue("preflight_without_check", "reject", pf.id, `${pf.id} 에 무엇을 어떻게 확인하는지(check)가 없습니다`));
    }
    if (pf.fallback !== "mock") continue;
    const unprepared = pf.scenario_ids.filter((id) => {
      const s = byId.get(id);
      return s !== undefined && effectiveBackend(s, env.answers) === "real" && (s.mock === undefined || s.mock.endpoints.length === 0);
    });
    if (unprepared.length > 0) {
      out.push(issue("preflight_mock_unprepared", "warn", pf.id, `${pf.id} 는 안 되면 모킹으로 돌린다고 했는데 ${unprepared.join(", ")} 에 모킹 정보(mock)가 없어 모킹으로 돌릴 준비가 안 됐습니다`));
    }
  }
  return out;
}

function checkAccounts(env: Env): Issue[] {
  const lacking = env.items.accounts.filter((a) => !a.available);
  if (lacking.length === 0) return [];
  return [issue("accounts_unavailable", "info", null, `지금 가진 계정으로 안 되는 계정이 ${lacking.length}개 있습니다: ${lacking.map((a) => a.id).join(", ")}`)];
}

// ---- 재제출 보호 ----

function previousQuestionIds(runDir: string): string[] {
  const file = runPaths(runDir).scenarios;
  if (!existsSync(file)) return [];
  const doc = readJsonFile(file) as { items?: { questions?: unknown } } | null;
  const list = doc?.items?.questions;
  if (!Array.isArray(list)) return [];
  return list.map((q) => (q as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === "string");
}

function checkRemoved(env: Env): Issue[] {
  if (!POST_GATE_STATES.includes(env.ctx.run.state)) return [];
  const now = new Set(env.items.questions.map((q) => q.id));
  const withdraw = new Set(env.ctx.withdraw ?? []);
  const out: Issue[] = [];
  for (const id of previousQuestionIds(env.ctx.runDir)) {
    if (now.has(id)) continue;
    if (!withdraw.has(id)) {
      out.push(issue("id_removed", "reject", id, `${id} 가 --withdraw 없이 새 제출에서 사라졌습니다. 지우려면 --withdraw ${id} 로 명시하세요`));
    } else if (env.answers.answers[id] !== undefined) {
      out.push(issue("withdraw_has_human_input", "reject", id, `${id} 에는 사람의 입력이 있어 철회할 수 없습니다`));
    } else {
      out.push(issue("item_withdrawn", "warn", id, `${id} 를 철회했습니다`));
    }
  }
  return out;
}

/** 검증을 통과한 본문에 결정적 검사를 모두 돌린다. 정본 analysis 가 없으면 거부 하나만 낸다. */
export function runScenarioChecks(items: ScenarioItems, ctx: CheckContext): Issue[] {
  const analysis = loadAnalysis(ctx.runDir);
  if (analysis === null) {
    return [issue("analysis_missing", "reject", null, "정본 분석 문서(doc/analysis.json)가 없거나 읽을 수 없어 시나리오를 검사할 수 없습니다")];
  }
  const env = buildEnv(items, ctx, analysis);
  return [
    ...checkIds(env),
    ...checkRefs(env),
    ...checkBodies(env),
    ...checkQuestions(env),
    ...checkBackends(env),
    ...checkCoverage(env),
    ...checkMockOnly(env),
    ...checkReach(env),
    ...checkPreflight(env),
    ...checkAccounts(env),
    ...checkRemoved(env),
  ];
}

/** 등록용 검사: 본문을 스키마로 다시 읽은 뒤 결정적 검사를 돌린다. 스키마가 틀리면 그 지적만 낸다. */
export function scenariosCheck(items: Record<string, unknown>, ctx: CheckContext): Issue[] {
  const parsed = ScenarioItemsSchema.safeParse(items);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => issue("schema_invalid", "reject", i.path.length > 0 ? i.path.join(".") : null, i.message));
  }
  return runScenarioChecks(parsed.data, ctx);
}
