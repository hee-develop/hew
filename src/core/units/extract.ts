/** 도구 결과 원본(JSON)에서 Markdown 본문과 제목·버전을 꺼낸다. */

const BODY_KEYS = ["body", "description", "content", "markdown", "text", "value", "fields"] as const;
const MAX_DEPTH = 8;

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

function parseJson(value: string): unknown {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Atlassian 문서 형식(ADF)에서 글자만 문단 단위로 모은다. */
function adfToText(node: unknown, depth = 0): string {
  if (depth > MAX_DEPTH * 3 || !isRec(node)) return "";
  if (typeof node.text === "string") return node.text;
  if (node.type === "hardBreak") return "\n";
  const children = Array.isArray(node.content) ? node.content : [];
  const parts = children.map((c) => adfToText(c, depth + 1));
  const block = ["paragraph", "heading", "listItem", "tableRow", "codeBlock", "blockquote"].includes(String(node.type));
  return block ? `${parts.join("")}\n` : parts.join("");
}

function extractValue(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) return "";
  if (typeof value === "string") {
    const parsed = parseJson(value);
    return parsed === undefined ? value : extractValue(parsed, depth + 1);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => extractValue(item, depth + 1))
      .filter((s) => s.trim().length > 0)
      .join("\n\n");
  }
  if (isRec(value)) {
    if (value.type === "doc" && Array.isArray(value.content)) return adfToText(value).trim();
    for (const key of BODY_KEYS) {
      if (value[key] === undefined || value[key] === null) continue;
      const found = extractValue(value[key], depth + 1);
      if (found.trim().length > 0) return found;
    }
  }
  return "";
}

/** 문자열이면 JSON 으로 한 번 더 풀어 본다. */
function unwrap(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const parsed = parseJson(value);
  return parsed === undefined ? value : unwrap(parsed);
}

/** Confluence 응답에서 페이지 객체를 찾는다(`content.nodes[0]`, `nodes[0]`, `results[0]`, 또는 본문이 든 객체 자신). */
function confluenceNode(root: unknown): Rec | undefined {
  const obj = unwrap(root);
  if (!isRec(obj)) return undefined;
  const content = unwrap(obj.content);
  const lists = [isRec(content) ? content.nodes : undefined, obj.nodes, obj.results, isRec(content) ? content.results : undefined];
  for (const list of lists) {
    const first = Array.isArray(list) ? list[0] : undefined;
    if (isRec(first) && first.body !== undefined) return first;
  }
  if (obj.body !== undefined && (obj.title !== undefined || obj.id !== undefined)) return obj;
  return undefined;
}

/** Jira 이슈 객체를 찾는다(`fields` 가 있는 객체, 한 겹 감싼 `issue`·`content`). */
function jiraIssue(root: unknown): Rec | undefined {
  const obj = unwrap(root);
  if (!isRec(obj)) return undefined;
  for (const candidate of [obj, unwrap(obj.issue), unwrap(obj.content)]) {
    if (isRec(candidate) && (isRec(candidate.fields) || isRec(candidate.renderedFields))) return candidate;
  }
  return undefined;
}

const textOf = (value: unknown): string => (nonEmpty(value) ? value : isRec(value) ? extractValue(value, 0) : "");

function jiraDescription(issue: Rec): string {
  const fields = isRec(issue.fields) ? issue.fields : {};
  const rendered = isRec(issue.renderedFields) ? issue.renderedFields : {};
  for (const candidate of [fields.description, rendered.description, issue.description]) {
    const found = textOf(candidate);
    if (found.trim().length > 0) return found;
  }
  return "";
}

/** 응답 JSON 에서 Markdown 본문을 꺼낸다. 알려진 모양(Confluence, Jira)을 먼저 보고 안 되면 본문 같은 칸을 찾는다. */
export function bodyFromResponse(parsed: unknown): string {
  const page = confluenceNode(parsed);
  if (page !== undefined) {
    const body = textOf(page.body);
    if (body.trim().length > 0) return body;
  }
  const issue = jiraIssue(parsed);
  if (issue !== undefined) {
    const description = jiraDescription(issue);
    const fields = isRec(issue.fields) ? issue.fields : {};
    const summary = nonEmpty(fields.summary) ? fields.summary.trim() : "";
    if (description.trim().length > 0) return summary.length > 0 ? `# ${summary}\n\n${description}` : description;
  }
  return extractValue(parsed, 0);
}

export interface ResponseMeta {
  title?: string;
  version?: string;
}

const versionText = (v: unknown): string | undefined => {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return String(v);
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return v.trim();
  if (isRec(v)) return versionText(v.number);
  return undefined;
};

/** 응답 JSON 에서 제목과 버전 번호를 찾는다. 없으면 비운다. */
export function metaFromResponse(parsed: unknown): ResponseMeta {
  const out: ResponseMeta = {};
  const page = confluenceNode(parsed);
  if (page !== undefined) {
    if (nonEmpty(page.title)) out.title = page.title.trim();
    const version = versionText(page.version) ?? versionText(page.versionNumber);
    if (version !== undefined) out.version = version;
    return out;
  }
  const issue = jiraIssue(parsed);
  const fields = issue !== undefined && isRec(issue.fields) ? issue.fields : undefined;
  if (fields !== undefined && nonEmpty(fields.summary)) out.title = fields.summary.trim();
  return out;
}

/** 원천 파일 내용을 JSON 으로 읽는다. JSON 이 아니면 undefined. */
export function parseSourceJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

/** 원천 파일 내용에서 파싱할 Markdown 을 정한다. .json 이 아니면 내용 그대로, .json 이면 그 안의 본문. */
export function markdownFromSource(content: string, fileName: string): string {
  if (!fileName.toLowerCase().endsWith(".json")) return content;
  const parsed = parseSourceJson(content);
  if (parsed === undefined) return content;
  return bodyFromResponse(parsed);
}
