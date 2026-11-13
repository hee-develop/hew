/** 원천 등록·목록·추가 수집 요청·수집 완료 확인(§3.1). */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { rejectedError, usageError, type Issue } from "./errors.js";
import { appendEvent } from "./events.js";
import { normalizeNodeId } from "./figma/node-ref.js";
import { sha256Bytes } from "./hash.js";
import {
  SOURCE_KINDS,
  loadManifest,
  saveManifest,
  sortedSources,
  type SourceEntry,
  type SourceKind,
} from "./manifest.js";
import { runPaths } from "./paths.js";
import { computeRevision } from "./revision.js";
import { loadRun, saveRun, type Run } from "./run.js";
import { transition, type RunState } from "./state-machine.js";
import { sourceMarkdown, writeUnits } from "./units/index.js";

const SUBDIR: Partial<Record<SourceKind, string>> = {
  prd: "prd",
  ticket: "ticket",
  figma_meta: "figma",
  figma_shot: "figma",
  related: "related",
  openapi: "openapi",
};

export interface AddSourceOptions {
  runDir: string;
  kind: string;
  ref: string;
  version?: string;
  title?: string;
  file?: string;
  node?: string;
  env?: string;
  baseSha?: string;
  now?: Date;
}

export interface AddSourceResult {
  source: SourceEntry;
  /** 같은 원천이 이미 있어 바꾼 경우 true. */
  replaced: boolean;
  /** 같은 원천이고 내용도 같아 아무것도 바뀌지 않은 경우 true. */
  unchanged: boolean;
}

const safePart = (s: string): string =>
  s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");

function fileNameFor(entry: { kind: SourceKind; ref: string; version?: string; node?: string; env?: string }, ext: string): string {
  const parts = [entry.kind, safePart(entry.ref).slice(0, 60), entry.version ? `v${safePart(entry.version)}` : "", entry.node ? safePart(entry.node.replace(":", "-")) : "", entry.env ? safePart(entry.env) : ""];
  return `${parts.filter((p) => p.length > 0).join("-")}${ext}`;
}

const metaString = (s: SourceEntry, key: string): string => (typeof s.meta[key] === "string" ? (s.meta[key] as string) : "");

const sameIdentity = (s: SourceEntry, kind: SourceKind, ref: string, version: string, node: string, env: string): boolean =>
  s.kind === kind && s.ref === ref && (s.version ?? "") === version && metaString(s, "node") === node && metaString(s, "env") === env;

/** 값이 정해진 종류 목록에 있는지 확인하고 종류로 돌려준다. */
export function parseKind(kind: string): SourceKind {
  if (!(SOURCE_KINDS as readonly string[]).includes(kind)) {
    throw usageError(`--kind 는 ${SOURCE_KINDS.join("|")} 중 하나여야 합니다: ${kind}`);
  }
  return kind as SourceKind;
}

function refreshRevision(runDir: string, run: Run, now: Date): Run {
  return saveRun(runDir, { ...run, revision: computeRevision(runDir) }, now);
}

/** 원천을 등록한다. 같은 kind+ref+version(+node/env)이면 같은 id 로 내용을 바꾼다. 상태는 바꾸지 않는다. */
export function addSource(opts: AddSourceOptions): AddSourceResult {
  const now = opts.now ?? new Date();
  const kind = parseKind(opts.kind);
  if (opts.ref.trim().length === 0) throw usageError("--ref 가 비어 있습니다");
  const run = loadRun(opts.runDir);
  const paths = runPaths(opts.runDir);

  const meta: Record<string, unknown> = {};
  let node: string | undefined;
  if (opts.node !== undefined) {
    node = normalizeNodeId(opts.node);
    if (node === undefined) throw usageError(`--node 형식이 올바르지 않습니다(예: 12:34): ${opts.node}`);
    meta.node = node;
  }
  if (kind === "figma_shot" && node === undefined) throw usageError("figma_shot 에는 --node <figma 노드 id> 가 필요합니다");
  if (opts.env !== undefined) meta.env = opts.env;
  if (kind === "openapi" && opts.env === undefined) throw usageError("openapi 에는 --env <환경 이름> 이 필요합니다");

  let bytes: Buffer | undefined;
  if (kind === "code") {
    if (opts.baseSha === undefined || opts.baseSha.length === 0) throw usageError("code 에는 --base-sha <sha> 가 필요합니다");
    if (opts.file !== undefined) throw usageError("code 는 파일 없이 --ref <저장소 경로> --base-sha 로 등록합니다");
    meta.base_sha = opts.baseSha;
  } else {
    if (opts.file === undefined) throw usageError(`${kind} 에는 --file <경로> 가 필요합니다`);
    if (!existsSync(opts.file) || !statSync(opts.file).isFile()) throw usageError(`파일이 없습니다: ${opts.file}`);
    bytes = readFileSync(opts.file);
  }

  const manifest = loadManifest(opts.runDir);
  const version = opts.version ?? "";
  const existing = manifest.sources.find((s) => sameIdentity(s, kind, opts.ref, version, node ?? "", opts.env ?? ""));
  const maxN = manifest.sources.reduce((n, s) => Math.max(n, Number(s.id.slice(2))), 0);
  const id = existing?.id ?? `S-${maxN + 1}`;

  const entry: SourceEntry = { id, kind, ref: opts.ref, added_at: now.toISOString(), meta };
  if (opts.version !== undefined) entry.version = opts.version;
  if (opts.title !== undefined) entry.title = opts.title;

  if (bytes !== undefined && opts.file !== undefined) {
    const subdir = SUBDIR[kind] as string;
    let name = fileNameFor({ kind, ref: opts.ref, version: opts.version, node, env: opts.env }, extname(opts.file));
    const taken = (n: string): boolean => manifest.sources.some((s) => s.id !== id && s.path === `sources/${subdir}/${n}`);
    if (taken(name)) name = `${name.slice(0, name.length - extname(name).length)}-${id}${extname(name)}`;
    entry.path = `sources/${subdir}/${name}`;
    entry.sha256 = sha256Bytes(bytes);
    entry.bytes = bytes.length;
    const dest = join(opts.runDir, entry.path);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(opts.file, dest);
  }

  const unchanged =
    existing !== undefined &&
    existing.sha256 === entry.sha256 &&
    existing.title === entry.title &&
    JSON.stringify(existing.meta) === JSON.stringify(entry.meta);
  const finalEntry = unchanged ? (existing as SourceEntry) : entry;
  const sources = existing ? manifest.sources.map((s) => (s.id === id ? finalEntry : s)) : [...manifest.sources, finalEntry];
  saveManifest(opts.runDir, { sources });
  refreshRevision(opts.runDir, run, now);
  appendEvent(paths.events, "source_added", { id, kind, ref: opts.ref, version: opts.version ?? null, replaced: existing !== undefined, unchanged, sha256: finalEntry.sha256 ?? null }, now);
  return { source: finalEntry, replaced: existing !== undefined, unchanged };
}

