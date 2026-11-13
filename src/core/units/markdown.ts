/** Markdown(GFM 표, 제목, 글머리표, 문단)를 문서 순서의 원문 단위로 쪼갠다. 모델을 쓰지 않는 결정적 코드. */
import { findActorColumn, judgeActor } from "./actor.js";
import type { DocLocator, RawDocUnit } from "./types.js";

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET_RE = /^(\s*)(?:[-*+•]|\d+[.)])\s+(.*)$/;
const RULE_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;
const DELIMITER_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const BR_RE = /<br\s*\/?>/gi;

const stripEmphasis = (s: string): string => s.replace(/\*\*|__/g, "").trim();
const isBold = (s: string): boolean => /^\*\*.+\*\*$/.test(s.trim()) || /^__.+__$/.test(s.trim());

/** 표 한 줄을 칸으로 나눈다. `\|` 는 칸 구분이 아니고, `<br>` 은 줄바꿈이 된다. */
export function splitTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").replace(BR_RE, "\n").trim());
}

const isTableStart = (line: string, next: string | undefined): boolean =>
  line.trim().startsWith("|") && next !== undefined && next.includes("-") && DELIMITER_RE.test(next);

/** 머리글 이름을 겹치지 않게 만든다. 빈 머리글은 `열N`. */
function columnKeys(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((header, i) => {
    const base = stripEmphasis(header) || `열${i + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

const textOfColumns = (columns: Record<string, string>): string =>
  Object.entries(columns)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

function tableUnits(rows: string[][], table: number, section: string[]): RawDocUnit[] {
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const attributeTable = header.length === 2 && isBold(header[0] ?? "");
  const units: RawDocUnit[] = [];
  const locator = (row: number): DocLocator => ({ section: [...section], table, row });

  if (attributeTable) {
    [header, ...body].forEach((cells, i) => {
      const name = stripEmphasis(cells[0] ?? "");
      const value = (cells[1] ?? "").trim();
      if (name.length === 0 || value.length === 0) return;
      const columns = { [name]: value };
      units.push({ kind: "table_row", locator: locator(i + 1), text: textOfColumns(columns), columns });
    });
    return units;
  }

  // 굵은 표시가 없는 2열 표는 속성 표인지 머리글이 있는 표인지 가릴 수 없어, 첫 행도 단위로 싣는다.
  const ambiguousTwoColumn = header.length === 2;
  if (ambiguousTwoColumn) {
    const name = stripEmphasis(header[0] ?? "");
    const value = (header[1] ?? "").trim();
    if (name.length > 0 && value.length > 0) {
      const columns = { [name]: value };
      units.push({ kind: "table_row", locator: locator(0), text: textOfColumns(columns), columns });
    }
  }

  const keys = columnKeys(header);
  const actorColumn = findActorColumn(header);
  body.forEach((cells, i) => {
    const columns: Record<string, string> = {};
    keys.forEach((key, c) => {
      const value = (cells[c] ?? "").trim();
      if (value.length > 0) columns[key] = value;
    });
    if (Object.keys(columns).length === 0) return;
    const unit: RawDocUnit = { kind: "table_row", locator: locator(i + 1), text: textOfColumns(columns), columns };
    if (actorColumn >= 0) {
      const raw = (cells[actorColumn] ?? "").trim();
      if (raw.length > 0) {
        unit.actor_raw = raw;
        const actor = judgeActor(raw);
        if (actor !== undefined) unit.actor = actor;
      }
    }
    units.push(unit);
  });
  return units;
}

/** Markdown 본문을 원문 단위로 쪼갠다. 제목은 단위가 아니라 locator.section 경로가 된다. */
export function parseMarkdownUnits(markdown: string): RawDocUnit[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const units: RawDocUnit[] = [];
  const headings: { level: number; title: string }[] = [];
  let tableCount = 0;
  let index = 0;
  let paragraph: string[] = [];
  let bullet: { indent: number; lines: string[] } | null = null;

  const section = (): string[] => headings.map((h) => h.title);
  const push = (kind: "bullet" | "paragraph", text: string): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    index += 1;
    units.push({ kind, locator: { section: section(), index }, text: trimmed });
  };
  const flush = (): void => {
    if (bullet) push("bullet", bullet.lines.join("\n"));
    if (paragraph.length > 0) push("paragraph", paragraph.join("\n"));
    bullet = null;
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    if (FENCE_RE.test(line)) {
      flush();
      const body: string[] = [];
      for (i += 1; i < lines.length && !FENCE_RE.test(lines[i] as string); i++) body.push(lines[i] as string);
      push("paragraph", body.join("\n"));
      continue;
    }
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    if (isTableStart(line, lines[i + 1])) {
      flush();
      const rows: string[][] = [splitTableRow(line)];
      for (i += 2; i < lines.length && (lines[i] as string).trim().startsWith("|"); i++) {
        rows.push(splitTableRow(lines[i] as string));
      }
      i -= 1;
      tableCount += 1;
      units.push(...tableUnits(rows, tableCount, section()));
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flush();
      const level = (heading[1] as string).length;
      while (headings.length > 0 && (headings[headings.length - 1] as { level: number }).level >= level) headings.pop();
      const title = stripEmphasis(heading[2] as string);
      headings.push({ level, title });
      index = 0;
      continue;
    }
    if (RULE_RE.test(line)) {
      flush();
      continue;
    }
    const item = BULLET_RE.exec(line);
    if (item) {
      flush();
      bullet = { indent: (item[1] as string).length, lines: [(item[2] as string).trim()] };
      continue;
    }
    if (bullet && /^\s+/.test(line) && (line.match(/^\s*/)?.[0].length ?? 0) > bullet.indent) {
      bullet.lines.push(line.trim());
      continue;
    }
    if (bullet) flush();
    paragraph.push(line.replace(/^\s*>\s?/, "").trim());
  }
  flush();
  return units;
}
