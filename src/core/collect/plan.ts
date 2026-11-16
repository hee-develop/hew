/** 수집 계획: run.json·manifest·실패 기록에서 다음에 가져올 항목을 결정적으로 계산한다. 아무것도 바꾸지 않는다. */
import { loadManifest, sortedSources, type SourceEntry, type SourceKind } from "../manifest.js";
import { inventoryFileFromContent, type InventoryFrame } from "../figma/inventory.js";
import { normalizeNodeId, parseNodeRef } from "../figma/node-ref.js";
import { loadRun, type Run } from "../run.js";
import { fileKeyOf, sourceMarkdown } from "../units/index.js";
import { parseSourceJson } from "../units/extract.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProfile } from "../profile.js";
import { loadCollectConfig, type CollectConfig } from "./config.js";
import { MAX_FAILURES, readFailures } from "./failures.js";

export interface PlanRegister {
  kind: SourceKind;
  ref: string;
  version?: string;
  node?: string;
  title?: string;
}

export interface PlanItem {
  id: string;
  what: string;
  tool_hint: string;
  register: PlanRegister;
  note?: string;
  /** true 이면 가져오지 않고 건너뛰는 항목(계획이 비었는지 볼 때 세지 않는다). */
  skip?: true;
}

export interface FailedItem {
  id: string;
  what: string;
  attempts: number;
  reasons: string[];
}

export interface CollectPlan {
  run_id: string;
  items: PlanItem[];
  failed: FailedItem[];
  blocked: string[];
  /** 건너뛰는 항목과 상한 안내처럼 가져올 일이 아닌 안내. */
  notes: string[];
  /** 가져와야 하는 항목 수(skip·failed 제외). */
  remaining: number;
}

const JIRA_KEY = /[A-Z][A-Z0-9]+-\d+/;
const FIGMA_URL = /https?:\/\/[^\s)\]>"'<]*figma\.com\/[^\s)\]>"'<]*/gi;
const FIGMA_FILE = /figma\.com\/(?:design|file|board)\//i;
const ANY_URL = /https?:\/\/[^\s)\]>"'<]+/g;
/** 이름만 보고 앱 화면이 아닌 것으로 보는 말(라벨이 붙어 있어도 캡처하지 않는다). */
const NOT_APP_NAME = /웹|web|\bpc\b|desktop|데스크|admin|어드민|backoffice|대시보드/i;

/** URL 에서 Confluence 페이지 id 를 뽑는다(`pageId=` 쿼리 또는 `/pages/<id>/`). */
export function pageIdFromUrl(url: string): string | undefined {
  return /[?&]pageId=(\d+)/.exec(url)?.[1] ?? /\/pages\/(\d+)/.exec(url)?.[1];
}

/** URL 에서 Jira 이슈 키를 뽑는다(`/browse/<키>`, `selectedIssue=<키>`, 그 밖은 처음 보이는 키). */
export function jiraKeyFromUrl(url: string): string | undefined {
  return new RegExp(`/browse/(${JIRA_KEY.source})`).exec(url)?.[1] ?? new RegExp(`selectedIssue=(${JIRA_KEY.source})`).exec(url)?.[1] ?? JIRA_KEY.exec(url)?.[0];
}

const dashNode = (node: string): string => node.replace(":", "-");

interface FigmaLink {
  key: string;
  node?: string;
}

