/** Figma 메타데이터에서 화면 목록(inventory)을 만든다: 프레임, 플랫폼, 좌표, AS-IS·TO-BE 짝, 설명 카드. */
import { canvasTextsFromFile, parseMetadataText, type FigmaNode } from "./metadata.js";

export const PLATFORMS = ["app", "mobile_web", "web", "unknown"] as const;
export type Platform = (typeof PLATFORMS)[number];
export type Role = "as_is" | "to_be";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface InventoryFrame {
  node_id: string;
  name: string;
  type: string;
  platform: Platform;
  role?: Role;
  box?: Box;
  section?: string;
  pair?: string;
  is_desc: boolean;
  /** 설명 카드일 때 카드 아래 텍스트 노드 이름을 줄바꿈으로 이은 것. */
  text?: string;
}

export interface InventoryFile {
  source_id: string;
  file_key?: string;
  canvases: { node_id: string; name: string }[];
  frames: InventoryFrame[];
}

export interface Inventory {
  files: InventoryFile[];
}

const PLATFORM_PREFIXES: [RegExp, Platform][] = [
  [/^(?:모웹|mweb|mobile web)[/_]/i, "mobile_web"],
  [/^(?:앱|app)[/_]/i, "app"],
  [/^(?:웹|web)[/_]/i, "web"],
];

/** 프레임 이름의 접두사로 플랫폼을 가른다. 접두사가 없으면 unknown. */
export function platformOf(name: string): Platform {
  const trimmed = name.trim();
  for (const [re, platform] of PLATFORM_PREFIXES) if (re.test(trimmed)) return platform;
  return "unknown";
}

const LABEL_RE = /asis_tobe_label/i;
const DESC_CARD_RE = /description_unit_card|^desc(?![a-z])/i;
const FRAME_LIKE_TAGS = new Set(["frame", "component", "component-set", "instance"]);
const LABEL_DY_MIN = 40;
const LABEL_DY_MAX = 120;
const LABEL_DX_TOLERANCE = 2;
const ROW_DY_TOLERANCE = 4;

const hasBox = (n: FigmaNode): n is FigmaNode & Box & { x: number; y: number; w: number; h: number } =>
  n.x !== undefined && n.y !== undefined && n.w !== undefined && n.h !== undefined;

