/** 게이트 모델(§8.1): 정본·답·원천에서 게이트 페이지가 그릴 JSON 하나를 만든다. 이미지는 페이지 옆으로 복사할 목록을 함께 돌려준다. */
import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { loadAnswers, type AnswersFile } from "../analysis/answers.js";
import { runAnalysisChecks } from "../analysis/checks.js";
import { DELTA_CHOICES, type DecisionChoice } from "../analysis/delta-decision.js";
import { hasValidDecision, isQuestionAnswered, isQuestionSuperseded, questionHash } from "../analysis/open-items.js";
import {
  AnalysisItemsSchema,
  type AnalysisItems,
  type Delta,
  type Evidence,
  type Question,
  type Requirement,
  type Screen,
} from "../analysis/schema.js";
import { HewError, stateError, type Issue } from "../errors.js";
import { readJsonFile } from "../fsx.js";
import { sha256Bytes } from "../hash.js";
import { loadManifest } from "../manifest.js";
import { collectRunOpen } from "../open.js";
import { runPaths } from "../paths.js";
import { computeRevision } from "../revision.js";
import { loadRun, type Run } from "../run.js";
import { runScenarioChecks } from "../scenarios/checks.js";
import { BACKENDS, ScenarioItemsSchema, type ScenarioItems } from "../scenarios/schema.js";
import type { CheckContext } from "../submit.js";
import type { Unit } from "../units/types.js";

export type GatePhase = "answer" | "approve";

export interface GateImage {
  role: "as_is" | "to_be" | "both";
  label: string;
  /** 페이지 옆 `assets/<파일>` 상대 경로. 원본 파일이 없으면 null. */
  src: string | null;
}

export interface GateChange {
  text: string;
  /** 변경이 걸린 다른 화면의 이름(요구 카드가 놓인 화면과 다를 때만). */
  screen_name: string | null;
}

export interface GateVariantChange {
  requirement_id: string;
  requirement_title: string;
  text: string;
}

export interface GateRef {
  id: string;
  label: string;
}

export interface GateDelta {
  id: string;
  title: string;
  kind: Delta["kind"];
  kind_label: string;
  rows: { aspect: string; prd: string; figma: string }[];
  prd_quotes: string[];
  figma_quotes: string[];
  recommendation: { decision: string; label: string; reason: string } | null;
  audience: string[];
  requirement_ids: string[];
  /** 차이 카드가 놓인 대표 요구. 묶이지 않았으면 null. */
  home_requirement_id: string | null;
}

export interface GateRequirement {
  id: string;
  title: string;
  status: Requirement["status"];
  changes: GateChange[];
  acceptance: { id: string; given: string; when: string; then: string }[];
  /** 걸린 질문·차이·가정으로 가는 링크. */
  links: { questions: GateRef[]; deltas: GateRef[]; assumptions: GateRef[] };
  /** 이 요구 카드 아래에 그리는 차이(대표 요구일 때만). */
  deltas: GateDelta[];
  depends_on: string[];
  /** AI용 칸. 화면에는 "AI용 보기" 접힘으로만 보인다. */
  ai: {
    code: { path: string; symbol: string; role: string }[];
    verify: { ac_id: string; detail: string }[];
    rules: string[];
    notes: { text: string; evidence: { unit_id: string; quote: string }[] }[];
    evidence: { unit_id: string; quote: string }[];
  };
}

export interface GateScreen {
  id: string;
  name: string;
  change: Screen["change"];
  figma_url: string | null;
  images: GateImage[];
  variants: { id: string; name: string; images: GateImage[]; changes: GateVariantChange[] }[];
  requirements: GateRequirement[];
}

export interface GateQuestion {
  id: string;
  text: string;
  source: "analysis" | "scenarios";
  origin: Question["origin"];
  origin_label: string | null;
  blocking: boolean;
  options: { key: string; label: string; consequence: string }[];
  recommended: string | null;
  rationale: string[];
  affects: GateRef[];
  audience: string[];
  hash: string;
}

