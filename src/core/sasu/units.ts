/** 정본에서 사수 작업 단위(W2~W9)와 inputs 를 만든다. */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { loadAnswers } from "../analysis/answers.js";
import { isQuestionAnswered } from "../analysis/open-items.js";
import {
  AnalysisItemsSchema,
  type AnalysisItems,
  type Evidence,
  type Question,
  type Requirement,
} from "../analysis/schema.js";
import { HewError, stateError } from "../errors.js";
import { WORK_CODES, type WorkCode } from "../findings/schema.js";
import { readJsonFile } from "../fsx.js";
import { hashJson } from "../hash.js";
import { runPaths } from "../paths.js";
import { ScenarioItemsSchema, type ScenarioItems } from "../scenarios/schema.js";
import type { DocLocator, Unit } from "../units/types.js";

/** 종류마다 사수가 답할 한 문장. */
export const CODE_QUESTIONS: Record<WorkCode, string> = {
  W2: "변경 항목 각각이 근거로 든 원문으로 뒷받침되는가. 원문보다 넓거나 다르게 적은 것이 있는가",
  W3: "이 원문 단위가 말하는 것이 빠짐없이 요구에 있는가. 범위 장부의 처리(범위 밖, 앱 작업 아님, 배경)가 맞는가",
  W4: "원문에 미정·조건부·논의 필요 같은 표시가 있는데 확정으로 적었는가",
  W5: "AI용 보충(ai_notes)에만 있는 동작이나 조건이 있는가",
  W6: "이 표 행의 주체가 운영자·관리자(사내 어드민 작업자)인가",
  W7: "이 변형과 그 화면 전체에 걸린 변경 항목 어디에도 없는 눈에 보이는 차이(아이콘·그래픽·컴포넌트 교체, 사라진 요소, 달라진 배치)가 있는가. 변형은 changes_for_variant(그 변형에 직접 걸린 변경)와 changes_for_screen(부모 화면 전체에 걸린 변경)을, 화면은 changes_for_screen 과 changes_for_variants(그 화면의 모든 변형에 걸린 변경)를 함께 본다",
  W8: "한 행에 놓인 PRD 와 시안이 같은 조건·같은 대상인가",
  W9: "원문에 이미 답이 있는 질문인가",
};

/** 직전 지적과 테크니컬 매니저의 답변이 inputs.previous 에 실렸을 때 덧붙이는 질문. */
export const PREVIOUS_QUESTION =
  "직전 지적과 테크니컬 매니저의 답변이 previous 에 있으면, 답변을 읽고 지적이 풀렸는지 다시 판정한다. 답변이 근거를 들어 반박했고 그 근거가 맞으면 ok 다";

/** 직전 회차의 지적과 그에 대한 테크니컬 매니저의 답변. */
export interface PreviousInput {
  claim: string;
  kind: string;
  response?: { response: string; reason: string; evidence?: { unit_id: string; quote: string } };
}

export interface WorkUnit {
  id: string;
  code: WorkCode;
  target: string;
  question: string;
  inputs: Record<string, unknown>;
  hash: string;
}

const NEIGHBOR_LIMIT = 12;
const DOC_KINDS = new Set(["table_row", "bullet", "paragraph"]);
const W3_KINDS = new Set(["table_row", "bullet", "paragraph", "figma_desc"]);
const WEB_PLATFORMS = new Set(["web", "mobile_web"]);

interface Source {
  runDir: string;
  items: AnalysisItems;
  scenarios: ScenarioItems | null;
  units: Unit[];
  byId: Map<string, Unit>;
  answered: (q: Pick<Question, "id" | "text" | "options">) => boolean;
}

function readItems(file: string): unknown {
  return (readJsonFile(file) as { items?: unknown }).items;
}

function loadSource(runDir: string): Source {
  const p = runPaths(runDir);
  if (!existsSync(p.analysis)) throw stateError("분석 정본(doc/analysis.json)이 없어 사수 작업 단위를 만들 수 없습니다");
  const analysis = AnalysisItemsSchema.safeParse(readItems(p.analysis));
  if (!analysis.success) throw new HewError("internal", `analysis.json 형식이 올바르지 않습니다: ${analysis.error.issues[0]?.message ?? ""}`);
  let scenarios: ScenarioItems | null = null;
  if (existsSync(p.scenarios)) {
    const parsed = ScenarioItemsSchema.safeParse(readItems(p.scenarios));
    if (parsed.success) scenarios = parsed.data;
  }
  const units = existsSync(p.units) ? ((readJsonFile(p.units) as { units?: Unit[] }).units ?? []) : [];
  const answers = loadAnswers(runDir);
  return {
    runDir,
    items: analysis.data,
    scenarios,
    units,
    byId: new Map(units.map((u) => [u.id, u])),
    answered: (q) => isQuestionAnswered(q, answers),
  };
}

