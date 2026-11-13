/** sources/manifest.json 의 형식과 읽기·쓰기. */
import { existsSync } from "node:fs";
import { z } from "zod";
import { HewError } from "./errors.js";
import { readJsonFile, writeJsonAtomic } from "./fsx.js";
import { ID_PATTERNS } from "./ids.js";
import { runPaths } from "./paths.js";

export const SOURCE_KINDS = ["prd", "ticket", "figma_meta", "figma_shot", "related", "code", "openapi"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SourceEntrySchema = z.object({
  id: z.string().regex(ID_PATTERNS.source),
  kind: z.enum(SOURCE_KINDS),
  ref: z.string().min(1),
  version: z.string().optional(),
  title: z.string().optional(),
  path: z.string().optional(),
  sha256: z.string().optional(),
  bytes: z.number().int().min(0).optional(),
  added_at: z.string(),
  meta: z.record(z.unknown()),
});

export const ManifestSchema = z.object({ sources: z.array(SourceEntrySchema) });

export type SourceEntry = z.infer<typeof SourceEntrySchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

/** manifest 를 읽는다. 없으면 빈 목록. */
export function loadManifest(runDir: string): Manifest {
  const file = runPaths(runDir).manifest;
  if (!existsSync(file)) return { sources: [] };
  const parsed = ManifestSchema.safeParse(readJsonFile(file));
  if (!parsed.success) {
    throw new HewError("internal", `manifest.json 형식이 올바르지 않습니다: ${parsed.error.issues[0]?.message ?? ""}`);
  }
  return parsed.data;
}

export function saveManifest(runDir: string, manifest: Manifest): void {
  writeJsonAtomic(runPaths(runDir).manifest, ManifestSchema.parse(manifest));
}

/** id 의 숫자 순서로 정렬한 사본. */
export function sortedSources(manifest: Manifest): SourceEntry[] {
  const n = (s: SourceEntry): number => Number(s.id.slice(2));
  return [...manifest.sources].sort((a, b) => n(a) - n(b));
}
