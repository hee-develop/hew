/** Figma 노드 참조(`a:b`, `<파일 키>:a:b`, `a-b`, figma.com 주소)를 노드 id `a:b` 로 읽는다. */
export interface NodeRef {
  /** 참조에 파일 키가 들어 있으면 그 키. */
  key?: string;
  /** 노드 id `a:b`. */
  node: string;
}

const FILE_KEY = /^[0-9A-Za-z]{22,128}$/;
const FRAME_REF = /\b([0-9A-Za-z]{22,128}):(\d{1,7}):(\d{1,7})(?!\d)|\b(\d{1,7}):(\d{1,7})\b/;
const FRAME_URL = /figma\.com\/(?:design|file|board|make)\/(?:[^/?#\s]+\/branch\/)?([0-9A-Za-z]{22,128})(?=[/?#]|$)/;
const FRAME_URL_NODE = /[?&]node-id=(\d{1,7})(?:-|:|%3A)(\d{1,7})(?!\d)/i;
const DASH_REF = /^(\d{1,7})-(\d{1,7})$/;

/** 노드 참조 값 하나를 읽는다. 읽을 수 없으면 undefined. */
export function parseNodeRef(value: string): NodeRef | undefined {
  const urlNode = /figma\.com\//i.test(value) ? FRAME_URL_NODE.exec(value) : null;
  if (urlNode) {
    const key = FRAME_URL.exec(value)?.[1];
    return { ...(key === undefined ? {} : { key }), node: `${urlNode[1]}:${urlNode[2]}` };
  }
  const dash = DASH_REF.exec(value.trim());
  if (dash) return { node: `${dash[1]}:${dash[2]}` };
  const m = FRAME_REF.exec(value);
  if (!m) return undefined;
  if (m[1] !== undefined) return { key: m[1], node: `${m[2]}:${m[3]}` };
  return { node: `${m[4]}:${m[5]}` };
}

/** 노드 참조에서 노드 id `a:b` 만 꺼낸다. 읽을 수 없으면 undefined. */
export function normalizeNodeId(value: string): string | undefined {
  return parseNodeRef(value)?.node;
}

/** 값이 Figma 파일 키 형식이면 그 값을, 아니면 undefined. */
export function asFileKey(value: string): string | undefined {
  return FILE_KEY.test(value) ? value : undefined;
}
