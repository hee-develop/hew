/** plan 의 결정적 검사(§7.3). 검증을 통과한 본문과 정본 analysis·사람의 답·분해 규칙을 대조한다. */
import type { Issue, Severity } from "../errors.js";
import { isId } from "../ids.js";
import type { CheckContext } from "../submit.js";
import { loadAnswers, type AnswersFile } from "../analysis/answers.js";
import type { AnalysisItems, Requirement } from "../analysis/schema.js";
import { loadAnalysis } from "../scenarios/checks.js";
import { humanTitleFormat, titlePrefix } from "../profile.js";
import { loadPlanRules, type PlanRules } from "./rules.js";
import { PlanItemsSchema, type Pr, type PlanItems, type Ticket } from "./schema.js";

const issue = (code: string, severity: Severity, ref: string | null, message: string): Issue => ({ code, severity, ref, message });

/** 범위 밖으로 본 요구와, 그 요구를 범위 밖으로 만든 차이 id. */
export interface PlanScope {
  outOfScope: Set<string>;
  deltasOf: Map<string, string[]>;
}

/** 사람이 drop·hold 로 결정한 차이에 걸린 요구는 요구 전체를 범위 밖으로 본다. */
export function planScope(analysis: AnalysisItems, answers: AnswersFile): PlanScope {
  const outOfScope = new Set<string>();
  const deltasOf = new Map<string, string[]>();
  for (const d of analysis.deltas) {
    const decision = answers.scope[d.id]?.decision;
    if (decision !== "drop" && decision !== "hold") continue;
    for (const id of d.requirement_ids) {
      outOfScope.add(id);
      deltasOf.set(id, [...(deltasOf.get(id) ?? []), d.id]);
    }
  }
  return { outOfScope, deltasOf };
}

/** 뺀 변경 항목의 ref 형식: `요구-n#<index>`. */
export const changeRef = (requirementId: string, index: number): string => `${requirementId}#${index}`;

interface Env {
  items: PlanItems;
  analysis: AnalysisItems;
  answers: AnswersFile;
  rules: PlanRules;
  scope: PlanScope;
  reqById: Map<string, Requirement>;
  ticketById: Map<string, Ticket>;
  prById: Map<string, Pr>;
}

function buildEnv(items: PlanItems, analysis: AnalysisItems, ctx: CheckContext): Env {
  const answers = loadAnswers(ctx.runDir);
  return {
    items,
    analysis,
    answers,
    rules: loadPlanRules(),
    scope: planScope(analysis, answers),
    reqById: new Map(analysis.requirements.map((r) => [r.id, r])),
    ticketById: new Map(items.tickets.map((t) => [t.id, t])),
    prById: new Map(items.prs.map((p) => [p.id, p])),
  };
}

const orderOf = (env: Env, ticket: Ticket): number | null => env.prById.get(ticket.pr)?.order ?? null;

// ---- id ----

function checkIds(env: Env): Issue[] {
  const out: Issue[] = [];
  const seen = new Set<string>();
  const dup = (label: string, id: string): void => {
    if (seen.has(id)) out.push(issue("id_duplicate", "reject", id, `${label} id '${id}' 가 두 번 이상 쓰였습니다`));
    seen.add(id);
  };
  for (const t of env.items.tickets) {
    if (!isId("ticket", t.id)) out.push(issue("id_format", "reject", t.id, `티켓 id '${t.id}' 의 형식이 올바르지 않습니다(Tn)`));
    dup("티켓", t.id);
  }
  for (const p of env.items.prs) {
    if (!isId("pr", p.id)) out.push(issue("id_format", "reject", p.id, `PR 묶음 id '${p.id}' 의 형식이 올바르지 않습니다(PR-n)`));
    dup("PR 묶음", p.id);
  }
  return out;
}

// ---- 참조 ----

