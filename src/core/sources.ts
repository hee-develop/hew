/** 원천 등록·목록·추가 수집 요청·수집 완료 확인(§3.1). */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { loadCalls, payloadFile } from "./collect/calls.js";
import { loadCollectConfig } from "./collect/config.js";
import { appendFailure, readFailures } from "./collect/failures.js";
import { computePlan, knownItemIds, type PlanItem } from "./collect/plan.js";
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
import { loadRun, saveRun, type CollectWarning, type Run } from "./run.js";
import { transition, type RunState } from "./state-machine.js";
import { metaFromResponse, parseSourceJson } from "./units/extract.js";
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
  /** --file 대신 받아 적은 도구 결과의 호출 번호. */
  fromCall?: number;
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
  let ext = "";
  if (kind === "code") {
    if (opts.baseSha === undefined || opts.baseSha.length === 0) throw usageError("code 에는 --base-sha <sha> 가 필요합니다");
    if (opts.file !== undefined || opts.fromCall !== undefined) throw usageError("code 는 파일 없이 --ref <저장소 경로> --base-sha 로 등록합니다");
    meta.base_sha = opts.baseSha;
  } else if (opts.file !== undefined && opts.fromCall !== undefined) {
    throw usageError("--file 과 --from-call 은 둘 중 하나만 지정할 수 있습니다");
  } else if (opts.fromCall !== undefined) {
    const calls = loadCalls(opts.runDir);
    const call = calls.calls.find((c) => c.n === opts.fromCall);
    const file = payloadFile(calls.callsDir, opts.fromCall);
    if (call === undefined || !existsSync(file)) throw usageError(`호출 번호 ${opts.fromCall} 의 받아 적은 결과가 없습니다(${calls.callsDir}). hew source calls 로 확인하세요`);
    bytes = readFileSync(file);
    ext = parseSourceJson(bytes.toString("utf8")) === undefined ? ".md" : ".json";
    meta.call = call.n;
    if (call.tool !== null) meta.tool = call.tool;
    if (call.tool_use_id !== null) meta.tool_use_id = call.tool_use_id;
  } else {
    if (opts.file === undefined) throw usageError(`${kind} 에는 --file <경로> 또는 --from-call <번호> 가 필요합니다`);
    if (!existsSync(opts.file) || !statSync(opts.file).isFile()) throw usageError(`파일이 없습니다: ${opts.file}`);
    bytes = readFileSync(opts.file);
    ext = extname(opts.file);
  }

  // 문서 응답(JSON)에서 제목·버전을 찾아 비어 있는 칸을 채운다.
  let title = opts.title;
  let version = opts.version;
  if (bytes !== undefined && (kind === "prd" || kind === "ticket" || kind === "related") && ext.toLowerCase() === ".json") {
    const found = metaFromResponse(parseSourceJson(bytes.toString("utf8")));
    if (title === undefined && found.title !== undefined) title = found.title;
    if (version === undefined && kind !== "ticket" && found.version !== undefined) version = found.version;
  }

  const manifest = loadManifest(opts.runDir);
  const versionKey = version ?? "";
  const existing = manifest.sources.find((s) => sameIdentity(s, kind, opts.ref, versionKey, node ?? "", opts.env ?? ""));
  const maxN = manifest.sources.reduce((n, s) => Math.max(n, Number(s.id.slice(2))), 0);
  const id = existing?.id ?? `S-${maxN + 1}`;

  const entry: SourceEntry = { id, kind, ref: opts.ref, added_at: now.toISOString(), meta };
  if (version !== undefined) entry.version = version;
  if (title !== undefined) entry.title = title;

  if (bytes !== undefined) {
    const subdir = SUBDIR[kind] as string;
    let name = fileNameFor({ kind, ref: opts.ref, version, node, env: opts.env }, ext);
    const taken = (n: string): boolean => manifest.sources.some((s) => s.id !== id && s.path === `sources/${subdir}/${n}`);
    if (taken(name)) name = `${name.slice(0, name.length - extname(name).length)}-${id}${extname(name)}`;
    entry.path = `sources/${subdir}/${name}`;
    entry.sha256 = sha256Bytes(bytes);
    entry.bytes = bytes.length;
    const dest = join(opts.runDir, entry.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
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
  appendEvent(paths.events, "source_added", { id, kind, ref: opts.ref, version: version ?? null, replaced: existing !== undefined, unchanged, sha256: finalEntry.sha256 ?? null }, now);
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

export interface CallRow {
  n: number;
  tool: string | null;
  input: string;
  bytes: number;
  /** 같은 내용으로 이미 등록된 원천 id. 없으면 null. */
  registered: string | null;
  error?: string;
}

const INPUT_SUMMARY_LIMIT = 100;

const summarize = (input: unknown): string => {
  const text = JSON.stringify(input) ?? "";
  return text.length > INPUT_SUMMARY_LIMIT ? `${text.slice(0, INPUT_SUMMARY_LIMIT)}…` : text;
};

/** 가장 최근 수집 작업 폴더에 받아 적힌 호출 목록과, 이미 원천으로 등록됐는지. */
export function listCalls(runDir: string): { dir: string; calls: CallRow[] } {
  loadRun(runDir);
  const found = loadCalls(runDir);
  const sources = loadManifest(runDir).sources;
  const calls = found.calls.map<CallRow>((c) => ({
    n: c.n,
    tool: c.tool,
    input: summarize(c.input),
    bytes: c.bytes,
    registered: sources.find((s) => s.sha256 === c.sha256)?.id ?? null,
    ...(c.error === undefined ? {} : { error: c.error }),
  }));
  return { dir: found.callsDir, calls };
}

export interface FailSourceOptions {
  runDir: string;
  item: string;
  reason: string;
  now?: Date;
}

export interface FailSourceResult {
  item: string;
  reason: string;
  attempts: number;
  /** 실패가 상한에 닿아 계획에서 빠지는 경우 true. */
  dropped: boolean;
}

/** 계획 항목의 실패를 sources/failures.jsonl 에 덧붙인다. 상태는 바꾸지 않는다. */
export function failSource(opts: FailSourceOptions): FailSourceResult {
  const now = opts.now ?? new Date();
  loadRun(opts.runDir);
  if (opts.reason.trim().length === 0) throw usageError("--reason 이 비어 있습니다");
  if (!knownItemIds(opts.runDir).includes(opts.item)) {
    throw usageError(`계획에 없는 항목입니다: ${opts.item} (hew source plan 으로 항목 id 를 확인하세요)`);
  }
  appendFailure(opts.runDir, opts.item, opts.reason, now);
  const attempts = readFailures(opts.runDir).filter((f) => f.item === opts.item).length;
  appendEvent(runPaths(opts.runDir).events, "source_failed", { item: opts.item, reason: opts.reason, attempts }, now);
  return { item: opts.item, reason: opts.reason, attempts, dropped: attempts >= 2 };
}

export interface DoneResult {
  previous_state: RunState;
  state: RunState;
  revision: string;
  units: number;
  screens: number;
  /** 필수가 아닌 항목의 실패·건너뜀. run.json 의 collect_warnings 에도 남는다. */
  warnings: CollectWarning[];
}

const missing = (ref: string, message: string): Issue => ({ code: "source_missing", severity: "reject", ref, message });

const pending = (item: PlanItem): Issue => ({
  code: "source_pending",
  severity: "reject",
  ref: item.id,
  message: `계획에 아직 가져오지 않은 항목이 있습니다: ${item.what} — ${item.tool_hint}`,
});

/**
 * 필수 원천(입력에 따른 prd 또는 ticket, code)이 다 찼고 수집 계획에 가져올 항목이 남지 않았는지 확인한다. 모자라면 종료 3.
 * 필수가 아닌 항목의 실패(2회)와 건너뜀은 경고로 통과시키고 run.json 의 collect_warnings 에 남긴다.
 * 차면 단위·화면 목록을 만들고 init 일 때만 collected 로 간다.
 */
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

  const plan = computePlan(runDir, loadCollectConfig());
  const metaItems = [...plan.items.filter((i) => i.register.kind === "figma_meta" && i.skip !== true), ...plan.failed.filter((f) => f.id.startsWith("figma_meta:"))];
  const triedFigma = readFailures(runDir).some((f) => f.item.startsWith("figma_meta:"));
  const neverTriedFigma = count("figma_meta") === 0 && metaItems.length > 0 && !triedFigma;
  if (neverTriedFigma) {
    issues.push(missing("figma_meta", "PRD·티켓 본문에 Figma 링크가 있는데 Figma 메타데이터 원천이 없고 시도한 기록도 없습니다 (hew source add --kind figma_meta)"));
  }
  const reported = new Set(issues.map((i) => i.ref));
  for (const item of plan.items) {
    if (item.skip === true || (reported.has(item.register.kind) && count(item.register.kind) === 0)) continue;
    if (neverTriedFigma && item.register.kind === "figma_meta") continue;
    issues.push(pending(item));
  }
  if (issues.length > 0) {
    appendEvent(paths.events, "sources_incomplete", { missing: issues.map((i) => i.ref) }, now);
    throw rejectedError(`수집이 끝나지 않았습니다(${issues.length}건). 상태는 바뀌지 않았습니다`, issues);
  }

  const warnings: CollectWarning[] = [
    ...plan.failed.map<CollectWarning>((f) => ({ code: "item_failed", item: f.id, message: `${f.what}: ${f.attempts}회 실패(${f.reasons.join("; ")})` })),
    ...plan.items.filter((i) => i.skip === true).map<CollectWarning>((i) => ({ code: "item_skipped", item: i.id, message: `${i.what}: ${i.note ?? "건너뜀"}` })),
  ];

  const built = writeUnits(runDir);
  const revision = computeRevision(runDir);
  let state = run.state;
  let row: number | null = null;
  if (run.state === "init") {
    const result = transition(run.state, { type: "sources_complete" }, { rework: run.rework, progress: run.progress, open: run.open, revision });
    state = result.state;
    row = result.row;
  }
  const { collect_warnings: _previous, ...rest } = run;
  saveRun(runDir, { ...rest, ...(warnings.length > 0 ? { collect_warnings: warnings } : {}), state, revision }, now);
  const screens = built.units.units.filter((u) => u.kind === "figma_screen").length;
  appendEvent(paths.events, "sources_done", { from: run.state, to: state, row, revision, units: built.units.units.length, screens, warnings: warnings.length }, now);
  return { previous_state: run.state, state, revision, units: built.units.units.length, screens, warnings };
}
