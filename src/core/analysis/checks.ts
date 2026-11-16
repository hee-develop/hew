/** analysis 의 결정적 검사(§4.6). 검증을 통과한 본문과 실행 폴더의 원문 단위·답·정본을 대조한다. */
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { Issue, Severity } from "../errors.js";
import { readJsonFile } from "../fsx.js";
import { isId, type IdKind } from "../ids.js";
import { loadManifest } from "../manifest.js";
import { runPaths } from "../paths.js";
import type { RunState } from "../state-machine.js";
import type { CheckContext } from "../submit.js";
import type { Unit } from "../units/types.js";
import { loadAnswers, type AnswersFile } from "./answers.js";
import { DELTA_DECISION_VALUES, isDecisionAllowed } from "./delta-decision.js";
import { computeOpenItems, openIdList, type OpenItems } from "./open-items.js";
import { AnalysisItemsSchema, type AnalysisItems, type Evidence } from "./schema.js";

/** 게이트에 한 번이라도 게시된 뒤의 상태(§1.5 철회 규칙이 적용된다). */
export const POST_GATE_STATES: readonly RunState[] = [
  "gate_answering",
  "answers_complete",
  "answers_applied",
  "planned",
  "plan_checked",
  "gate_plan_review",
  "approved",
];

/** 이 비율을 넘으면 확인 요청서를 만든다. */
export const MISMATCH_RATIO_LIMIT = 0.1;

const MOBILE_COLUMN_WORDS = ["mobile", "app", "앱", "모바일"];
const WEB_PLATFORMS = new Set(["web", "mobile_web"]);
const FIGMA_KINDS = new Set(["figma_screen", "figma_desc"]);

interface Env {
  items: AnalysisItems;
  ctx: CheckContext;
  units: Map<string, Unit>;
  unitList: Unit[];
  answers: AnswersFile;
  open: OpenItems;
  hasFigmaMeta: boolean;
  screenIds: Set<string>;
  reqIds: Set<string>;
  questionIds: Set<string>;
  deltaIds: Set<string>;
  assumptionIds: Set<string>;
  acIds: Set<string>;
}

interface EvidenceUse {
  ev: Evidence;
  owner: string;
  where: string;
}

const issue = (code: string, severity: Severity, ref: string | null, message: string): Issue => ({ code, severity, ref, message });