export interface GateScenario {
  id: string;
  title: string;
  journey: string;
  requirements: GateRef[];
  preconditions: { account_state: string; feature_flags: string[]; data: string };
  steps: { n: number; action: string; screen_name: string | null }[];
  expected: { id: string; text: string }[];
  backend: "real" | "mock";
  mock: { reason: string; endpoints: { method: string; path: string; case: string }[] } | null;
  environment: string | null;
  platforms: string[];
}

export interface GatePlan {
  tickets: { id: string; title: string; requirement_ids: string[]; sp: number | null; depends_on: string[]; pr: string | null }[];
  prs: { id: string; title: string; ticket_ids: string[]; base: string; order: number | null }[];
  /** 티켓·PR 배열을 읽지 못했을 때 접어서 보여 줄 원본. */
  raw: unknown;
}

export interface GateModel {
  head: {
    title: string;
    source_version: string | null;
    run_id: string;
    mode: string;
    revision: string;
    phase: GatePhase;
    approved: boolean;
    questions: { answered: number; total: number };
    deltas: { decided: number; total: number };
    assumptions: { confirmed: number; total: number };
    environment: { name: string; basis: string } | null;
    /** 코어가 센 열린 항목 id(질문, 차이, 가정, 시나리오 질문 순). */
    open_ids: string[];
    built_at: string;
  };
  needs: { kind: "warning" | "reanswer"; code: string; ref: string | null; message: string }[];
  screens: GateScreen[];
  unbound_requirements: GateRequirement[];
  unbound_deltas: GateDelta[];
  questions: GateQuestion[];
  assumptions: { id: string; text: string; basis: string; requirements: GateRef[] }[];
  out_of_scope: {
    key: string;
    disposition: "out_of_scope" | "not_app";
    disposition_label: string;
    reason: string;
    items: { row_id: string; quote: string; unit_ids: string[]; excerpts: string[] }[];
  }[];
  impact: {
    areas: { id: string; screens: string[]; paths: string[]; components: string[]; feature_flag: string | null }[];
    apis: { method: string; path: string; fields: string[]; presence: Record<string, boolean> }[];
    environments: string[];
    assets: { name: string; exists: boolean; path: string | null }[];
    blockers: { id: string; kind: string; detail: string; question: GateRef | null }[];
  };
  scenarios: GateScenario[];
  plan: GatePlan | null;
  answers: AnswersFile;
  rules: { delta_choices: Record<string, readonly DecisionChoice[]>; backends: readonly string[] };
}

export interface AssetJob {
  /** 복사할 원본 절대 경로. */
  from: string;
  /** gate/assets 안의 파일 이름. */
  name: string;
}

export interface BuiltModel {
  model: GateModel;
  assets: AssetJob[];
  warnings: Issue[];
}

const KIND_LABELS: Record<Delta["kind"], string> = {
  figma_only: "시안에만 있음",
  prd_only: "PRD에만 있음",
  mismatch: "PRD와 시안이 다름",
};

const ORIGIN_LABELS: Partial<Record<Question["origin"], string>> = {
  sasu: "사수 지적",
  qa: "QA 설계",
  impact: "영향 분석",
};

const DISPOSITION_LABELS = { out_of_scope: "범위 밖", not_app: "앱 몫이 아님" } as const;

const EXCERPT_LIMIT = 200;

const IMAGE_LABELS: Record<GateImage["role"], string> = { as_is: "AS-IS", to_be: "TO-BE", both: "AS-IS · TO-BE" };

/** 승인 단계(분해안 확인)의 상태인가. 그 밖의 상태는 답변 단계다. */
export function phaseOfState(state: Run["state"]): GatePhase {
  return state === "plan_checked" || state === "gate_plan_review" || state === "approved" ? "approve" : "answer";
}

function readItems(file: string, label: string): unknown {
  if (!existsSync(file)) throw stateError(`정본(${label})이 없어 게이트 페이지를 만들 수 없습니다`);
  return (readJsonFile(file) as { items?: unknown }).items;
}

function loadAnalysisItems(runDir: string): AnalysisItems {
  const parsed = AnalysisItemsSchema.safeParse(readItems(runPaths(runDir).analysis, "doc/analysis.json"));
  if (!parsed.success) throw new HewError("internal", `analysis.json 형식이 올바르지 않습니다: ${parsed.error.issues[0]?.message ?? ""}`);
  return parsed.data;
}