export function listSources(runDir: string): SourceEntry[] {
  loadRun(runDir);
  return sortedSources(loadManifest(runDir));
}

export interface RequestSourceOptions {
  runDir: string;
  what: string;
  node?: string;
  now?: Date;
}

/** 추가 수집 요청을 requests.jsonl 에 한 줄 덧붙인다. 상태는 바꾸지 않는다. */
export function requestSource(opts: RequestSourceOptions): { what: string; node?: string } {
  const now = opts.now ?? new Date();
  loadRun(opts.runDir);
  if (opts.what.trim().length === 0) throw usageError("--what 이 비어 있습니다");
  let node: string | undefined;
  if (opts.node !== undefined) {
    node = normalizeNodeId(opts.node);
    if (node === undefined) throw usageError(`--node 형식이 올바르지 않습니다(예: 12:34): ${opts.node}`);
  }
  const paths = runPaths(opts.runDir);
  const record = { at: now.toISOString(), what: opts.what, ...(node === undefined ? {} : { node }) };
  mkdirSync(dirname(paths.requests), { recursive: true });
  appendFileSync(paths.requests, `${JSON.stringify(record)}\n`, "utf8");
  appendEvent(paths.events, "source_requested", { what: opts.what, node: node ?? null }, now);
  return { what: opts.what, ...(node === undefined ? {} : { node }) };
}

export interface DoneResult {
  previous_state: RunState;
  state: RunState;
  revision: string;
  units: number;
  screens: number;
}

const missing = (ref: string, message: string): Issue => ({ code: "source_missing", severity: "reject", ref, message });

/** 필수 원천이 다 찼는지 확인한다. 모자라면 종료 3. 차면 단위·화면 목록을 만들고 init 일 때만 collected 로 간다. */
export function doneSources(runDir: string, nowArg?: Date): DoneResult {
  const now = nowArg ?? new Date();
  const run = loadRun(runDir);
  const paths = runPaths(runDir);
  const sources = sortedSources(loadManifest(runDir));
  const count = (kind: SourceKind): number => sources.filter((s) => s.kind === kind).length;

  const issues: Issue[] = [];
  if (run.input.kind === "prd" && count("prd") === 0) issues.push(missing("prd", "PRD 원천이 없습니다 (hew source add --kind prd)"));
  if (run.input.kind === "ticket" && count("ticket") === 0) issues.push(missing("ticket", "티켓 원천이 없습니다 (hew source add --kind ticket)"));
  if (count("code") === 0) issues.push(missing("code", "코드 원천이 없습니다 (hew source add --kind code --ref <저장소 경로> --base-sha <sha>)"));
  const mentionsFigma = sources
    .filter((s) => s.kind === "prd" || s.kind === "ticket")
    .some((s) => /figma\.com/i.test(sourceMarkdown(runDir, s)));
  if (mentionsFigma && count("figma_meta") === 0) {
    issues.push(missing("figma_meta", "PRD·티켓 본문에 figma.com 링크가 있는데 Figma 메타데이터 원천이 없습니다 (hew source add --kind figma_meta)"));
  }
  if (issues.length > 0) {
    appendEvent(paths.events, "sources_incomplete", { missing: issues.map((i) => i.ref) }, now);
    throw rejectedError(`필수 원천이 모자랍니다(${issues.length}건). 상태는 바뀌지 않았습니다`, issues);
  }

  const built = writeUnits(runDir);
  const revision = computeRevision(runDir);
  let state = run.state;
  let row: number | null = null;
  if (run.state === "init") {
    const result = transition(run.state, { type: "sources_complete" }, { rework: run.rework, progress: run.progress, open: run.open, revision });
    state = result.state;
    row = result.row;
  }
  saveRun(runDir, { ...run, state, revision }, now);
  const screens = built.units.units.filter((u) => u.kind === "figma_screen").length;
  appendEvent(paths.events, "sources_done", { from: run.state, to: state, row, revision, units: built.units.units.length, screens }, now);
  return { previous_state: run.state, state, revision, units: built.units.units.length, screens };
}
