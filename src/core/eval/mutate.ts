/** 결함 주입의 후보 찾기와 변형: 분석 문서와 원문 단위만 받아 순수하게 계산한다. */
import type { AnalysisItems, Evidence, Requirement } from "../analysis/schema.js";
import { DOC_KINDS, citedUnitIds, hasVisualPair, neighborUnits } from "../sasu/units.js";
import type { Unit } from "../units/types.js";
import type { EvalKind } from "./kinds.js";

type Change = Requirement["changes"][number];
type Row = { aspect: string; prd?: string; figma?: string };

export interface Candidate {
  /** 후보 정렬에 쓰는 id(예: `요구-2#0`). */
  id: string;
  /** 잡아야 하는 작업 단위 id. */
  expected: string;
  /** 바꾼 항목(요구 id, 변경 index, 차이 id 등). */
  target: Record<string, unknown>;
  /** 분석 문서 사본을 직접 고치고 바꾸기 전후 값을 돌려준다. */
  apply: (items: AnalysisItems) => { before: unknown; after: unknown };
}

const PENDING_MARKERS = /미정|논의|TBD|확인 필요|명확화|검토 중/i;

/** 숫자 뒤에 % 나 px 가 붙은 첫 숫자, 없으면 첫 숫자. */
const PERCENT_NUMBER = /\d+(?=\s*(?:%|px))/;
const ANY_NUMBER = /\d+/;

/** 낱말 교체 규칙을 시도하는 순서. */
const WORD_SWAPS: { from: RegExp; to: string }[] = [
  { from: /이내/, to: "이후" },
  { from: /이후/, to: "이내" },
  { from: /이전/, to: "이후" },
  { from: /이후/, to: "이전" },
  { from: /추가한다/, to: "없앤다" },
  { from: /없앤다/, to: "추가한다" },
  { from: /(?<![가-힣])위(?=에|로|쪽|[^가-힣]|$)/, to: "아래" },
  { from: /(?<![가-힣])아래/, to: "위" },
  { from: /보인다/, to: "숨긴다" },
  { from: /숨긴다/, to: "보인다" },
];

/** 변경 문장을 원문과 어긋나게 바꾼다: 첫 숫자에 2를 더하고, 숫자가 없으면 낱말 하나를 반대로 바꾼다. 바꿀 곳이 없으면 null. */
export function alterText(text: string): string | null {
  const number = PERCENT_NUMBER.exec(text) ?? ANY_NUMBER.exec(text);
  if (number !== null) return `${text.slice(0, number.index)}${Number(number[0]) + 2}${text.slice(number.index + number[0].length)}`;
  for (const swap of WORD_SWAPS) {
    const found = swap.from.exec(text);
    if (found !== null) return `${text.slice(0, found.index)}${swap.to}${text.slice(found.index + found[0].length)}`;
  }
  return null;
}

const quoteEvidence = (c: Change): Extract<Evidence, { quote: string }>[] =>
  c.evidence.filter((ev): ev is Extract<Evidence, { quote: string }> => "quote" in ev);

const compareNatural = (a: string, b: string): number => {
  const left = a.split(/(\d+)/);
  const right = b.split(/(\d+)/);
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const x = left[i] as string;
    const y = right[i] as string;
    if (i % 2 === 1) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return left.length - right.length;
};

/** 그 단위를 (한 변경 항목을 빼고) 다른 변경이나 ai.notes 가 근거로 들었는가. */
function citedElsewhere(items: AnalysisItems, requirementId: string, index: number, unitId: string): boolean {
  for (const r of items.requirements) {
    const inChange = r.changes.some((c, i) => !(r.id === requirementId && i === index) && c.evidence.some((ev) => ev.unit_id === unitId));
    if (inChange || r.ai.notes.some((n) => n.evidence.some((ev) => ev.unit_id === unitId))) return true;
  }
  return false;
}