function loadScenarioItems(runDir: string): ScenarioItems | null {
  const file = runPaths(runDir).scenarios;
  if (!existsSync(file)) return null;
  const parsed = ScenarioItemsSchema.safeParse(readItems(file, "doc/scenarios.json"));
  if (!parsed.success) throw new HewError("internal", `scenarios.json 형식이 올바르지 않습니다: ${parsed.error.issues[0]?.message ?? ""}`);
  return parsed.data;
}

function loadUnits(runDir: string): Map<string, Unit> {
  const file = runPaths(runDir).units;
  if (!existsSync(file)) return new Map();
  const units = (readJsonFile(file) as { units?: Unit[] }).units ?? [];
  return new Map(units.map((u) => [u.id, u]));
}

/** 이미지 경로를 gate/assets 상대 경로로 바꾸고 복사할 목록에 올린다. 같은 내용은 하나로 합친다. */
class AssetCollector {
  readonly jobs = new Map<string, string>();
  readonly warnings: Issue[] = [];

  constructor(private readonly runDir: string) {}

  resolve(path: string): string | null {
    const abs = isAbsolute(path) ? path : resolve(this.runDir, path);
    if (!existsSync(abs)) {
      this.warnings.push({ code: "image_missing", severity: "warn", ref: path, message: `이미지 파일이 없어 페이지에 싣지 못했습니다: ${path}` });
      return null;
    }
    const name = `${sha256Bytes(readFileSync(abs)).slice(0, 16)}${extname(abs).toLowerCase()}`;
    if (!this.jobs.has(name)) this.jobs.set(name, abs);
    return `assets/${name}`;
  }
}

function toImages(refs: { role: GateImage["role"]; path: string }[], assets: AssetCollector): GateImage[] {
  return refs.map((r) => ({ role: r.role, label: IMAGE_LABELS[r.role], src: assets.resolve(r.path) }));
}

const quoteOf = (ev: Evidence): string => ("quote" in ev ? ev.quote : "");

const quotes = (list: Evidence[]): string[] => list.map(quoteOf).filter((q) => q.length > 0);

function toDelta(delta: Delta): GateDelta {
  const rec = delta.recommendation;
  const label = rec === undefined ? "" : (DELTA_CHOICES[delta.kind].find((c) => c.value === rec.decision)?.label ?? rec.decision);
  return {
    id: delta.id,
    title: delta.title,
    kind: delta.kind,
    kind_label: KIND_LABELS[delta.kind],
    rows: (delta.comparison?.rows ?? []).map((r) => ({ aspect: r.aspect, prd: r.prd ?? "", figma: r.figma ?? "" })),
    prd_quotes: quotes(delta.prd_evidence),
    figma_quotes: quotes(delta.figma_evidence),
    recommendation: rec === undefined ? null : { decision: rec.decision, label, reason: rec.reason ?? "" },
    audience: delta.audience,
    requirement_ids: delta.requirement_ids,
    home_requirement_id: null,
  };
}

interface Index {
  items: AnalysisItems;
  scenarios: ScenarioItems | null;
  screenOf: Map<string, string>;
  screenName: Map<string, string>;
  variantParent: Map<string, string>;
  reqById: Map<string, Requirement>;
}

function buildIndex(items: AnalysisItems, scenarios: ScenarioItems | null): Index {
  const screenOf = new Map<string, string>();
  const screenName = new Map<string, string>();
  const variantParent = new Map<string, string>();
  for (const s of items.screens) {
    screenOf.set(s.id, s.id);
    screenName.set(s.id, s.name);
    for (const v of s.variants) {
      screenOf.set(v.id, s.id);
      screenName.set(v.id, `${s.name} / ${v.name}`);
      variantParent.set(v.id, s.id);
    }
  }
  return { items, scenarios, screenOf, screenName, variantParent, reqById: new Map(items.requirements.map((r) => [r.id, r])) };
}