function checkRefs(env: Env): Issue[] {
  const out: Issue[] = [];
  const missing = (owner: string, what: string, id: string): void =>
    void out.push(issue("plan_ref_missing", "reject", owner, `${owner} 이(가) 없는 ${what} '${id}' 를 가리킵니다`));
  for (const t of env.items.tickets) {
    for (const id of t.requirement_ids) if (!env.reqById.has(id)) missing(t.id, "요구", id);
    for (const id of t.depends_on) if (!env.ticketById.has(id)) missing(t.id, "티켓", id);
    for (const c of t.changes) {
      const req = env.reqById.get(c.requirement_id);
      if (req === undefined) missing(t.id, "요구(changes)", c.requirement_id);
      else if (c.index >= req.changes.length) {
        out.push(issue("plan_ref_missing", "reject", t.id, `${t.id} 의 changes 가 ${req.id} 에 없는 변경 항목 위치 ${c.index} 를 가리킵니다(0~${req.changes.length - 1})`));
      }
      if (!t.requirement_ids.includes(c.requirement_id)) {
        out.push(issue("plan_ref_missing", "reject", t.id, `${t.id} 의 changes 가 가리키는 요구 '${c.requirement_id}' 가 requirement_ids 에 없습니다`));
      }
    }
  }
  for (const p of env.items.prs) {
    for (const id of p.ticket_ids) if (!env.ticketById.has(id)) missing(p.id, "티켓", id);
    if (p.base !== env.rules.pr.base && !env.prById.has(p.base)) missing(p.id, "base PR 묶음", p.base);
  }
  const removal = env.items.feature_flag?.removal_ticket;
  if (removal !== undefined && !env.ticketById.has(removal)) missing("feature_flag", "티켓(removal_ticket)", removal);
  return out;
}

// ---- 덮임과 범위 ----

function checkCoverage(env: Env): Issue[] {
  const whole = new Set<string>();
  const parts = new Map<string, Set<number>>();
  for (const t of env.items.tickets) {
    for (const id of new Set(t.requirement_ids)) {
      const mine = t.changes.filter((c) => c.requirement_id === id);
      if (mine.length === 0) whole.add(id);
      else for (const c of mine) parts.set(id, (parts.get(id) ?? new Set<number>()).add(c.index));
    }
  }
  const out: Issue[] = [];
  for (const r of env.analysis.requirements) {
    if (env.scope.outOfScope.has(r.id) || whole.has(r.id)) continue;
    if (r.changes.length === 0) {
      out.push(issue("requirement_unmapped", "reject", r.id, `${r.id}(${r.title}) 를 맡은 티켓이 없습니다`));
      continue;
    }
    r.changes.forEach((c, index) => {
      if (parts.get(r.id)?.has(index) !== true) {
        out.push(issue("requirement_unmapped", "reject", changeRef(r.id, index), `${r.id} 의 변경 항목 ${index}("${c.text}")를 맡은 티켓이 없습니다`));
      }
    });
  }
  return out;
}

function isExcluded(env: Env, requirementId: string): boolean {
  const deltas = env.scope.deltasOf.get(requirementId) ?? [];
  return env.items.excluded.some(
    (e) =>
      (e.kind === "requirement" && e.ref === requirementId) ||
      (e.kind === "delta" && deltas.includes(e.ref)) ||
      (e.kind === "change" && e.ref.startsWith(`${requirementId}#`)),
  );
}

function checkScope(env: Env): Issue[] {
  const out: Issue[] = [];
  for (const t of env.items.tickets) {
    for (const id of t.requirement_ids) {
      if (env.scope.outOfScope.has(id)) {
        out.push(issue("hold_included", "reject", t.id, `${t.id} 가 보류·구현 안 함으로 결정된 요구 ${id} 를 맡고 있습니다`));
      }
    }
  }
  for (const id of env.scope.outOfScope) {
    if (env.reqById.has(id) && !isExcluded(env, id)) {
      out.push(issue("excluded_missing", "warn", id, `${id} 는 범위 밖(보류·구현 안 함)인데 excluded 에 뺀 이유가 없습니다`));
    }
  }
  const orphan = env.items.feature_flag?.removal_ticket;
  for (const t of env.items.tickets) {
    if (t.requirement_ids.length === 0 && t.id !== orphan) {
      out.push(issue("ticket_orphan", "reject", t.id, `${t.id} 는 맡은 요구가 없고 플래그 제거 티켓도 아닙니다`));
    }
  }
  return out;
}

// ---- 제목과 본문 ----

function checkTitles(env: Env): Issue[] {
  const pattern = new RegExp(env.rules.title_pattern);
  const out: Issue[] = [];
  for (const t of env.items.tickets) {
    if (!pattern.test(t.title)) {
      out.push(issue("title_format", "reject", t.id, `${t.id} 의 제목 '${t.title}' 이 형식 '${humanTitleFormat(env.rules.title_format)}' 과 다릅니다`));
    } else if (!t.title.startsWith(titlePrefix(env.rules.title_format, env.items.epic_name))) {
      out.push(issue("title_format", "reject", t.id, `${t.id} 의 제목 '${t.title}' 의 일감명이 epic_name '${env.items.epic_name}' 와 다릅니다`));
    }
  }
  return out;
}

const blank = (text: string): boolean => text.trim().length === 0;