const absolute = (runDir: string, path: string): string => (isAbsolute(path) ? path : resolve(runDir, path));

function evidenceInput(src: Source, ev: Evidence, withQuote: boolean): Record<string, unknown> {
  if ("image" in ev) return { unit_id: ev.unit_id, image: absolute(src.runDir, ev.image) };
  const out: Record<string, unknown> = { unit_id: ev.unit_id };
  if (withQuote) out.quote = ev.quote;
  out.text = src.byId.get(ev.unit_id)?.text ?? "";
  return out;
}

/** 요구의 변경 항목과 ai.notes 가 근거로 든 원문 단위 id 를 순서대로, 중복 없이 모은다. */
function citedUnitIds(r: Requirement): string[] {
  const ids: string[] = [];
  for (const c of r.changes) for (const ev of c.evidence) ids.push(ev.unit_id);
  for (const n of r.ai.notes) for (const ev of n.evidence) ids.push(ev.unit_id);
  return [...new Set(ids)];
}

const unitText = (src: Source, id: string): { id: string; text: string } => ({ id, text: src.byId.get(id)?.text ?? "" });

function w2(src: Source): WorkUnit[] {
  return src.items.requirements.map((r) =>
    make("W2", r.id, {
      title: r.title,
      changes: r.changes.map((c) => ({
        text: c.text,
        screen_id: c.screen_id,
        evidence: c.evidence.map((ev) => evidenceInput(src, ev, false)),
      })),
    }),
  );
}

function w3(src: Source): WorkUnit[] {
  const out: WorkUnit[] = [];
  for (const u of src.units) {
    if (!W3_KINDS.has(u.kind)) continue;
    if (u.kind === "figma_desc" && u.platform !== undefined && WEB_PLATFORMS.has(u.platform)) continue;
    const rows = src.items.coverage.filter((row) => row.unit_ids.includes(u.id));
    const reqs = src.items.requirements.filter((r) => citedUnitIds(r).includes(u.id));
    out.push(
      make("W3", u.id, {
        text: u.text,
        columns: u.columns,
        actor: u.actor,
        coverage: rows.map((row) => ({ id: row.id, disposition: row.disposition, reason: row.reason, quote: row.quote })),
        requirements: reqs.map((r) => ({ id: r.id, title: r.title, changes: r.changes.map((c) => c.text) })),
      }),
    );
  }
  return out;
}

const sectionKey = (u: Unit): string | null => {
  const section = (u.locator as DocLocator).section;
  return Array.isArray(section) ? JSON.stringify(section) : null;
};

function w4(src: Source): WorkUnit[] {
  return src.items.requirements
    .filter((r) => r.status === "confirmed")
    .map((r) => {
      const cited = citedUnitIds(r);
      const sections = new Set(cited.map((id) => src.byId.get(id)).filter((u): u is Unit => u !== undefined).map(sectionKey).filter((k): k is string => k !== null));
      const neighbors = src.units
        .filter((u) => DOC_KINDS.has(u.kind) && !cited.includes(u.id) && sections.has(sectionKey(u) ?? ""))
        .slice(0, NEIGHBOR_LIMIT)
        .map((u) => ({ id: u.id, text: u.text }));
      return make("W4", r.id, {
        title: r.title,
        changes: r.changes.map((c) => c.text),
        evidence_units: cited.map((id) => unitText(src, id)),
        neighbors,
      });
    });
}

function w5(src: Source): WorkUnit[] {
  return src.items.requirements
    .filter((r) => r.ai.notes.length > 0)
    .map((r) =>
      make("W5", r.id, {
        title: r.title,
        changes: r.changes.map((c) => c.text),
        acceptance: r.acceptance.map((a) => ({ id: a.id, given: a.given, when: a.when, then: a.then })),
        ai_notes: r.ai.notes.map((n) => n.text),
      }),
    );
}

function w6(src: Source): WorkUnit[] {
  const cited = new Set(src.items.requirements.flatMap(citedUnitIds));
  return src.units
    .filter((u) => u.kind === "table_row" && u.actor === undefined && cited.has(u.id))
    .map((u) => make("W6", u.id, { text: u.text, columns: u.columns }));
}