/** 요구가 놓일 화면 id. 대표 자리(첫 screen_ids)를 따르고, 변형이면 그 변형의 화면이다. 없으면 null. */
const homeScreenOf = (req: Requirement, index: Index): string | null => index.screenOf.get(req.screen_ids[0] ?? "") ?? null;

function refLabel(id: string, index: Index): string {
  const req = index.reqById.get(id);
  if (req !== undefined) return req.title;
  return index.scenarios?.scenarios.find((s) => s.id === id)?.title ?? id;
}

function buildRequirement(req: Requirement, index: Index, homeDeltas: GateDelta[]): GateRequirement {
  const { items } = index;
  const home = homeScreenOf(req, index);
  const here = req.changes.filter((c) => {
    const target = c.screen_id === undefined ? undefined : index.variantParent.get(c.screen_id);
    return target === undefined;
  });
  const evidence: { unit_id: string; quote: string }[] = [];
  for (const change of req.changes) for (const ev of change.evidence) evidence.push({ unit_id: ev.unit_id, quote: "quote" in ev ? ev.quote : ev.image });
  const questionRefs: GateRef[] = [...items.questions, ...(index.scenarios?.questions ?? [])]
    .filter((q) => q.affects.includes(req.id))
    .map((q) => ({ id: q.id, label: q.text }));
  const deltaRefs: GateRef[] = items.deltas.filter((d) => d.requirement_ids.includes(req.id)).map((d) => ({ id: d.id, label: d.title }));
  const assumptionRefs: GateRef[] = items.assumptions.filter((a) => a.requirement_ids.includes(req.id)).map((a) => ({ id: a.id, label: a.text }));
  return {
    id: req.id,
    title: req.title,
    status: req.status,
    changes: here.map((c) => ({
      text: c.text,
      screen_name: c.screen_id !== undefined && index.screenOf.get(c.screen_id) !== home ? (index.screenName.get(c.screen_id) ?? null) : null,
    })),
    acceptance: req.acceptance.map((a) => ({ id: a.id, given: a.given ?? "", when: a.when, then: a.then })),
    links: { questions: questionRefs, deltas: deltaRefs, assumptions: assumptionRefs },
    deltas: homeDeltas,
    depends_on: req.depends_on,
    ai: {
      code: req.ai.code.map((c) => ({ path: c.path, symbol: c.symbol ?? "", role: c.role })),
      verify: req.ai.verify,
      rules: req.ai.rules,
      notes: req.ai.notes.map((n) => ({ text: n.text, evidence: n.evidence.map((e) => ({ unit_id: e.unit_id, quote: quoteOf(e) })) })),
      evidence,
    },
  };
}