function checkBodies(env: Env): Issue[] {
  const out: Issue[] = [];
  const forbidden = env.rules.body_forbidden.map((f) => ({ re: new RegExp(f.pattern), label: f.label }));
  for (const t of env.items.tickets) {
    const { body } = t;
    if (blank(body.background)) out.push(issue("body_sections", "reject", t.id, `${t.id} 의 본문에 배경(background)이 없습니다`));
    if (body.work.every(blank)) out.push(issue("body_sections", "reject", t.id, `${t.id} 의 본문에 작업 내용(work)이 없습니다`));
    const texts: [string, string][] = [
      ["배경", body.background],
      ...body.work.map((w): [string, string] => ["작업 내용", w]),
      ...body.checks.map((c): [string, string] => ["확인 사항", c]),
      ["선행 의존", body.depends_note ?? ""],
    ];
    for (const [section, text] of texts) {
      for (const f of forbidden) {
        const hit = f.re.exec(text);
        if (hit !== null) {
          out.push(issue("body_code_detail", "reject", t.id, `${t.id} 의 ${section} 에 코드 내용(${f.label})이 있습니다: "${hit[0]}"`));
        }
      }
    }
  }
  return out;
}

// ---- 의존·순서 ----

/** 간선 함수로 순환 하나를 찾아 id 경로로 돌려준다. 없으면 null. */
function findCycle(ids: string[], next: (id: string) => string[]): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, "visiting");
    stack.push(id);
    for (const to of next(id)) {
      if (state.get(to) === "visiting") return [...stack.slice(stack.indexOf(to)), to];
      if (!state.has(to)) {
        const found = visit(to);
        if (found !== null) return found;
      }
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };
  for (const id of ids) {
    if (state.has(id)) continue;
    const found = visit(id);
    if (found !== null) return found;
  }
  return null;
}

function checkCycles(env: Env): Issue[] {
  const out: Issue[] = [];
  const tickets = findCycle(env.items.tickets.map((t) => t.id), (id) => (env.ticketById.get(id)?.depends_on ?? []).filter((d) => env.ticketById.has(d)));
  if (tickets !== null) out.push(issue("dependency_cycle", "reject", tickets[0] ?? null, `티켓 의존에 순환이 있습니다: ${tickets.join(" → ")}`));
  const prs = findCycle(env.items.prs.map((p) => p.id), (id) => {
    const base = env.prById.get(id)?.base;
    return base !== undefined && env.prById.has(base) ? [base] : [];
  });
  if (prs !== null) out.push(issue("dependency_cycle", "reject", prs[0] ?? null, `PR base 사슬에 순환이 있습니다: ${prs.join(" → ")}`));
  return out;
}

function checkPrLinks(env: Env): Issue[] {
  const out: Issue[] = [];
  for (const t of env.items.tickets) {
    const pr = env.prById.get(t.pr);
    if (pr === undefined) {
      out.push(issue("ticket_without_pr", "reject", t.id, `${t.id} 의 pr '${t.pr}' 에 해당하는 PR 묶음이 없습니다`));
    } else if (!pr.ticket_ids.includes(t.id)) {
      out.push(issue("pr_ticket_mismatch", "reject", t.id, `${t.id} 는 pr 이 ${pr.id} 인데 ${pr.id} 의 ticket_ids 에 없습니다`));
    }
  }
  for (const p of env.items.prs) {
    for (const id of p.ticket_ids) {
      const t = env.ticketById.get(id);
      if (t !== undefined && t.pr !== p.id && env.prById.has(t.pr)) {
        out.push(issue("pr_ticket_mismatch", "reject", p.id, `${p.id} 의 ticket_ids 에 든 ${id} 는 pr 이 '${t.pr}' 입니다`));
      }
    }
  }
  return out;
}

function checkOrder(env: Env): Issue[] {
  const out: Issue[] = [];
  for (const a of env.items.tickets) {
    const orderA = orderOf(env, a);
    if (orderA === null) continue;
    for (const id of a.depends_on) {
      const b = env.ticketById.get(id);
      const orderB = b === undefined ? null : orderOf(env, b);
      if (b !== undefined && orderB !== null && orderA < orderB) {
        out.push(issue("pr_base_order", "reject", a.id, `${a.id} 는 ${b.id} 에 의존하는데 ${a.id} 의 PR(${a.pr}, 순서 ${orderA})이 ${b.id} 의 PR(${b.pr}, 순서 ${orderB})보다 먼저입니다`));
      }
    }
  }
  for (const p of env.items.prs) {
    const base = env.prById.get(p.base);
    if (base !== undefined && base.order >= p.order) {
      out.push(issue("pr_base_order", "reject", p.id, `${p.id}(순서 ${p.order})의 base ${base.id} 의 순서 ${base.order} 가 더 작아야 합니다`));
    }
  }
  return out;
}

