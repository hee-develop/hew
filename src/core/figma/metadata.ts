/** Figma MCP get_metadata 결과 원본을 줄 단위 정규식으로 노드 목록으로 읽는다. */

export interface FigmaNode {
  id: string;
  tag: string;
  name: string;
  /** 캔버스가 0. */
  depth: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** 자신이나 조상이 숨김이면 true. */
  hidden: boolean;
  parent: FigmaNode | null;
  children: FigmaNode[];
}

const LINE_RE = /^( *)<([\w-]+)\s+id="([^"]*)"(?:\s+name="([\s\S]*?)")?((?:\s+[\w-]+="[^"]*")*)\s*\/?>\s*$/;
const ATTR_RE = /([\w-]+)="([^"]*)"/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

const unescapeXml = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const cleanName = (s: string): string => unescapeXml(s).replace(CONTROL_RE, "").trim();

const toNumber = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** 원본(JSON 배열·문자열·객체)에서 `<canvas` 로 시작하는 text 를 모두 찾는다. 배열 안의 자리는 가정하지 않는다. */
export function findCanvasTexts(raw: unknown): string[] {
  const texts: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.trimStart().startsWith("<canvas")) texts.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value !== null && typeof value === "object") {
      visit((value as { text?: unknown }).text);
    }
  };
  visit(raw);
  return texts;
}

/** 파일 내용을 JSON 으로 읽어 보고 안 되면 글 그대로 보고, `<canvas` 텍스트들을 돌려준다. */
export function canvasTextsFromFile(content: string): string[] {
  try {
    return findCanvasTexts(JSON.parse(content));
  } catch {
    return findCanvasTexts(content);
  }
}

/** 메타데이터 텍스트 하나를 문서 순서의 노드 목록으로 읽는다(들여쓰기 2칸 = 깊이 1). 태그 줄이 아닌 줄은 건너뛴다. */
export function parseMetadataText(text: string): FigmaNode[] {
  const nodes: FigmaNode[] = [];
  const stack: FigmaNode[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0 || /^\s*<\//.test(line)) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const depth = (m[1] ?? "").length / 2;
    const attrs: Record<string, string> = {};
    ATTR_RE.lastIndex = 0;
    for (let a = ATTR_RE.exec(m[5] ?? ""); a; a = ATTR_RE.exec(m[5] ?? "")) attrs[a[1] as string] = a[2] as string;
    while (stack.length > depth) stack.pop();
    const parent = stack[stack.length - 1] ?? null;
    const node: FigmaNode = {
      id: m[3] as string,
      tag: m[2] as string,
      name: cleanName(m[4] ?? ""),
      depth,
      hidden: attrs.hidden === "true" || (parent?.hidden ?? false),
      parent,
      children: [],
    };
    const x = toNumber(attrs.x);
    const y = toNumber(attrs.y);
    const w = toNumber(attrs.width);
    const h = toNumber(attrs.height);
    if (x !== undefined) node.x = x;
    if (y !== undefined) node.y = y;
    if (w !== undefined) node.w = w;
    if (h !== undefined) node.h = h;
    parent?.children.push(node);
    nodes.push(node);
    stack.push(node);
  }
  return nodes;
}
