/** 차단 지적을 origin sasu 질문으로 바꿔(같은 지적은 하나로 합쳐) 분석 정본에 더한다. */
import { existsSync } from "node:fs";
import { AnalysisItemsSchema, type AnalysisItems, type Question } from "../analysis/schema.js";
import { normalizeText } from "../analysis/checks.js";
import { HewError } from "../errors.js";
import { groupDuplicateFindings } from "../findings/group.js";
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
      case "T1":
        return [];
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

/** 이미 만든 sasu 질문이 이 대상·종류의 지적을 다루는가(본문 머리의 대상이나 "같은 지적" 목록에 대상이 있으면 다룬 것). */
function coversFinding(text: string, work: string, kind: string): boolean {
  const target = splitWorkId(work)?.target ?? work;
  if (text.startsWith(textKey(work, kind))) return true;
  const head = /^사수 확인\((\S+?), (\S+?)\)/.exec(text);
  const list = /\(같은 지적 \d+건: ([^)]*)\)$/.exec(text);
  if (head === null || list === null || head[2] !== kind) return false;
  return (list[1] ?? "").split(", ").includes(target);
}

/** 같은 종류·같은 문장의 지적을 질문 하나로 합쳐 더한다(같은 대상·같은 종류의 sasu 질문이 있으면 건너뜀). 정본을 다시 쓰고 열린 항목 목록을 돌려준다. */
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
  for (const group of groupDuplicateFindings(findings)) {
    const kind = group[0]?.kind ?? "";
    const fresh = group.filter((f) => ![...items.questions, ...added].some((q) => q.origin === "sasu" && coversFinding(q.text, f.work, kind)));
    const first = fresh[0];
    if (first === undefined) continue;
    next += 1;
    const affects = [...new Set(fresh.flatMap((f) => affectedRequirements(items, f.work, scenarioItems)))];
    const rationale = fresh
      .flatMap((f) => rationaleOf(f, units))
      .filter((r, i, all) => all.findIndex((x) => JSON.stringify(x) === JSON.stringify(r)) === i);
    const targets = fresh.map((f) => splitWorkId(f.work)?.target ?? f.work);
    const same = fresh.length > 1 ? ` (같은 지적 ${fresh.length}건: ${targets.join(", ")})` : "";
    added.push({
      id: `Q-${next}`,
      text: `${textKey(first.work, kind)}: ${(first.claim ?? "").trim()} 어떻게 처리할까요?${same}`,
      origin: "sasu",
      blocking: true,
      options: [
        { key: "fix", label: "지적대로 고친다", consequence: "분석 문서를 지적에 맞게 고쳐 요구·인수 조건에 반영한다" },
        { key: "keep", label: "지금대로 둔다", consequence: "분석 문서를 그대로 두고 지적을 무시한다" },
      ],
      rationale,
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