function descendants(node: FigmaNode): FigmaNode[] {
  const out: FigmaNode[] = [];
  const walk = (n: FigmaNode): void => {
    for (const child of n.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

const hasDescCardAncestor = (node: FigmaNode, cards: Set<FigmaNode>): boolean => {
  for (let cur = node.parent; cur; cur = cur.parent) if (cards.has(cur)) return true;
  return false;
};

/** 설명 카드 노드를 찾는다. `description_unit_card` 이거나, 그 카드를 품지 않은 `desc` 노드. 카드 안의 노드는 다시 카드로 치지 않는다. */
function findDescCards(nodes: FigmaNode[]): Set<FigmaNode> {
  const cards = new Set<FigmaNode>();
  for (const node of nodes) {
    if (node.hidden || !DESC_CARD_RE.test(node.name) || hasDescCardAncestor(node, cards)) continue;
    const isUnitCard = /description_unit_card/i.test(node.name);
    const containsUnitCard = descendants(node).some((d) => /description_unit_card/i.test(d.name));
    if (isUnitCard || !containsUnitCard) cards.add(node);
  }
  return cards;
}

const textOfCard = (card: FigmaNode): string =>
  descendants(card)
    .filter((d) => d.tag === "text" && !d.hidden && d.name.length > 0)
    .map((d) => d.name)
    .join("\n");

const sectionOf = (node: FigmaNode): string | undefined => {
  for (let cur = node.parent; cur; cur = cur.parent) if (cur.tag === "section") return cur.name;
  return undefined;
};

/** 라벨 노드의 이름과 아래 텍스트에서 as-is·to-be 를 읽는다. 둘 다 있거나 둘 다 없으면 undefined. */
export function roleFromLabel(label: FigmaNode): Role | undefined {
  const text = [label.name.replace(LABEL_RE, ""), ...descendants(label).map((d) => d.name)].join(" ");
  const asIs = /as[\s_-]?is/i.test(text);
  const toBe = /to[\s_-]?be/i.test(text);
  if (asIs === toBe) return undefined;
  return asIs ? "as_is" : "to_be";
}

const isDescArea = (node: FigmaNode): boolean => {
  for (let cur: FigmaNode | null = node; cur; cur = cur.parent) if (DESC_CARD_RE.test(cur.name)) return true;
  return false;
};

function isScreenCandidate(node: FigmaNode): boolean {
  if (!FRAME_LIKE_TAGS.has(node.tag) || LABEL_RE.test(node.name) || node.name.toLowerCase() === "platform") return false;
  if (isDescArea(node)) return false;
  const named = platformOf(node.name) !== "unknown";
  return (node.tag === "frame" && node.depth >= 2 && node.depth <= 3) || (named && node.depth >= 1);
}

/** 라벨이 대상 프레임과 같은 부모에서 같은 x, 약 80px 위쪽 y 에 놓인 것을 찾아 role 을 붙이고, 나란한 as-is·to-be 를 pair 로 잇는다. */
function assignRolesAndPairs(frames: { node: FigmaNode; frame: InventoryFrame }[], labels: FigmaNode[]): void {
  for (const label of labels) {
    if (label.hidden || !hasBox(label)) continue;
    const role = roleFromLabel(label);
    if (role === undefined) continue;
    let best: { frame: InventoryFrame; dy: number } | undefined;
    for (const { node, frame } of frames) {
      if (frame.is_desc || node.parent !== label.parent || !hasBox(node)) continue;
      const dy = node.y - label.y;
      if (Math.abs(node.x - label.x) > LABEL_DX_TOLERANCE || dy < LABEL_DY_MIN || dy > LABEL_DY_MAX) continue;
      if (best === undefined || Math.abs(dy - 80) < Math.abs(best.dy - 80)) best = { frame, dy };
    }
    if (best !== undefined && best.frame.role === undefined) best.frame.role = role;
  }
  const paired = new Set<string>();
  for (const a of frames) {
    if (a.frame.role !== "as_is" || paired.has(a.frame.node_id) || !hasBox(a.node)) continue;
    let best: { other: (typeof frames)[number]; dx: number } | undefined;
    for (const b of frames) {
      if (b.frame.role !== "to_be" || paired.has(b.frame.node_id) || b.node.parent !== a.node.parent || !hasBox(b.node)) continue;
      const dx = b.node.x - a.node.x;
      if (dx <= 0 || Math.abs(b.node.y - a.node.y) > ROW_DY_TOLERANCE) continue;
      if (best === undefined || dx < best.dx) best = { other: b, dx };
    }
    if (best === undefined) continue;
    a.frame.pair = best.other.frame.node_id;
    best.other.frame.pair = a.frame.node_id;
    paired.add(a.frame.node_id);
    paired.add(best.other.frame.node_id);
  }
}

/** 메타데이터 노드 목록에서 프레임 목록과 짝을 만든다. 설명 카드 안쪽 노드는 프레임으로 싣지 않는다. */
export function framesFromNodes(nodes: FigmaNode[]): InventoryFrame[] {
  const cards = findDescCards(nodes);
  const entries: { node: FigmaNode; frame: InventoryFrame }[] = [];
  for (const node of nodes) {
    if (node.hidden || hasDescCardAncestor(node, cards)) continue;
    const isDesc = cards.has(node);
    if (!isDesc && !isScreenCandidate(node)) continue;
    const frame: InventoryFrame = {
      node_id: node.id,
      name: node.name,
      type: node.tag,
      platform: platformOf(node.name),
      is_desc: isDesc,
    };
    if (hasBox(node)) frame.box = { x: node.x, y: node.y, w: node.w, h: node.h };
    const section = sectionOf(node);
    if (section !== undefined) frame.section = section;
    if (isDesc) frame.text = textOfCard(node);
    entries.push({ node, frame });
  }
  assignRolesAndPairs(entries, nodes.filter((n) => LABEL_RE.test(n.name)));
  return entries.map((e) => e.frame);
}

/** figma_meta 원천 파일 내용 하나로 inventory 의 파일 항목을 만든다. */
export function inventoryFileFromContent(sourceId: string, fileKey: string | undefined, content: string): InventoryFile {
  const nodes = canvasTextsFromFile(content).flatMap((text) => parseMetadataText(text));
  const file: InventoryFile = {
    source_id: sourceId,
    canvases: nodes.filter((n) => n.depth === 0 && n.tag === "canvas").map((n) => ({ node_id: n.id, name: n.name })),
    frames: framesFromNodes(nodes),
  };
  if (fileKey !== undefined) file.file_key = fileKey;
  return file;
}