function buildCoverage(items: AnalysisItems, units: Map<string, Unit>): GateModel["out_of_scope"] {
  const groups = new Map<string, GateModel["out_of_scope"][number]>();
  for (const row of items.coverage) {
    if (row.disposition !== "out_of_scope" && row.disposition !== "not_app") continue;
    const reason = row.reason ?? "";
    const key = `${row.disposition}|${reason}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, disposition: row.disposition, disposition_label: DISPOSITION_LABELS[row.disposition], reason, items: [] };
      groups.set(key, group);
    }
    group.items.push({
      row_id: row.id,
      quote: row.quote ?? "",
      unit_ids: row.unit_ids,
      excerpts: row.unit_ids.map((id) => (units.get(id)?.text ?? "").slice(0, EXCERPT_LIMIT)).filter((t) => t.length > 0),
    });
  }
  return [...groups.values()];
}

function buildQuestions(index: Index): GateQuestion[] {
  const out: GateQuestion[] = [];
  const add = (q: Question, source: GateQuestion["source"]): void => {
    out.push({
      id: q.id,
      text: q.text,
      source,
      origin: q.origin,
      origin_label: ORIGIN_LABELS[q.origin] ?? null,
      blocking: q.blocking,
      options: q.options.map((o) => ({ key: o.key, label: o.label, consequence: o.consequence })),
      recommended: q.recommended ?? null,
      rationale: quotes(q.rationale),
      affects: q.affects.map((id) => ({ id, label: refLabel(id, index) })),
      audience: q.audience,
      hash: questionHash(q),
    });
  };
  for (const q of index.items.questions) add(q, "analysis");
  for (const q of index.scenarios?.questions ?? []) add(q, "scenarios");
  return out;
}

function buildScenarios(index: Index): GateScenario[] {
  return (index.scenarios?.scenarios ?? []).map((s) => ({
    id: s.id,
    title: s.title,
    journey: s.journey,
    requirements: s.requirement_ids.map((id) => ({ id, label: refLabel(id, index) })),
    preconditions: {
      account_state: s.preconditions.account_state ?? "",
      feature_flags: s.preconditions.feature_flags,
      data: s.preconditions.data ?? "",
    },
    steps: s.steps.map((st) => ({ n: st.n, action: st.action, screen_name: st.screen_id === undefined ? null : (index.screenName.get(st.screen_id) ?? null) })),
    expected: s.expected.map((e) => ({ id: e.id, text: e.text })),
    backend: s.backend,
    mock: s.mock === undefined ? null : { reason: s.mock.reason, endpoints: s.mock.endpoints },
    environment: s.environment ?? null,
    platforms: s.platforms,
  }));
}

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const asString = (v: unknown): string => (typeof v === "string" ? v : "");
const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const asRecords = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x)) : []);

/** plan 정본을 느슨하게 읽는다. 스키마가 정해지기 전이라 tickets·prs 배열의 알려진 칸만 꺼낸다. */
function buildPlan(runDir: string): GatePlan | null {
  const file = runPaths(runDir).plan;
  if (!existsSync(file)) return null;
  const items = (readJsonFile(file) as { items?: unknown }).items;
  const rec = items !== null && typeof items === "object" ? (items as Record<string, unknown>) : {};
  return {
    tickets: asRecords(rec.tickets).map((t) => ({
      id: asString(t.id),
      title: asString(t.title),
      requirement_ids: asStrings(t.requirement_ids),
      sp: asNumber(t.sp),
      depends_on: asStrings(t.depends_on),
      pr: typeof t.pr === "string" ? t.pr : null,
    })),
    prs: asRecords(rec.prs).map((p) => ({
      id: asString(p.id),
      title: asString(p.title),
      ticket_ids: asStrings(p.ticket_ids),
      base: asString(p.base),
      order: asNumber(p.order),
    })),
    raw: items ?? null,
  };
}

function sourceHead(runDir: string, run: Run): { title: string; version: string | null } {
  const entry = loadManifest(runDir).sources.find((s) => s.kind === "prd" || s.kind === "ticket");
  return { title: entry?.title ?? run.input.url, version: entry?.version ?? null };
}

function warningsOf(items: AnalysisItems, scenarios: ScenarioItems | null, run: Run, runDir: string): Issue[] {
  const base = { for: null, run, runDir };
  const ctxA: CheckContext = { kind: "analysis", ...base };
  const issues = runAnalysisChecks(items, ctxA);
  if (scenarios !== null) issues.push(...runScenarioChecks(scenarios, { kind: "scenarios", ...base }));
  return issues.filter((i) => i.severity === "warn");
}

/** 정본·답·원천에서 게이트 모델을 만든다. */
export function buildGateModel(runDir: string, phase: GatePhase, now: Date = new Date()): BuiltModel {
  const run = loadRun(runDir);
  const items = loadAnalysisItems(runDir);
  const scenarios = loadScenarioItems(runDir);
  const answers = loadAnswers(runDir);
  const index = buildIndex(items, scenarios);
  const units = loadUnits(runDir);
  const assets = new AssetCollector(runDir);

  const deltaModels = items.deltas.map(toDelta);
  const homeDeltasOf = (reqId: string): GateDelta[] =>
    deltaModels.filter((d) => d.requirement_ids[0] === reqId && index.reqById.has(reqId));
  for (const d of deltaModels) {
    const home = d.requirement_ids[0];
    d.home_requirement_id = home !== undefined && index.reqById.has(home) ? home : null;
  }

  const screens: GateScreen[] = items.screens.map((s) => ({
    id: s.id,
    name: s.name,
    change: s.change,
    figma_url: s.figma?.url ?? null,
    images: toImages(s.images, assets),
    variants: s.variants.map((v) => ({
      id: v.id,
      name: v.name,
      images: toImages(v.images, assets),
      changes: items.requirements.flatMap((r) =>
        r.changes
          .filter((c) => c.screen_id === v.id)
          .map((c) => ({ requirement_id: r.id, requirement_title: r.title, text: c.text })),
      ),
    })),
    requirements: [],
  }));
  const screenModel = new Map(screens.map((s) => [s.id, s]));
  const unbound: GateRequirement[] = [];
  for (const req of items.requirements) {
    const card = buildRequirement(req, index, homeDeltasOf(req.id));
    const home = homeScreenOf(req, index);
    const target = home === null ? undefined : screenModel.get(home);
    if (target === undefined) unbound.push(card);
    else target.requirements.push(card);
  }

  const questions = buildQuestions(index);
  const allQuestions = [...items.questions, ...(scenarios?.questions ?? [])];
  const needs: GateModel["needs"] = warningsOf(items, scenarios, run, runDir).map((i) => ({
    kind: "warning" as const,
    code: i.code,
    ref: i.ref,
    message: i.message,
  }));
  for (const q of allQuestions) {
    if (isQuestionSuperseded(q, answers)) {
      needs.push({ kind: "reanswer", code: "question_superseded", ref: q.id, message: `${q.id} 는 답한 뒤에 질문이 바뀌어 다시 답해야 합니다` });
    }
  }

  const apiEnvs = [...new Set(items.impact.apis.flatMap((a) => Object.keys(a.presence)))];
  const env = items.impact.environment;
  const prd = sourceHead(runDir, run);
  const questionTotal = allQuestions.length;
  const model: GateModel = {
    head: {
      title: prd.title,
      source_version: prd.version,
      run_id: run.run_id,
      mode: run.mode,
      revision: computeRevision(runDir),
      phase,
      approved: run.state === "approved",
      questions: { answered: allQuestions.filter((q) => isQuestionAnswered(q, answers)).length, total: questionTotal },
      deltas: { decided: items.deltas.filter((d) => hasValidDecision(d, answers)).length, total: items.deltas.length },
      assumptions: { confirmed: items.assumptions.filter((a) => answers.assumptions[a.id] !== undefined).length, total: items.assumptions.length },
      environment: env?.name === undefined ? null : { name: env.name, basis: env.basis ?? "" },
      open_ids: collectRunOpen(runDir),
      built_at: now.toISOString(),
    },
    needs,
    screens,
    unbound_requirements: unbound,
    unbound_deltas: deltaModels.filter((d) => d.home_requirement_id === null),
    questions,
    assumptions: items.assumptions.map((a) => ({
      id: a.id,
      text: a.text,
      basis: a.basis,
      requirements: a.requirement_ids.map((id) => ({ id, label: refLabel(id, index) })),
    })),
    out_of_scope: buildCoverage(items, units),
    impact: {
      areas: items.impact.areas.map((a) => ({
        id: a.id,
        screens: a.screen_ids.map((id) => index.screenName.get(id) ?? id),
        paths: a.paths,
        components: a.components,
        feature_flag: a.feature_flag ?? null,
      })),
      apis: items.impact.apis.map((a) => ({ method: a.method, path: a.path, fields: a.fields, presence: a.presence })),
      environments: apiEnvs,
      assets: items.impact.assets.map((a) => ({ name: a.name, exists: a.exists, path: a.path ?? null })),
      blockers: items.impact.blockers.map((b) => ({
        id: b.id,
        kind: b.kind,
        detail: b.detail,
        question: b.question_id === undefined ? null : { id: b.question_id, label: allQuestions.find((q) => q.id === b.question_id)?.text ?? b.question_id },
      })),
    },
    scenarios: buildScenarios(index),
    plan: phase === "approve" ? buildPlan(runDir) : null,
    answers,
    rules: { delta_choices: DELTA_CHOICES, backends: BACKENDS },
  };
  return { model, assets: [...assets.jobs].map(([name, from]) => ({ name, from })), warnings: assets.warnings };
}