/** 본문에서 Figma 파일 링크(design·file·board)를 문서 순서로 모은다. 같은 (파일, 노드)는 한 번만. */
export function figmaLinks(markdown: string): FigmaLink[] {
  const out: FigmaLink[] = [];
  const seen = new Set<string>();
  for (const url of markdown.match(FIGMA_URL) ?? []) {
    if (!FIGMA_FILE.test(url)) continue;
    const ref = parseNodeRef(url);
    const key = ref?.key ?? parseKeyOnly(url);
    if (key === undefined) continue;
    const id = `${key}:${ref?.node ?? ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ key, ...(ref?.node === undefined ? {} : { node: ref.node }) });
  }
  return out;
}

function parseKeyOnly(url: string): string | undefined {
  return /figma\.com\/(?:design|file|board)\/(?:[^/?#\s]+\/branch\/)?([0-9A-Za-z]{22,128})(?=[/?#]|$)/i.exec(url)?.[1];
}

function readText(runDir: string, source: SourceEntry): string | undefined {
  if (source.path === undefined || !existsSync(join(runDir, source.path))) return undefined;
  try {
    return sourceMarkdown(runDir, source);
  } catch {
    return undefined;
  }
}

/** 티켓 원천 파일에서 상위 이슈 키(parent)를 찾는다. */
function parentKeyOf(runDir: string, source: SourceEntry): string | undefined {
  if (source.path === undefined || !existsSync(join(runDir, source.path))) return undefined;
  const raw = readFileSync(join(runDir, source.path), "utf8");
  const parsed = parseSourceJson(raw);
  const find = (value: unknown, depth: number): string | undefined => {
    if (depth > 4 || value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const rec = value as Record<string, unknown>;
    const parent = rec.parent;
    if (parent !== null && typeof parent === "object" && !Array.isArray(parent)) {
      const key = (parent as Record<string, unknown>).key;
      if (typeof key === "string" && new RegExp(`^${JIRA_KEY.source}$`).test(key)) return key;
    }
    for (const child of [rec.fields, rec.issue, rec.content]) {
      const found = typeof child === "string" ? find(parseSourceJson(child), depth + 1) : find(child, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const fromJson = find(typeof parsed === "string" ? parseSourceJson(parsed) : parsed, 0);
  if (fromJson !== undefined) return fromJson;
  return new RegExp(`"parent"\\s*:\\s*\\{[^{}]*?"key"\\s*:\\s*"(${JIRA_KEY.source})"`).exec(raw)?.[1];
}

const sameKey = (a: string | undefined, b: string): boolean => a !== undefined && a.toLowerCase() === b.toLowerCase();

/** figma_meta 원천이 이미 가리키는 (파일 키, 노드). */
function metaTarget(s: SourceEntry): { key?: string; node?: string } {
  const key = fileKeyOf(s);
  const dash = /:(\d{1,7})-(\d{1,7})$/.exec(s.ref);
  const node =
    typeof s.meta.node === "string" ? normalizeNodeId(s.meta.node) : parseNodeRef(s.ref)?.node ?? (dash === null ? undefined : `${dash[1]}:${dash[2]}`);
  return { ...(key === undefined ? {} : { key }), ...(node === undefined ? {} : { node }) };
}

/** 캡처 대상: 앱 프레임, 그리고 앱 화면처럼 보이는 이름의 접두사 없는 프레임 중 AS-IS/TO-BE 라벨이 붙은 것. 앱 프레임이 먼저. */
export function captureTargets(frames: InventoryFrame[]): InventoryFrame[] {
  const app = frames.filter((f) => !f.is_desc && f.platform === "app");
  const labeled = frames.filter((f) => !f.is_desc && f.platform === "unknown" && f.labeled === true && !NOT_APP_NAME.test(f.name));
  return [...app, ...labeled];
}

/** 지금 상태에서 가져올 수 있는 모든 항목(실패한 것 포함)을 문서 순서로 계산한다. */
function candidates(runDir: string, run: Run, config: CollectConfig, blocked: string[], notes: string[]): PlanItem[] {
  const sources = sortedSources(loadManifest(runDir));
  const of = (kind: SourceKind): SourceEntry[] => sources.filter((s) => s.kind === kind);
  const items: PlanItem[] = [];
  const cloud = loadProfile().connections.atlassian_cloud_id;
  const blockedJira = new Set((run.case_info?.block.jira_keys ?? []).map((k) => k.toUpperCase()));

  const confluenceHint = (id: string, version?: string): string =>
    version === undefined
      ? `getConfluencePage(cloudId=${cloud}, pageId=${id}, contentFormat=markdown)`
      : `executeRead(name=getConfluenceContentVersion, cloudId=${cloud}, inputs={contentId: ${id}, versionNumber: ${version}, content_format: markdown}) — responseFields 를 주지 않는다`;
  const jiraHint = (key: string): string => `getJiraIssue(cloudId=${cloud}, issueIdOrKey=${key})`;

  // 입력
  let inputTicket: SourceEntry | undefined;
  if (run.input.kind === "prd") {
    const pageId = pageIdFromUrl(run.input.url);
    if (pageId === undefined) {
      if (of("prd").length === 0) blocked.push(`PRD URL 에서 페이지 id 를 알 수 없습니다: ${run.input.url}`);
    } else if (of("prd").length === 0) {
      const version = run.case_info?.prd_version;
      items.push({
        id: `prd:${pageId}`,
        what: `Confluence PRD 페이지 ${pageId}${version === undefined ? "" : ` 의 버전 ${version}`}`,
        tool_hint: confluenceHint(pageId, version),
        register: { kind: "prd", ref: pageId, ...(version === undefined ? {} : { version }) },
        ...(version === undefined ? {} : { note: "지정 버전만. 현재 버전으로 대신하지 않는다" }),
      });
    }
  } else {
    const key = jiraKeyFromUrl(run.input.url);
    if (key === undefined) {
      if (of("ticket").length === 0) blocked.push(`티켓 URL 에서 이슈 키를 알 수 없습니다: ${run.input.url}`);
    } else {
      inputTicket = of("ticket").find((s) => sameKey(s.ref, key));
      if (inputTicket === undefined) {
        items.push({ id: `ticket:${key}`, what: `Jira 이슈 ${key}`, tool_hint: jiraHint(key), register: { kind: "ticket", ref: key } });
      }
    }
  }
  // 상위 이슈(1단계만)
  if (inputTicket !== undefined) {
    const parent = parentKeyOf(runDir, inputTicket);
    if (parent !== undefined && !of("ticket").some((s) => sameKey(s.ref, parent))) {
      if (blockedJira.has(parent.toUpperCase())) {
        blocked.push(`상위 이슈 ${parent} 는 차단 목록에 있어 가져오지 않습니다`);
      } else {
        items.push({ id: `ticket:${parent}`, what: `상위 이슈 ${parent}`, tool_hint: jiraHint(parent), register: { kind: "ticket", ref: parent } });
      }
    }
  }

  // Figma 메타데이터(등록된 PRD·티켓 본문의 링크)
  const docs = [...of("prd"), ...of("ticket")];
  const links: FigmaLink[] = [];
  for (const doc of docs) {
    const text = readText(runDir, doc);
    if (text !== undefined) links.push(...figmaLinks(text));
  }
  // 실행을 만들 때 직접 지정한 시안 링크
  links.push(...figmaLinks((run.input.figma ?? []).join("\n")));
  const registeredMeta = of("figma_meta").map(metaTarget);
  const seenLinks = new Set<string>();
  const nodeKeys = new Set(links.filter((l) => l.node !== undefined).map((l) => l.key));
  for (const link of links) {
    const id = `${link.key}:${link.node ?? ""}`;
    if (seenLinks.has(id)) continue;
    seenLinks.add(id);
    if (link.node === undefined) {
      if (nodeKeys.has(link.key)) continue;
      items.push({
        id: `figma_meta:${link.key}`,
        what: `Figma 파일 ${link.key} (노드 지정 없음)`,
        tool_hint: "건너뜀",
        register: { kind: "figma_meta", ref: link.key },
        note: "노드 지정 없음",
        skip: true,
      });
      continue;
    }
    if (registeredMeta.some((m) => m.key === link.key && m.node === link.node)) continue;
    items.push({
      id: `figma_meta:${link.key}:${dashNode(link.node)}`,
      what: `Figma 메타데이터 ${link.key} 노드 ${link.node}`,
      tool_hint: "ToolSearch 로 get_metadata 를 찾아 get_metadata(fileKey, nodeId) 를 한 번 부른다",
      register: { kind: "figma_meta", ref: `${link.key}:${dashNode(link.node)}`, node: link.node },
    });
  }

  // 스크린샷(등록된 메타데이터의 캡처 대상)
  const shots = of("figma_shot");
  const targets: { key: string; frame: InventoryFrame }[] = [];
  for (const meta of of("figma_meta")) {
    const key = fileKeyOf(meta);
    const text = meta.path !== undefined && existsSync(join(runDir, meta.path)) ? readFileSync(join(runDir, meta.path), "utf8") : undefined;
    if (text === undefined) continue;
    if (key === undefined) {
      blocked.push(`figma_meta ${meta.id} 의 파일 키를 알 수 없어 스크린샷 대상을 정하지 못합니다`);
      continue;
    }
    let frames: InventoryFrame[];
    try {
      frames = inventoryFileFromContent(meta.id, key, text).frames;
    } catch {
      blocked.push(`figma_meta ${meta.id} 를 읽지 못해 스크린샷 대상을 정하지 못합니다`);
      continue;
    }
    for (const frame of captureTargets(frames)) {
      if (!targets.some((t) => t.key === key && t.frame.node_id === frame.node_id)) targets.push({ key, frame });
    }
  }
  const kept = targets.slice(0, config.max_shots);
  const shotItems: PlanItem[] = [];
  for (const { key, frame } of kept) {
    if (shots.some((s) => s.ref === key && s.meta.node === frame.node_id)) continue;
    shotItems.push({
      id: `figma_shot:${key}:${dashNode(frame.node_id)}`,
      what: `Figma 스크린샷 ${frame.name} (노드 ${frame.node_id})`,
      tool_hint: "ToolSearch 로 get_screenshot 을 찾아 get_screenshot(fileKey, nodeId, maxDimension) 을 부르고, 받은 주소를 curl 로 작업 폴더에 내려받는다",
      register: { kind: "figma_shot", ref: key, node: frame.node_id, title: frame.name },
    });
  }
  if (targets.length > kept.length) {
    const message = `스크린샷 대상 ${targets.length}개 중 상한(${config.max_shots})까지만 싣고 ${targets.length - kept.length}개를 뺐습니다(앱 프레임 우선)`;
    notes.push(message);
    const first = shotItems[0];
    if (first !== undefined) first.note = message;
  }
  items.push(...shotItems);

  // 관련 문서(등록된 PRD 본문의 같은 사이트 Confluence 링크)
  const siteHost = new URL(run.input.url).host;
  const own = new Set<string>([...of("prd").map((s) => s.ref), ...(pageIdFromUrl(run.input.url) === undefined ? [] : [pageIdFromUrl(run.input.url) as string])]);
  const relatedRegistered = new Set(of("related").map((s) => s.ref));
  const relatedIds: string[] = [];
  for (const prd of of("prd")) {
    const text = readText(runDir, prd);
    if (text === undefined) continue;
    for (const url of text.match(ANY_URL) ?? []) {
      let host = "";
      try {
        host = new URL(url).host;
      } catch {
        continue;
      }
      const id = host === siteHost && url.includes("/wiki/") ? pageIdFromUrl(url) : undefined;
      if (id !== undefined && !own.has(id) && !relatedIds.includes(id)) relatedIds.push(id);
    }
  }
  const relatedKept = relatedIds.slice(0, config.max_related);
  const relatedItems = relatedKept
    .filter((id) => !relatedRegistered.has(id))
    .map<PlanItem>((id) => ({
      id: `related:${id}`,
      what: `관련 Confluence 문서 ${id}`,
      tool_hint: confluenceHint(id),
      register: { kind: "related", ref: id },
    }));
  if (relatedIds.length > relatedKept.length) {
    const message = `관련 문서 ${relatedIds.length}개 중 상한(${config.max_related})까지만 싣고 ${relatedIds.length - relatedKept.length}개를 뺐습니다`;
    notes.push(message);
    const first = relatedItems[0];
    if (first !== undefined) first.note = message;
  }
  items.push(...relatedItems);

  if (of("code").length === 0) blocked.push("대상 저장소가 지정되지 않음(code 원천 없음. hew init --repo 로 지정한다)");
  return items;
}

/** 수집 계획을 계산한다. 2회 이상 실패한 항목은 failed 로 빼고, 나머지가 items 다. */
export function computePlan(runDir: string, config: CollectConfig = loadCollectConfig()): CollectPlan {
  const run = loadRun(runDir);
  const blocked: string[] = [];
  const notes: string[] = [];
  const all = candidates(runDir, run, config, blocked, notes);
  const failures = readFailures(runDir);
  const failed: FailedItem[] = [];
  const items: PlanItem[] = [];
  for (const item of all) {
    const mine = failures.filter((f) => f.item === item.id);
    if (!item.skip && mine.length >= MAX_FAILURES) failed.push({ id: item.id, what: item.what, attempts: mine.length, reasons: mine.map((f) => f.reason) });
    else items.push(item);
  }
  return { run_id: run.run_id, items, failed, blocked, notes, remaining: items.filter((i) => i.skip !== true).length };
}

/** 계획 항목 id 로 후보(실패한 것 포함)를 찾는다. */
export function knownItemIds(runDir: string, config?: CollectConfig): string[] {
  const plan = computePlan(runDir, config);
  return [...plan.items.map((i) => i.id), ...plan.failed.map((f) => f.id)];
}
