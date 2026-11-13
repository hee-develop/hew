/** 등록된 원천에서 화면 목록(inventory)과 원문 단위(units.json)를 다시 만든다. */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { rejectedError } from "../errors.js";
import { writeJsonAtomic } from "../fsx.js";
import { asFileKey, normalizeNodeId, parseNodeRef } from "../figma/node-ref.js";
import { inventoryFileFromContent, type Inventory } from "../figma/inventory.js";
import { loadManifest, sortedSources, type SourceEntry } from "../manifest.js";
import { runPaths } from "../paths.js";
import { markdownFromSource } from "./extract.js";
import { parseMarkdownUnits } from "./markdown.js";
import type { Unit, UnitsFile } from "./types.js";

const DOC_KINDS = new Set(["prd", "ticket", "related"]);

export interface BuildResult {
  units: UnitsFile;
  inventory: Inventory | null;
}

function readSourceText(runDir: string, source: SourceEntry): string {
  const file = source.path === undefined ? undefined : join(runDir, source.path);
  if (file === undefined || !existsSync(file)) {
    throw rejectedError(`원천 파일을 읽을 수 없습니다: ${source.id} (${source.path ?? "경로 없음"})`);
  }
  return readFileSync(file, "utf8");
}

/** 원천 본문(문서 원천)의 Markdown. JSON 원본이면 그 안의 본문. */
export function sourceMarkdown(runDir: string, source: SourceEntry): string {
  const text = readSourceText(runDir, source);
  return markdownFromSource(text, basename(source.path ?? ""));
}

const KEY_DASH_NODE = /^([0-9A-Za-z]{22,128}):\d{1,7}-\d{1,7}$/;

/** figma_meta 원천의 파일 키. meta.file_key, ref(`<키>`, `<키>:<a>-<b>`, 노드 참조), 파일 이름 순으로 찾는다. */
export function fileKeyOf(source: SourceEntry): string | undefined {
  const fromMeta = typeof source.meta.file_key === "string" ? source.meta.file_key : undefined;
  if (fromMeta) return fromMeta;
  const fromDash = KEY_DASH_NODE.exec(source.ref)?.[1];
  if (fromDash) return fromDash;
  const fromRef = asFileKey(source.ref) ?? parseNodeRef(source.ref)?.key;
  if (fromRef) return fromRef;
  const fromName = /^figma-([0-9A-Za-z]{22,128})-/.exec(basename(source.path ?? ""));
  return fromName?.[1];
}

/** figma_shot 원천을 노드 id → 파일 경로로 모은다. */
function shotImages(sources: SourceEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of sources) {
    if (s.kind !== "figma_shot" || s.path === undefined || typeof s.meta.node !== "string") continue;
    const node = normalizeNodeId(s.meta.node);
    if (node !== undefined && !map.has(node)) map.set(node, s.path);
  }
  return map;
}

/** 원천 순서(S-1, S-2…)와 문서 안의 순서대로 U-1 부터 단위를 만든다. */
export function buildUnits(runDir: string): BuildResult {
  const sources = sortedSources(loadManifest(runDir));
  const images = shotImages(sources);
  const units: Unit[] = [];
  const inventoryFiles: Inventory["files"] = [];
  const nextId = (): string => `U-${units.length + 1}`;

  for (const source of sources) {
    if (DOC_KINDS.has(source.kind)) {
      for (const raw of parseMarkdownUnits(sourceMarkdown(runDir, source))) {
        units.push({ id: nextId(), source_id: source.id, ...raw });
      }
    } else if (source.kind === "figma_meta") {
      const file = inventoryFileFromContent(source.id, fileKeyOf(source), readSourceText(runDir, source));
      inventoryFiles.push(file);
      for (const frame of file.frames) {
        if (frame.is_desc && (frame.text ?? "").length === 0) continue;
        const unit: Unit = {
          id: nextId(),
          source_id: source.id,
          kind: frame.is_desc ? "figma_desc" : "figma_screen",
          locator: { node_id: frame.node_id, name: frame.name },
          text: frame.is_desc ? (frame.text as string) : frame.name,
          platform: frame.platform,
        };
        const image = images.get(frame.node_id);
        if (image !== undefined) unit.image = image;
        units.push(unit);
      }
    }
  }
  return { units: { units }, inventory: inventoryFiles.length > 0 ? { files: inventoryFiles } : null };
}

/** 단위와 화면 목록을 다시 만들어 sources/units.json 과 sources/figma/inventory.json 에 쓴다. */
export function writeUnits(runDir: string): BuildResult {
  const paths = runPaths(runDir);
  const result = buildUnits(runDir);
  writeJsonAtomic(paths.units, result.units);
  if (result.inventory) writeJsonAtomic(paths.inventory, result.inventory);
  return result;
}