function checkFlag(env: Env): Issue[] {
  const flag = env.items.feature_flag;
  if (flag?.used !== true) return [];
  const removal = flag.removal_ticket === undefined ? undefined : env.ticketById.get(flag.removal_ticket);
  if (removal === undefined) {
    return [issue("flag_removal_last", "reject", "feature_flag", "피처플래그를 쓰는데 removal_ticket 이 없거나 없는 티켓입니다")];
  }
  const last = Math.max(...env.items.prs.map((p) => p.order));
  const order = orderOf(env, removal);
  return order === last ? [] : [issue("flag_removal_last", "reject", removal.id, `플래그 제거 티켓 ${removal.id} 의 PR 이 마지막 순서(${last})가 아닙니다`)];
}

function checkRequirementDependencies(env: Env): Issue[] {
  const out: Issue[] = [];
  const ticketsOf = (id: string): Ticket[] => env.items.tickets.filter((t) => t.requirement_ids.includes(id));
  for (const x of env.analysis.requirements) {
    for (const yId of x.depends_on) {
      const orders = ticketsOf(yId).map((t) => orderOf(env, t)).filter((o): o is number => o !== null);
      if (orders.length === 0) continue;
      const last = Math.max(...orders);
      for (const t of ticketsOf(x.id)) {
        const order = orderOf(env, t);
        if (order !== null && order < last) {
          out.push(issue("requirement_dependency_broken", "reject", t.id, `${x.id} 는 ${yId} 에 의존하는데 ${t.id} 의 PR 순서 ${order} 가 ${yId} 를 맡은 티켓의 마지막 순서 ${last} 보다 앞입니다`));
        }
      }
    }
  }
  return out;
}

// ---- 크기 ----

function checkSizes(env: Env): Issue[] {
  const { sp, pr } = env.rules;
  const out: Issue[] = [];
  for (const t of env.items.tickets) {
    if (t.sp < sp.min || t.sp > sp.max) {
      out.push(issue("sp_range", "warn", t.id, `${t.id} 의 SP ${t.sp}(${t.sp * sp.hours_per_sp}시간)가 기본 범위 ${sp.min}~${sp.max}SP 를 벗어났습니다`));
    }
  }
  for (const p of env.items.prs) {
    if (p.ticket_ids.length > pr.max_tickets) {
      out.push(issue("pr_too_large", "warn", p.id, `${p.id} 의 티켓이 ${p.ticket_ids.length}개로 상한 ${pr.max_tickets}개를 넘었습니다`));
    }
  }
  return out;
}

function checkRequests(env: Env): Issue[] {
  const count = env.answers.plan_requests.length;
  return count === 0 ? [] : [issue("plan_change_unaddressed", "info", null, `사람의 수정 요청이 ${count}건 들어와 있습니다. 반영 여부는 승인 단계에서 사람이 확인합니다`)];
}

/** 검증을 통과한 본문에 결정적 검사를 모두 돌린다. 정본 analysis 가 없으면 거부 하나만 낸다. */
export function runPlanChecks(items: PlanItems, ctx: CheckContext): Issue[] {
  const analysis = loadAnalysis(ctx.runDir);
  if (analysis === null) {
    return [issue("analysis_missing", "reject", null, "정본 분석 문서(doc/analysis.json)가 없거나 읽을 수 없어 분해안을 검사할 수 없습니다")];
  }
  const env = buildEnv(items, analysis, ctx);
  return [
    ...checkIds(env),
    ...checkRefs(env),
    ...checkCoverage(env),
    ...checkScope(env),
    ...checkTitles(env),
    ...checkBodies(env),
    ...checkCycles(env),
    ...checkPrLinks(env),
    ...checkOrder(env),
    ...checkFlag(env),
    ...checkRequirementDependencies(env),
    ...checkSizes(env),
    ...checkRequests(env),
  ];
}

/** 등록용 검사: 본문을 스키마로 다시 읽은 뒤 결정적 검사를 돌린다. 스키마가 틀리면 그 지적만 낸다. */
export function planCheck(items: Record<string, unknown>, ctx: CheckContext): Issue[] {
  const parsed = PlanItemsSchema.safeParse(items);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => issue("schema_invalid", "reject", i.path.length > 0 ? i.path.join(".") : null, i.message));
  }
  return runPlanChecks(parsed.data, ctx);
}