function w3(items: AnalysisItems, units: Map<string, Unit>): Candidate[] {
  const out: Candidate[] = [];
  for (const r of items.requirements) {
    if (r.changes.length < 2) continue;
    r.changes.forEach((c, index) => {
      const unitIds = [...new Set(quoteEvidence(c).map((ev) => ev.unit_id))];
      const unitId = unitIds[0];
      if (unitIds.length !== 1 || unitId === undefined) return;
      const unit = units.get(unitId);
      if (unit === undefined || !DOC_KINDS.has(unit.kind) || citedElsewhere(items, r.id, index, unitId)) return;
      out.push({
        id: `${r.id}#${index}`,
        expected: `W3:${unitId}`,
        target: { requirement_id: r.id, change_index: index, unit_id: unitId },
        apply: (copy) => {
          const removed = copy.requirements.find((x) => x.id === r.id)?.changes.splice(index, 1)[0];
          return { before: removed ?? null, after: null };
        },
      });
    });
  }
  return out;
}

function w2(items: AnalysisItems): Candidate[] {
  const out: Candidate[] = [];
  for (const r of items.requirements) {
    r.changes.forEach((c, index) => {
      const altered = quoteEvidence(c).length > 0 ? alterText(c.text) : null;
      if (altered === null) return;
      out.push({
        id: `${r.id}#${index}`,
        expected: `W2:${r.id}`,
        target: { requirement_id: r.id, change_index: index },
        apply: (copy) => {
          const change = copy.requirements.find((x) => x.id === r.id)?.changes[index];
          if (change !== undefined) change.text = altered;
          return { before: c.text, after: altered };
        },
      });
    });
  }
  return out;
}

const linksOf = (items: AnalysisItems, id: string): { questions: string[]; deltas: string[]; assumptions: string[] } => ({
  questions: items.questions.filter((q) => q.affects.includes(id)).map((q) => q.id),
  deltas: items.deltas.filter((d) => d.requirement_ids.includes(id)).map((d) => d.id),
  assumptions: items.assumptions.filter((a) => a.requirement_ids.includes(id)).map((a) => a.id),
});

function w4(items: AnalysisItems, units: Map<string, Unit>, unitList: Unit[]): Candidate[] {
  const out: Candidate[] = [];
  for (const r of items.requirements) {
    if (r.status !== "pending") continue;
    const cited = citedUnitIds(r);
    const texts = [...cited.map((id) => units.get(id)?.text ?? ""), ...neighborUnits(unitList, cited).map((u) => u.text)];
    if (!texts.some((t) => PENDING_MARKERS.test(t))) continue;
    out.push({
      id: r.id,
      expected: `W4:${r.id}`,
      target: { requirement_id: r.id },
      apply: (copy) => {
        const links = linksOf(copy, r.id);
        const target = copy.requirements.find((x) => x.id === r.id);
        if (target !== undefined) target.status = "confirmed";
        for (const q of copy.questions) q.affects = q.affects.filter((id) => id !== r.id);
        for (const d of copy.deltas) d.requirement_ids = d.requirement_ids.filter((id) => id !== r.id);
        for (const a of copy.assumptions) a.requirement_ids = a.requirement_ids.filter((id) => id !== r.id);
        return { before: { status: "pending", linked: links }, after: { status: "confirmed", linked: linksOf(copy, r.id) } };
      },
    });
  }
  return out;
}

const screenName = (items: AnalysisItems, id: string | undefined): string => {
  if (id === undefined) return "이 화면";
  for (const s of items.screens) {
    if (s.id === id) return s.name;
    const variant = s.variants.find((v) => v.id === id);
    if (variant !== undefined) return variant.name;
  }
  return "이 화면";
};