/** 공백·줄바꿈과 Markdown 강조 표시(`**`, `__`, 백틱)를 지운다. */
export function normalizeText(text: string): string {
  return text.replace(/\*\*|__|`/g, "").replace(/\s+/g, "");
}

function readUnits(runDir: string): Unit[] {
  const file = runPaths(runDir).units;
  if (!existsSync(file)) return [];
  const raw = readJsonFile(file);
  const parsed = z.object({ units: z.array(z.custom<Unit>((v) => v !== null && typeof v === "object")) }).safeParse(raw);
  return parsed.success ? parsed.data.units : [];
}

function buildEnv(items: AnalysisItems, ctx: CheckContext): Env {
  const unitList = readUnits(ctx.runDir);
  const answers = loadAnswers(ctx.runDir);
  const screenIds = new Set<string>();
  for (const s of items.screens) {
    screenIds.add(s.id);
    for (const v of s.variants) screenIds.add(v.id);
  }
  const hasFigmaMeta = loadManifest(ctx.runDir).sources.some((s) => s.kind === "figma_meta");
  return {
    items,
    ctx,
    units: new Map(unitList.map((u) => [u.id, u])),
    unitList,
    answers,
    open: computeOpenItems(items, answers),
    hasFigmaMeta,
    screenIds,
    reqIds: new Set(items.requirements.map((r) => r.id)),
    questionIds: new Set(items.questions.map((q) => q.id)),
    deltaIds: new Set(items.deltas.map((d) => d.id)),
    assumptionIds: new Set(items.assumptions.map((a) => a.id)),
    acIds: new Set(items.requirements.flatMap((r) => r.acceptance.map((a) => a.id))),
  };
}

function collectEvidence(items: AnalysisItems): EvidenceUse[] {
  const uses: EvidenceUse[] = [];
  for (const r of items.requirements) {
    r.changes.forEach((c, i) => c.evidence.forEach((ev) => uses.push({ ev, owner: r.id, where: `변경 항목 ${i + 1}` })));
    r.ai.notes.forEach((n, i) => n.evidence.forEach((ev) => uses.push({ ev, owner: r.id, where: `ai.notes ${i + 1}` })));
  }
  for (const d of items.deltas) {
    d.prd_evidence.forEach((ev) => uses.push({ ev, owner: d.id, where: "prd_evidence" }));
    d.figma_evidence.forEach((ev) => uses.push({ ev, owner: d.id, where: "figma_evidence" }));
  }
  for (const q of items.questions) q.rationale.forEach((ev) => uses.push({ ev, owner: q.id, where: "rationale" }));
  return uses;
}

/** 단위의 열 중 이름에 Mobile(App) 표지가 있고 값이 비어 있지 않은 것이 있는가. */
function hasMobileColumn(unit: Unit): boolean {
  return Object.entries(unit.columns ?? {}).some(
    ([name, value]) => value.trim().length > 0 && MOBILE_COLUMN_WORDS.some((w) => name.toLowerCase().includes(w)),
  );
}

// ---- id ----

function idList(label: string, kind: IdKind, ids: { id: string; owner: string }[]): Issue[] {
  const out: Issue[] = [];
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const { id, owner } of ids) {
    if (!isId(kind, id)) out.push(issue("id_format", "reject", owner, `${label} id '${id}' 의 형식이 올바르지 않습니다`));
    if (seen.has(id) && !reported.has(id)) {
      reported.add(id);
      out.push(issue("id_duplicate", "reject", id, `${label} id '${id}' 가 두 번 이상 쓰였습니다`));
    }
    seen.add(id);
  }
  return out;
}

function checkIds({ items }: Env): Issue[] {
  const out: Issue[] = [];
  out.push(...idList("화면", "screen", items.screens.map((s) => ({ id: s.id, owner: s.id }))));
  const variants = items.screens.flatMap((s) => s.variants.map((v) => ({ id: v.id, owner: v.id, parent: s.id })));
  out.push(...idList("변형", "variant", variants));
  for (const v of variants) {
    if (isId("variant", v.id) && !v.id.startsWith(`${v.parent}.`)) {
      out.push(issue("id_format", "reject", v.id, `변형 id '${v.id}' 의 앞부분이 소속 화면 '${v.parent}' 와 다릅니다`));
    }
  }
  out.push(...idList("요구", "requirement", items.requirements.map((r) => ({ id: r.id, owner: r.id }))));
  const acs = items.requirements.flatMap((r) => r.acceptance.map((a) => ({ id: a.id, owner: a.id, parent: r.id })));
  out.push(...idList("인수 조건", "ac", acs));
  for (const a of acs) {
    if (isId("ac", a.id) && !a.id.startsWith(`${a.parent}/`)) {
      out.push(issue("id_format", "reject", a.id, `인수 조건 id '${a.id}' 의 앞부분이 요구 '${a.parent}' 의 id 와 다릅니다`));
    }
  }
  out.push(...idList("차이", "delta", items.deltas.map((d) => ({ id: d.id, owner: d.id }))));
  out.push(...idList("질문", "question", items.questions.map((q) => ({ id: q.id, owner: q.id }))));
  out.push(...idList("가정", "assumption", items.assumptions.map((a) => ({ id: a.id, owner: a.id }))));
  out.push(...idList("범위 장부 행", "coverage", items.coverage.map((c) => ({ id: c.id, owner: c.id }))));
  out.push(...idList("영향 영역", "impact", items.impact.areas.map((a) => ({ id: a.id, owner: a.id }))));
  out.push(...idList("막힘", "blocker", items.impact.blockers.map((b) => ({ id: b.id, owner: b.id }))));
  return out;
}

// ---- 참조 ----

function checkRefs(env: Env): Issue[] {
  const { items } = env;
  const out: Issue[] = [];
  const need = (set: Set<string>, id: string, owner: string, what: string): void => {
    if (!set.has(id)) out.push(issue("ref_missing", "reject", owner, `${owner} 이(가) 없는 ${what} '${id}' 를 가리킵니다`));
  };
  const isScenarioRef = (id: string): boolean => isId("scenario", id);

  for (const r of items.requirements) {
    for (const id of r.screen_ids) need(env.screenIds, id, r.id, "화면");
    for (const c of r.changes) if (c.screen_id !== undefined) need(env.screenIds, c.screen_id, r.id, "화면");
    for (const id of r.depends_on) need(env.reqIds, id, r.id, "요구");
    for (const v of r.ai.verify) need(env.acIds, v.ac_id, r.id, "인수 조건");
  }
  for (const d of items.deltas) for (const id of d.requirement_ids) need(env.reqIds, id, d.id, "요구");
  for (const q of items.questions) {
    for (const id of q.affects) if (!isScenarioRef(id)) need(env.reqIds, id, q.id, "요구");
  }
  for (const a of items.assumptions) for (const id of a.requirement_ids) need(env.reqIds, id, a.id, "요구");
  const unitSet = new Set(env.units.keys());
  for (const c of items.coverage) {
    for (const id of c.unit_ids) need(unitSet, id, c.id, "원문 단위");
    for (const id of c.requirement_ids) need(env.reqIds, id, c.id, "요구");
    for (const id of c.screen_ids) need(env.screenIds, id, c.id, "화면");
    if (c.delta_id !== undefined) need(env.deltaIds, c.delta_id, c.id, "차이");
  }
  for (const b of items.impact.blockers) if (b.question_id !== undefined) need(env.questionIds, b.question_id, b.id, "질문");
  for (const area of items.impact.areas) for (const id of area.screen_ids) need(env.screenIds, id, area.id, "화면");
  for (const { ev, owner, where } of collectEvidence(items)) {
    if (!env.units.has(ev.unit_id)) {
      out.push(issue("ref_missing", "reject", owner, `${owner} 의 ${where} 근거가 없는 원문 단위 '${ev.unit_id}' 를 가리킵니다`));
    }
  }
  return out;
}

// ---- 근거 ----

function checkEvidence(env: Env): Issue[] {
  const out: Issue[] = [];
  for (const { ev, owner, where } of collectEvidence(env.items)) {
    const unit = env.units.get(ev.unit_id);
    if (unit === undefined) continue;
    if ("quote" in ev) {
      const quote = normalizeText(ev.quote);
      if (quote.length === 0) {
        out.push(issue("quote_not_found", "reject", owner, `${owner} 의 ${where} 근거(${ev.unit_id}) 인용이 비어 있습니다`));
      } else if (!normalizeText(unit.text).includes(quote)) {
        out.push(issue("quote_not_found", "reject", owner, `${owner} 의 ${where} 근거 인용이 ${ev.unit_id} 본문에 없습니다: "${ev.quote}"`));
      }
    } else {
      const file = isAbsolute(ev.image) ? ev.image : join(env.ctx.runDir, ev.image);
      if (unit.image === undefined && !existsSync(file)) {
        out.push(issue("quote_not_found", "reject", owner, `${owner} 의 ${where} 이미지 근거를 확인할 수 없습니다: ${ev.unit_id} 에 이미지가 없고 파일 '${ev.image}' 도 없습니다`));
      }
    }
    if (unit.actor === "operator" && !hasMobileColumn(unit)) {
      out.push(issue("evidence_operator_row", "reject", owner, `${owner} 의 ${where} 근거 ${ev.unit_id} 는 주체가 운영자인 행이고 Mobile(App) 열 명시도 없습니다`));
    }
  }
  return out;
}

function checkEvidenceLane(env: Env): Issue[] {
  const out: Issue[] = [];
  for (const r of env.items.requirements) {
    const units = [...r.changes.flatMap((c) => c.evidence), ...r.ai.notes.flatMap((n) => n.evidence)]
      .map((ev) => env.units.get(ev.unit_id))
      .filter((u): u is Unit => u !== undefined);
    const webOnly = units.length > 0 && units.every((u) => FIGMA_KINDS.has(u.kind) && u.platform !== undefined && WEB_PLATFORMS.has(u.platform));
    if (webOnly) out.push(issue("evidence_wrong_lane", "warn", r.id, `${r.id} 의 근거가 모두 웹·모웹 레인 시안뿐입니다. 앱 레인 근거가 필요한지 확인하세요`));
  }
  return out;
}

// ---- 요구 ----

function checkRequirements(env: Env): Issue[] {
  const out: Issue[] = [];
  for (const r of env.items.requirements) {
    r.changes.forEach((c, i) => {
      if (c.evidence.length === 0) out.push(issue("change_without_evidence", "reject", r.id, `${r.id} 의 변경 항목 ${i + 1}("${c.text}")에 근거가 없습니다`));
    });
    if (r.acceptance.length === 0) out.push(issue("ac_missing", "reject", r.id, `${r.id} 에 인수 조건이 없습니다`));
    for (const a of r.acceptance) {
      if (a.verify === undefined) out.push(issue("ac_without_verify", "reject", a.id, `인수 조건 ${a.id} 에 검증 수단(verify)이 없습니다`));
    }
    r.ai.notes.forEach((n, i) => {
      if (n.evidence.length === 0) out.push(issue("ai_note_without_evidence", "reject", r.id, `${r.id} 의 ai.notes ${i + 1} 에 근거가 없습니다`));
    });
  }
  return out;
}

function checkAiCodePaths(env: Env): Issue[] {
  const targets = env.items.requirements.flatMap((r) =>
    r.ai.code.filter((c) => c.role === "modify" || c.role === "reuse").map((c) => ({ owner: r.id, path: c.path, role: c.role })),
  );
  if (targets.length === 0) return [];
  const repo = env.ctx.run.repo.path;
  if (repo === null || repo.length === 0) {
    return [issue("repo_path_unset", "warn", null, "대상 저장소 경로(run.repo.path)가 정해지지 않아 ai.code 경로 검사를 건너뛰었습니다")];
  }
  return targets
    .filter((t) => !existsSync(resolve(repo, t.path)))
    .map((t) => issue("ai_code_path_missing", "reject", t.owner, `${t.owner} 의 ai.code(${t.role}) 경로가 저장소에 없습니다: ${t.path}`));
}

function checkStatusVsOpen(env: Env): Issue[] {
  const out: Issue[] = [];
  const open = new Set(openIdList(env.open));
  for (const r of env.items.requirements) {
    const linked = [
      ...env.items.questions.filter((q) => q.affects.includes(r.id)).map((q) => q.id),
      ...env.items.deltas.filter((d) => d.requirement_ids.includes(r.id)).map((d) => d.id),
      ...env.items.assumptions.filter((a) => a.requirement_ids.includes(r.id)).map((a) => a.id),
    ];
    const linkedOpen = linked.filter((id) => open.has(id));
    if (r.status === "confirmed" && linkedOpen.length > 0) {
      out.push(issue("confirmed_with_open", "reject", r.id, `${r.id} 는 confirmed 인데 열린 항목(${linkedOpen.join(", ")})에 걸려 있습니다`));
    }
    if (r.status === "pending" && linkedOpen.length === 0) {
      out.push(issue("pending_without_open", "warn", r.id, `${r.id} 는 pending 인데 걸린 열린 항목이 없습니다`));
    }
  }
  return out;
}

function checkScreens(env: Env): Issue[] {
  const out: Issue[] = [];
  const used = new Set(env.items.requirements.flatMap((r) => r.changes.map((c) => c.screen_id).filter((id): id is string => id !== undefined)));
  for (const s of env.items.screens) {
    const hasAnyImage = s.images.length > 0 || s.variants.some((v) => v.images.length > 0);
    if (env.hasFigmaMeta && !hasAnyImage) out.push(issue("screen_without_image", "warn", s.id, `${s.id}(${s.name}) 와 그 변형에 이미지가 없습니다`));
    for (const v of s.variants) {
      if (!used.has(v.id)) out.push(issue("variant_without_change", "warn", v.id, `변형 ${v.id}(${v.name}) 에 걸린 변경 항목이 없습니다`));
    }
  }
  return out;
}

// ---- 차이, 질문 ----

function checkDeltas(env: Env): Issue[] {
  const out: Issue[] = [];
  for (const d of env.items.deltas) {
    const rec = d.recommendation;
    if (rec !== undefined && !isDecisionAllowed(d.kind, rec.decision)) {
      out.push(issue("delta_decision_kind", "reject", d.id, `${d.id}(${d.kind}) 의 추천 결정 '${rec.decision}' 은 이 종류에 허용되지 않습니다(${DELTA_DECISION_VALUES.filter((v) => isDecisionAllowed(d.kind, v)).join("·")})`));
    }
    const human = env.answers.scope[d.id];
    if (human !== undefined && !isDecisionAllowed(d.kind, human.decision)) {
      out.push(issue("delta_decision_kind", "warn", d.id, `${d.id}(${d.kind}) 에 들어온 사람의 결정 '${human.decision}' 은 이 종류에 허용되지 않아 결정 안 됨으로 다룹니다`));
    }
    if (d.requirement_ids.length >= 4) {
      out.push(issue("delta_multi_decision", "warn", d.id, `${d.id} 가 요구 ${d.requirement_ids.length}개에 걸려 있습니다. 결정이 요구마다 갈릴 수 있으면 나누세요`));
    }
    if (d.comparison === undefined || d.comparison.rows.length === 0) {
      out.push(issue("delta_comparison_missing", "warn", d.id, `${d.id} 에 비교 행이 없습니다`));
    } else if (d.kind === "mismatch" && !d.comparison.rows.some((row) => (row.prd ?? "").trim() !== "" && (row.figma ?? "").trim() !== "")) {
      out.push(issue("delta_comparison_unpaired", "warn", d.id, `${d.id} 는 mismatch 인데 PRD 와 시안이 짝지어진 비교 행이 없습니다`));
    }
  }
  return out;
}

function checkQuestions(env: Env): Issue[] {
  const out: Issue[] = [];
  for (const q of env.items.questions) {
    if (q.options.length === 0 && q.affects.length === 0) {
      out.push(issue("question_without_options", "reject", q.id, `${q.id} 에 선택지도, 답이 걸린 요구(affects)도 없습니다`));
    }
    for (const o of q.options) {
      if (o.consequence.trim().length === 0) {
        out.push(issue("question_without_options", "reject", q.id, `${q.id} 의 선택지 '${o.key}' 에 이 답이 바꾸는 구현(consequence)이 없습니다`));
      }
    }
  }
  return out;
}

// ---- 범위 장부 ----

function checkCoverage(env: Env): Issue[] {
  const out: Issue[] = [];
  const rowsOf = new Map<string, string[]>();
  for (const row of env.items.coverage) {
    for (const id of new Set(row.unit_ids)) rowsOf.set(id, [...(rowsOf.get(id) ?? []), row.id]);
  }
  for (const u of env.unitList) {
    const rows = rowsOf.get(u.id) ?? [];
    const autoNotApp = FIGMA_KINDS.has(u.kind) && u.platform !== undefined && WEB_PLATFORMS.has(u.platform);
    if (rows.length === 0 && !autoNotApp) {
      out.push(issue("coverage_incomplete", "reject", u.id, `원문 단위 ${u.id} 가 범위 장부의 어느 행에도 없습니다`));
    }
    if (rows.length > 1) {
      out.push(issue("coverage_incomplete", "reject", u.id, `원문 단위 ${u.id} 가 범위 장부의 여러 행(${rows.join(", ")})에 들어 있습니다`));
    }
  }
  for (const row of env.items.coverage) {
    if (row.disposition === "covered" && row.requirement_ids.length === 0 && row.screen_ids.length === 0) {
      out.push(issue("coverage_covered_without_target", "reject", row.id, `${row.id} 는 covered 인데 덮는 요구(requirement_ids)도 화면(screen_ids)도 없습니다`));
    }
    if (row.disposition !== "out_of_scope" && row.disposition !== "not_app") continue;
    if ((row.reason ?? "").trim().length === 0) {
      out.push(issue("scope_out_without_quote", "reject", row.id, `${row.id}(${row.disposition}) 에 사유(reason)가 없습니다`));
    }
    if (row.disposition !== "out_of_scope") continue;
    const dropped = row.delta_id !== undefined && env.answers.scope[row.delta_id]?.decision === "drop";
    if (dropped) continue;
    const quote = normalizeText(row.quote ?? "");
    if (quote.length === 0) {
      out.push(issue("scope_out_without_quote", "reject", row.id, `${row.id}(out_of_scope) 에 원문 인용(quote)이 없습니다`));
    } else if (!row.unit_ids.some((id) => normalizeText(env.units.get(id)?.text ?? "").includes(quote))) {
      out.push(issue("scope_out_without_quote", "reject", row.id, `${row.id}(out_of_scope) 의 인용이 행의 원문 단위 본문에 없습니다: "${row.quote}"`));
    }
  }
  return out;
}

// ---- 영향 분석 ----

function checkImpact(env: Env): Issue[] {
  const out: Issue[] = [];
  const { apis, blockers } = env.items.impact;
  if (apis.length > 0) {
    for (const api of apis) {
      if (Object.keys(api.presence).length === 0) {
        out.push(issue("api_presence_unchecked", "reject", `${api.method} ${api.path}`, `API ${api.method} ${api.path} 의 환경별 유무(presence)가 비어 있습니다`));
      }
    }
  }
  for (const b of blockers) {
    if (b.question_id === undefined || b.question_id.length === 0) {
      out.push(issue("blocker_without_question", "reject", b.id, `막힘 ${b.id} 가 질문으로 이어지지 않았습니다(question_id 없음)`));
    }
  }
  return out;
}

// ---- 비율 ----

function checkMismatchRatio(env: Env): Issue[] {
  const total = env.items.requirements.length;
  if (total === 0) return [];
  const hit = new Set(env.items.deltas.filter((d) => d.kind === "mismatch").flatMap((d) => d.requirement_ids));
  const ratio = hit.size / total;
  const base = `mismatch 차이에 걸린 요구 ${hit.size}/${total} = ${ratio.toFixed(2)}`;
  const message = ratio > MISMATCH_RATIO_LIMIT ? `${base}. ${MISMATCH_RATIO_LIMIT.toFixed(2)} 를 넘어 확인 요청서 필요` : `${base}. 확인 요청서는 필요 없음`;
  return [issue("mismatch_ratio", "info", null, message)];
}

// ---- 재제출 보호 ----

function previousIds(runDir: string): string[] {
  const file = runPaths(runDir).analysis;
  if (!existsSync(file)) return [];
  const doc = readJsonFile(file) as { items?: Record<string, unknown> } | null;
  const items = doc?.items ?? {};
  const ids: string[] = [];
  for (const group of ["questions", "deltas", "assumptions"]) {
    const list = items[group];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const id = (entry as { id?: unknown } | null)?.id;
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}

function checkRemoved(env: Env): Issue[] {
  if (!POST_GATE_STATES.includes(env.ctx.run.state)) return [];
  const now = new Set([...env.questionIds, ...env.deltaIds, ...env.assumptionIds]);
  const withdraw = new Set(env.ctx.withdraw ?? []);
  const out: Issue[] = [];
  for (const id of previousIds(env.ctx.runDir)) {
    if (now.has(id)) continue;
    const human = env.answers.answers[id] !== undefined || env.answers.scope[id] !== undefined || env.answers.assumptions[id] !== undefined;
    if (!withdraw.has(id)) {
      out.push(issue("id_removed", "reject", id, `${id} 가 --withdraw 없이 새 제출에서 사라졌습니다. 지우려면 --withdraw ${id} 로 명시하세요`));
    } else if (human) {
      out.push(issue("withdraw_has_human_input", "reject", id, `${id} 에는 사람의 입력이 있어 철회할 수 없습니다`));
    } else {
      out.push(issue("item_withdrawn", "warn", id, `${id} 를 철회했습니다`));
    }
  }
  return out;
}

/** 검증을 통과한 본문에 결정적 검사를 모두 돌린다. */
export function runAnalysisChecks(items: AnalysisItems, ctx: CheckContext): Issue[] {
  const env = buildEnv(items, ctx);
  return [
    ...checkIds(env),
    ...checkRefs(env),
    ...checkEvidence(env),
    ...checkEvidenceLane(env),
    ...checkRequirements(env),
    ...checkAiCodePaths(env),
    ...checkStatusVsOpen(env),
    ...checkScreens(env),
    ...checkDeltas(env),
    ...checkQuestions(env),
    ...checkCoverage(env),
    ...checkImpact(env),
    ...checkMismatchRatio(env),
    ...checkRemoved(env),
  ];
}

/** 등록용 검사: 본문을 스키마로 다시 읽은 뒤 결정적 검사를 돌린다. 스키마가 틀리면 그 지적만 낸다. */
export function analysisCheck(items: Record<string, unknown>, ctx: CheckContext): Issue[] {
  const parsed = AnalysisItemsSchema.safeParse(items);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => issue("schema_invalid", "reject", i.path.length > 0 ? i.path.join(".") : null, i.message));
  }
  return runAnalysisChecks(parsed.data, ctx);
}
