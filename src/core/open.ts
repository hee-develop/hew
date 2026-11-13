/** 실행 전체의 열린 항목: analysis 의 열린 질문·차이·가정과 scenarios 의 답 없는 질문. */
import { existsSync } from "node:fs";
import { readJsonFile } from "./fsx.js";
import { runPaths } from "./paths.js";
import { getKindSpec } from "./submit.js";

export type OpenKind = "analysis" | "scenarios";

/** 아직 정본에 쓰지 않은 제출본. 정본 대신 이 본문으로 그 종류의 열린 항목을 센다. */
export interface OpenOverride {
  kind: OpenKind;
  items: Record<string, unknown>;
}

function storedItems(runDir: string, kind: OpenKind): Record<string, unknown> | null {
  const file = kind === "analysis" ? runPaths(runDir).analysis : runPaths(runDir).scenarios;
  if (!existsSync(file)) return null;
  const doc = readJsonFile(file) as { items?: unknown } | null;
  const items = doc?.items;
  return items !== null && typeof items === "object" && !Array.isArray(items) ? (items as Record<string, unknown>) : null;
}

/** 실행 폴더의 정본(과 override)에서 열린 항목 id 를 analysis, scenarios 순으로 모은다. */
export function collectRunOpen(runDir: string, override?: OpenOverride): string[] {
  const ids: string[] = [];
  for (const kind of ["analysis", "scenarios"] as const) {
    const items = override?.kind === kind ? override.items : storedItems(runDir, kind);
    if (items !== null) ids.push(...getKindSpec(kind).collectOpen(items, runDir));
  }
  return ids;
}