function w5(items: AnalysisItems): Candidate[] {
  const out: Candidate[] = [];
  for (const r of items.requirements) {
    const evidence = [...r.changes.flatMap(quoteEvidence), ...r.ai.notes.flatMap((n) => n.evidence.filter((ev): ev is Extract<Evidence, { quote: string }> => "quote" in ev))][0];
    if (evidence === undefined) continue;
    const text = `단, ${screenName(items, r.screen_ids[0])}에 처음 들어온 사용자에게만 적용하고 두 번째부터는 보이지 않는다`;
    const note = { text, evidence: [{ ...evidence }] };
    out.push({
      id: r.id,
      expected: `W5:${r.id}`,
      target: { requirement_id: r.id },
      apply: (copy) => {
        copy.requirements.find((x) => x.id === r.id)?.ai.notes.push(note);
        return { before: null, after: note };
      },
    });
  }
  return out;
}

function w7(items: AnalysisItems): Candidate[] {
  const visual = new Set<string>();
  for (const s of items.screens) {
    if (hasVisualPair(s.images)) visual.add(s.id);
    for (const v of s.variants) if (hasVisualPair(v.images)) visual.add(v.id);
  }
  const out: Candidate[] = [];
  for (const r of items.requirements) {
    if (r.changes.length < 2) continue;
    r.changes.forEach((c, index) => {
      if (c.evidence.length === 0 || !c.evidence.every((ev) => "image" in ev)) return;
      const screenId = c.screen_id ?? r.screen_ids.find((id) => visual.has(id));
      if (screenId === undefined || !visual.has(screenId)) return;
      out.push({
        id: `${r.id}#${index}`,
        expected: `W7:${screenId}`,
        target: { requirement_id: r.id, change_index: index, screen_id: screenId },
        apply: (copy) => {
          const removed = copy.requirements.find((x) => x.id === r.id)?.changes.splice(index, 1)[0];
          return { before: removed ?? null, after: null };
        },
      });
    });
  }
  return out;
}

const paired = (row: Row): boolean => (row.prd ?? "").trim() !== "" && (row.figma ?? "").trim() !== "";

function w8(items: AnalysisItems): Candidate[] {
  const out: Candidate[] = [];
  for (const d of items.deltas) {
    const rows = d.comparison?.rows ?? [];
    const eligible = rows.map((row, index) => ({ row, index })).filter((x) => paired(x.row));
    let pair: [number, number] | null = null;
    for (let i = 0; i < eligible.length && pair === null; i += 1) {
      for (let j = i + 1; j < eligible.length && pair === null; j += 1) {
        if ((eligible[i] as (typeof eligible)[number]).row.figma !== (eligible[j] as (typeof eligible)[number]).row.figma) {
          pair = [(eligible[i] as (typeof eligible)[number]).index, (eligible[j] as (typeof eligible)[number]).index];
        }
      }
    }
    if (pair === null) continue;
    const [a, b] = pair;
    out.push({
      id: d.id,
      expected: `W8:${d.id}`,
      target: { delta_id: d.id, row_indexes: [a, b] },
      apply: (copy) => {
        const target = copy.deltas.find((x) => x.id === d.id)?.comparison?.rows;
        const before = [a, b].map((i) => ({ ...(rows[i] as Row) }));
        if (target !== undefined) {
          const first = target[a] as Row;
          const second = target[b] as Row;
          const figma = first.figma;
          first.figma = second.figma;
          second.figma = figma;
        }
        return { before, after: target === undefined ? null : [a, b].map((i) => ({ ...(target[i] as Row) })) };
      },
    });
  }
  return out;
}

/** 그 종류의 후보를 id 순(숫자는 크기순)으로 찾는다. */
export function findCandidates(kind: EvalKind, items: AnalysisItems, unitList: Unit[]): Candidate[] {
  const units = new Map(unitList.map((u) => [u.id, u]));
  const found =
    kind === "w3_delete" ? w3(items, units)
    : kind === "w2_alter" ? w2(items)
    : kind === "w4_confirm" ? w4(items, units, unitList)
    : kind === "w5_ainote" ? w5(items)
    : kind === "w7_drop_visual" ? w7(items)
    : w8(items);
  return found.sort((x, y) => compareNatural(x.id, y.id));
}
