/** 차단 지적을 origin sasu 질문으로 바꿔 분석 정본에 더한다. */
import { existsSync } from "node:fs";
import { AnalysisItemsSchema, type AnalysisItems, type Question } from "../analysis/schema.js";
import { normalizeText } from "../analysis/checks.js";
import { HewError } from "../errors.js";
import { splitWorkId, type StoredFinding } from "../findings/schema.js";
import { readJsonFile, writeJsonAtomic } from "../fsx.js";
import { isId } from "../ids.js";
import { runPaths } from "../paths.js";
import { ScenarioItemsSchema, type ScenarioItems } from "../scenarios/schema.js";
import { getKindSpec } from "../submit.js";
import type { Unit } from "../units/types.js";

export interface ConvertResult {
  added: string[];
  /** 걸려서 pending 으로 바꾼 요구 id. */
  pended: string[];
  /** 질문을 더한 뒤의 분석 열린 항목 id 목록. */
  open: string[];
}

const textKey = (work: string, kind: string): string => `사수 확인(${work}, ${kind})`;

/** 지적 대상이 걸린 요구 id. 대상이 요구면 그 요구, 단위·화면·차이·질문이면 그것에 걸린 요구들. */
export function affectedRequirements(items: AnalysisItems, work: string, scenarios: ScenarioItems | null): string[] {
  const scenarioReqs = (id: string): string[] => scenarios?.scenarios.find((s) => s.id === id)?.requirement_ids ?? [];
  const parts = splitWorkId(work);
  if (parts === null) return [];
  const { code, target } = parts;
  const reqs = items.requirements;
  const ids = ((): string[] => {
    switch (code) {
      case "W2":
      case "W4":
      case "W5":
        return reqs.filter((r) => r.id === target).map((r) => r.id);
      case "W3":
      case "W6":
        return reqs
          .filter((r) => [...r.changes, ...r.ai.notes].some((c) => c.evidence.some((ev) => ev.unit_id === target)))
          .map((r) => r.id);
      case "W7":
        return reqs.filter((r) => r.changes.some((c) => c.screen_id === target)).map((r) => r.id);
      case "W8":
        return items.deltas.find((d) => d.id === target)?.requirement_ids ?? [];
      case "W9": {
        const q = [...items.questions, ...(scenarios?.questions ?? [])].find((x) => x.id === target);
        const affects = q?.affects ?? [];
        return affects.flatMap((id) => (isId("requirement", id) ? [id] : scenarioReqs(id)));
      }
    }
  })();
  return [...new Set(ids)].filter((id) => reqs.some((r) => r.id === id));
}

function rationaleOf(f: StoredFinding, units: Map<string, Unit>): Question["rationale"] {
  const quote = f.evidence?.quote;
  if (quote === undefined || normalizeText(quote).length === 0) return [];
  const target = splitWorkId(f.work)?.target ?? "";
  const candidates = [f.evidence?.unit_id, isId("unit", target) ? target : undefined];
  for (const id of candidates) {
    if (id === undefined) continue;
    const unit = units.get(id);
    if (unit !== undefined && normalizeText(unit.text).includes(normalizeText(quote))) return [{ unit_id: id, quote }];
  }
  return [];
}

const maxQuestionNumber = (ids: string[]): number => ids.reduce((max, id) => (isId("question", id) ? Math.max(max, Number(id.slice(2))) : max), 0);

/** 지적마다 질문 하나를 더한다(같은 대상·같은 종류의 sasu 질문이 있으면 건너뜀). 정본을 다시 쓰고 열린 항목 목록을 돌려준다. */
export function convertFindingsToQuestions(runDir: string, findings: StoredFinding[]): ConvertResult {
  const p = runPaths(runDir);
  const doc = readJsonFile(p.analysis) as { items: unknown; open?: string[] };
  const parsed = AnalysisItemsSchema.safeParse(doc.items);
  if (!parsed.success) throw new HewError("internal", `analysis.json 형식이 올바르지 않습니다: ${parsed.error.issues[0]?.message ?? ""}`);
  const items = parsed.data;
  const scenarios = existsSync(p.scenarios) ? ScenarioItemsSchema.safeParse((readJsonFile(p.scenarios) as { items?: unknown }).items) : null;
  const scenarioItems = scenarios?.success ? scenarios.data : null;
  const scenarioQuestions = scenarioItems?.questions ?? [];
  const units = new Map(
    (existsSync(p.units) ? ((readJsonFile(p.units) as { units?: Unit[] }).units ?? []) : []).map((u) => [u.id, u] as const),
  );

  let next = maxQuestionNumber([...items.questions, ...scenarioQuestions].map((q) => q.id));
  const added: Question[] = [];
  const pended = new Set<string>();
  for (const f of findings) {
    const kind = f.kind ?? "";
    const prefix = textKey(f.work, kind);
    const exists = [...items.questions, ...added].some((q) => q.origin === "sasu" && q.text.startsWith(prefix));
    if (exists) continue;
    next += 1;
    const affects = affectedRequirements(items, f.work, scenarioItems);
    added.push({
      id: `Q-${next}`,
      text: `${prefix}: ${(f.claim ?? "").trim()} 어떻게 처리할까요?`,
      origin: "sasu",
      blocking: true,
      options: [
        { key: "fix", label: "지적대로 고친다", consequence: "분석 문서를 지적에 맞게 고쳐 요구·인수 조건에 반영한다" },
        { key: "keep", label: "지금대로 둔다", consequence: "분석 문서를 그대로 두고 지적을 무시한다" },
      ],
      rationale: rationaleOf(f, units),
      affects,
      audience: [],
    });
    for (const id of affects) pended.add(id);
  }
  if (added.length === 0) return { added: [], pended: [], open: doc.open ?? [] };

  const raw = doc.items as Record<string, unknown>;
  const pendedNow: string[] = [];
  const requirements = (raw.requirements as Record<string, unknown>[]).map((r) => {
    if (r.status === "confirmed" && typeof r.id === "string" && pended.has(r.id)) {
      pendedNow.push(r.id);
      return { ...r, status: "pending" };
    }
    return r;
  });
  const nextItems = { ...raw, requirements, questions: [...(raw.questions as unknown[]), ...added] };
  const open = getKindSpec("analysis").collectOpen(nextItems, runDir);
  writeJsonAtomic(p.analysis, { ...doc, items: nextItems, open });
  return { added: added.map((q) => q.id), pended: pendedNow, open };
}