function w7(src: Source): WorkUnit[] {
  const out: WorkUnit[] = [];
  const changes = src.items.requirements.flatMap((r) => r.changes.map((c) => ({ ...c, screenIds: r.screen_ids })));
  /** 그 화면에 걸린 변경: screen_id 가 화면 id 이거나, screen_id 가 없고 요구의 screen_ids 에 화면이 있는 것. */
  const forScreen = (screenId: string): string[] =>
    changes.filter((c) => c.screen_id === screenId || (c.screen_id === undefined && c.screenIds.includes(screenId))).map((c) => c.text);
  const forId = (id: string): string[] => changes.filter((c) => c.screen_id === id).map((c) => c.text);
  const images = (list: { role: string; path: string }[]): { as_is: string; to_be: string } | null => {
    const asIs = list.find((i) => i.role === "as_is");
    const toBe = list.find((i) => i.role === "to_be");
    return asIs === undefined || toBe === undefined ? null : { as_is: absolute(src.runDir, asIs.path), to_be: absolute(src.runDir, toBe.path) };
  };
  for (const s of src.items.screens) {
    const own = images(s.images);
    if (own !== null) {
      out.push(make("W7", s.id, { ...own, changes_for_screen: forScreen(s.id), changes_for_variants: s.variants.flatMap((v) => forId(v.id)) }));
    }
    for (const v of s.variants) {
      const mine = images(v.images);
      if (mine !== null) out.push(make("W7", v.id, { ...mine, changes_for_variant: forId(v.id), changes_for_screen: forScreen(s.id) }));
    }
  }
  return out;
}

function w8(src: Source): WorkUnit[] {
  return src.items.deltas
    .filter((d) => (d.comparison?.rows.length ?? 0) > 0)
    .map((d) =>
      make("W8", d.id, {
        title: d.title,
        kind: d.kind,
        rows: d.comparison?.rows ?? [],
        prd_evidence: d.prd_evidence.map((ev) => evidenceInput(src, ev, true)),
        figma_evidence: d.figma_evidence.map((ev) => evidenceInput(src, ev, true)),
      }),
    );
}

function w9(src: Source): WorkUnit[] {
  const questions: Question[] = [...src.items.questions, ...(src.scenarios?.questions ?? [])].filter(
    (q) => q.origin !== "sasu" && !src.answered(q),
  );
  const requirementsOf = (id: string): string[] => {
    const scenario = src.scenarios?.scenarios.find((s) => s.id === id);
    return scenario !== undefined ? scenario.requirement_ids : [id];
  };
  return questions.map((q) => {
    const reqIds = [...new Set(q.affects.flatMap(requirementsOf))];
    const affects = src.items.requirements
      .filter((r) => reqIds.includes(r.id))
      .map((r) => ({ id: r.id, units: citedUnitIds(r).map((id) => unitText(src, id)) }));
    return make("W9", q.id, {
      text: q.text,
      options: q.options,
      rationale: q.rationale.map((ev) => evidenceInput(src, ev, true)),
      affects,
    });
  });
}

function make(code: WorkCode, target: string, inputs: Record<string, unknown>): WorkUnit {
  const clean = JSON.parse(JSON.stringify(inputs)) as Record<string, unknown>;
  return { id: `${code}:${target}`, code, target, question: CODE_QUESTIONS[code], inputs: clean, hash: hashJson(clean) };
}

/** 작업 단위의 inputs 에 직전 지적·답변을 더한다. hash 는 더하기 전 inputs 로 계산한 값 그대로 둔다. */
export function withPrevious(unit: WorkUnit, previous: PreviousInput): WorkUnit {
  return { ...unit, inputs: { ...unit.inputs, previous: JSON.parse(JSON.stringify(previous)) as PreviousInput } };
}

const BUILDERS: Record<WorkCode, (src: Source) => WorkUnit[]> = { W2: w2, W3: w3, W4: w4, W5: w5, W6: w6, W7: w7, W8: w8, W9: w9 };

/** 분석 정본·원문 단위·범위 장부·답에서 작업 단위 전체를 코드 순서(W2~W9)로 만든다. */
export function buildWorkUnits(runDir: string): WorkUnit[] {
  const src = loadSource(runDir);
  return WORK_CODES.flatMap((code) => BUILDERS[code](src));
}
