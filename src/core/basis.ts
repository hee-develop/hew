/** 시나리오가 기댄 분석의 요구별 해시(basis)와 그 변화 비교. */
import { existsSync } from "node:fs";
import { AnalysisItemsSchema, type AnalysisItems } from "./analysis/schema.js";
import { readJsonFile } from "./fsx.js";
import { hashJson } from "./hash.js";
import { runPaths } from "./paths.js";

export type Basis = Record<string, string>;

export interface BasisChange {
  id: string;
  change: "바뀜" | "추가" | "삭제";
}

/** 요구별 해시. 요구의 사람용 칸(title, changes 의 text·screen_id, acceptance)만으로 계산한다. */
export function requirementBasis(items: AnalysisItems): Basis {
  const out: Basis = {};
  for (const r of items.requirements) {
    out[r.id] = hashJson({
      title: r.title,
      changes: r.changes.map((c) => ({ text: c.text, screen_id: c.screen_id })),
      acceptance: r.acceptance,
    });
  }
  return out;
}

/** 실행 폴더의 분석 정본에서 요구별 해시를 만든다. 정본이 없거나 읽을 수 없으면 null. */
export function currentBasis(runDir: string): Basis | null {
  const file = runPaths(runDir).analysis;
  if (!existsSync(file)) return null;
  const parsed = AnalysisItemsSchema.safeParse((readJsonFile(file) as { items?: unknown } | null)?.items);
  return parsed.success ? requirementBasis(parsed.data) : null;
}

/** 이전 basis 와 지금 basis 를 비교해 바뀜·추가·삭제된 요구를 id 순으로 낸다. */
export function diffBasis(previous: Basis, current: Basis): BasisChange[] {
  const ids = [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const out: BasisChange[] = [];
  for (const id of ids) {
    const before = previous[id];
    const after = current[id];
    if (before === undefined) out.push({ id, change: "추가" });
    else if (after === undefined) out.push({ id, change: "삭제" });
    else if (before !== after) out.push({ id, change: "바뀜" });
  }
  return out;
}
