#!/usr/bin/env node
// Markdown 문서를 로컬에서 여는 독립 HTML 한 장으로 바꾼다. 같은 입력은 항상 같은 출력이다.
// 사용: node scripts/md-page.mjs <입력.md> [출력.html]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(HERE, "md-page.template.html");

const KINDS = ["결정", "가정", "제안", "미결", "사실"];
const KIND_CLASS = { 결정: "c-d", 가정: "c-g", 제안: "c-j", 미결: "c-m", 사실: "c-s" };

/* HTML 특수문자를 이스케이프한다 */
export function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ---------- 인라인 ---------- */

/* open 위치의 '[' 에 짝지어진 ']' 위치를 찾는다. 코드 span 안의 대괄호는 건너뛴다. 없으면 -1 */
function matchBracket(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "`") {
      let n = 0;
      while (s[i + n] === "`") n++;
      const close = findFence(s, i + n, n);
      if (close !== -1) i = close + n - 1;
      else i += n - 1;
    } else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/* from 부터 정확히 n 개짜리 백틱 묶음의 시작 위치를 찾는다 */
function findFence(s, from, n) {
  let i = from;
  while (i < s.length) {
    if (s[i] !== "`") { i++; continue; }
    let k = 0;
    while (s[i + k] === "`") k++;
    if (k === n) return i;
    i += k;
  }
  return -1;
}

const CHIP_RE = /^(결정|가정|제안|미결|사실)(?:\s*[,:：]\s*([\s\S]*))?$/;
const SECTION_REF_RE = /(?<!설계 )(?<!설계 문서 )(?<!명세 )§(\d+)(?:\.(\d+))?/g;

/* 평문 조각에서 "§n", "§n.m" 을 같은 문서 안에 id 가 있으면 링크로 바꾼다 */
function linkRefs(text, ctx) {
  if (!ctx.refs || ctx.noRef) return esc(text);
  let out = "";
  let last = 0;
  SECTION_REF_RE.lastIndex = 0;
  let m;
  while ((m = SECTION_REF_RE.exec(text))) {
    let id = `s${m[1]}${m[2] ? `-${m[2]}` : ""}`;
    if (!ctx.ids.has(id)) id = `s${m[1]}`;
    if (!ctx.ids.has(id)) continue;
    out += esc(text.slice(last, m.index)) + `<a href="#${id}">${esc(m[0])}</a>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

/*
 * 인라인 Markdown 을 HTML 로 바꾼다.
 * ctx: { ids, refs, noRef, mark, kinds(수집용 배열) }
 *  - mark 가 참이면 표기 칩에 data-k 를 달고 kinds 에 종류를 모은다.
 */
export function renderInline(src, ctx = {}) {
  let out = "";
  let buf = "";
  const flush = () => {
    if (buf) out += linkRefs(buf, ctx);
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "`") {
      let n = 0;
      while (src[i + n] === "`") n++;
      const close = findFence(src, i + n, n);
      if (close !== -1) {
        flush();
        let code = src.slice(i + n, close);
        if (n > 1 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        out += `<code>${esc(code)}</code>`;
        i = close + n;
        continue;
      }
      buf += src.slice(i, i + n);
      i += n;
      continue;
    }
    if (c === "[") {
      const end = matchBracket(src, i);
      if (end !== -1) {
        const inner = src.slice(i + 1, end);
        const chip = CHIP_RE.exec(inner);
        if (chip) {
          flush();
          const kind = chip[1];
          const note = chip[2] === undefined ? "" : chip[2].trim();
          const attr = ctx.mark ? ` data-k="${kind}"` : "";
          if (ctx.mark && ctx.kinds) ctx.kinds.push(kind);
          out += `<span class="chip ${KIND_CLASS[kind]}"${attr}>${kind}</span>`;
          if (note) out += `<span class="note">${renderInline(note, { ...ctx, mark: false, noRef: true })}</span>`;
          i = end + 1;
          continue;
        }
        if (src[end + 1] === "(") {
          const url = readParen(src, end + 1);
          if (url !== null) {
            flush();
            const href = url.value.trim();
            out += `<a href="${esc(href)}">${renderInline(inner, { ...ctx, noRef: true })}</a>`;
            i = url.end + 1;
            continue;
          }
        }
      }
    }
    if (c === "*" && src[i + 1] === "*") {
      const close = src.indexOf("**", i + 2);
      if (close > i + 2) {
        flush();
        out += `<strong>${renderInline(src.slice(i + 2, close), ctx)}</strong>`;
        i = close + 2;
        continue;
      }
    }
    if (c === "~" && src[i + 1] === "~") {
      const close = src.indexOf("~~", i + 2);
      if (close > i + 2) {
        flush();
        out += `<del>${renderInline(src.slice(i + 2, close), ctx)}</del>`;
        i = close + 2;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/* open 위치의 '(' 부터 짝지어진 ')' 까지 읽는다 */
function readParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return { value: s.slice(open + 1, i), end: i };
    }
  }
  return null;
}

/* ---------- 블록 ---------- */

const RE_FENCE = /^\s*```/;
const RE_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_HR = /^\s*-{3,}\s*$/;
const RE_LIST = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/* 표의 한 줄을 칸으로 나눈다. `\|` 는 칸 안의 '|' 문자다 */
export function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; }
    else if (s[i] === "|") { cells.push(cur.trim()); cur = ""; }
    else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function startsBlock(lines, i) {
  const l = lines[i];
  return (
    RE_FENCE.test(l) || RE_HEADING.test(l) || RE_HR.test(l) || RE_LIST.test(l) || /^\s*>/.test(l) ||
    (l.trim().startsWith("|") && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]))
  );
}

/* 줄 목록을 블록 트리로 파싱한다 */
export function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (RE_FENCE.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !RE_FENCE.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    const h = RE_HEADING.exec(line);
    if (h) { blocks.push({ type: "heading", level: h[1].length, text: h[2] }); i++; continue; }
    if (RE_HR.test(line)) { blocks.push({ type: "hr" }); i++; continue; }
    if (line.trim().startsWith("|") && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(splitRow(lines[i++]));
      blocks.push({ type: "table", header, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const inner = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) inner.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ type: "quote", blocks: parseBlocks(inner) });
      continue;
    }
    if (RE_LIST.test(line)) {
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = RE_LIST.exec(l);
        if (m) {
          // 같은 들여쓰기에서 글머리표와 번호가 바뀌면 새 목록이다
          if (items.length && m[1].length <= items[0].indent && /\d/.test(m[2]) !== items[0].ordered) break;
          items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), num: parseInt(m[2], 10), text: m[3] });
          i++;
        } else if (!l.trim()) {
          let j = i;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j < lines.length && (RE_LIST.test(lines[j]) || /^\s+\S/.test(lines[j])) && items.length) i = j;
          else break;
        } else if (/^\s+\S/.test(l) && items.length) {
          items[items.length - 1].text += "\n" + l.trim();
          i++;
        } else break;
      }
      blocks.push(buildList(items));
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) para.push(lines[i++].trim());
    blocks.push({ type: "para", text: para.join("\n") });
  }
  return blocks;
}

/* 들여쓰기가 있는 평평한 항목열을 중첩 목록으로 만든다 */
function buildList(items) {
  const root = { type: "list", ordered: items[0].ordered, start: items[0].num, items: [] };
  const stack = [{ indent: items[0].indent, list: root }];
  for (const it of items) {
    while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) stack.pop();
    let top = stack[stack.length - 1];
    if (it.indent > top.indent) {
      const parent = top.list.items[top.list.items.length - 1];
      if (parent) {
        const child = { type: "list", ordered: it.ordered, start: it.num, items: [] };
        parent.children.push(child);
        top = { indent: it.indent, list: child };
        stack.push(top);
      }
    }
    top.list.items.push({ text: it.text, children: [] });
  }
  return root;
}

/* ---------- 렌더 ---------- */

const NUM_CELL_RE = /^(§?[A-Za-z]?\d+(\.\d+)?)(,\s*§?[A-Za-z]?\d+(\.\d+)?)*$/;

function markAttr(kinds) {
  const uniq = [...new Set(kinds)];
  return uniq.length ? ` class="m" data-m="${uniq.join(" ")}"` : "";
}

function renderTable(b, ctx) {
  const cols = b.header.length;
  const numCol = b.header.map((h, c) => h === "#" || (b.rows.length > 0 && b.rows.every((r) => NUM_CELL_RE.test(r[c] ?? ""))));
  const cls = cols >= 6 ? ' class="w6"' : cols >= 4 ? ' class="w4"' : "";
  const th = b.header
    .map((h, c) => `<th${numCol[c] ? ' class="num"' : ""}>${renderInline(h, { ...ctx, mark: false })}</th>`)
    .join("");
  const rows = b.rows
    .map((r) => {
      const kinds = [];
      const cells = [];
      for (let c = 0; c < cols; c++) {
        cells.push(`<td${numCol[c] ? ' class="num"' : ""}>${renderInline(r[c] ?? "", { ...ctx, mark: true, kinds })}</td>`);
      }
      noteCounts(ctx, kinds);
      return `<tr${markAttr(kinds)}>${cells.join("")}</tr>`;
    })
    .join("\n        ");
  return `<div class="tw">\n    <table${cls}>\n      <thead><tr>${th}</tr></thead>\n      <tbody>\n        ${rows}\n      </tbody>\n    </table>\n  </div>`;
}

function noteCounts(ctx, kinds) {
  if (!ctx.counts) return;
  for (const k of kinds) ctx.counts[k] = (ctx.counts[k] ?? 0) + 1;
}

function renderList(l, ctx, indent) {
  const tag = l.ordered ? "ol" : "ul";
  const pad = "  ".repeat(indent);
  const startAttr = l.ordered && l.start !== 1 ? ` start="${l.start}"` : "";
  const lis = l.items.map((it) => {
    const kinds = [];
    const inner = renderInline(it.text, { ...ctx, mark: ctx.mark !== false, kinds });
    noteCounts(ctx, kinds);
    const nested = it.children.map((ch) => "\n" + renderList(ch, ctx, indent + 2)).join("");
    if (!kinds.length) return `${pad}  <li>${inner}${nested ? nested + `\n${pad}  ` : ""}</li>`;
    if (nested) return `${pad}  <li><span${markAttr(kinds)}>${inner}</span>${nested}\n${pad}  </li>`;
    return `${pad}  <li${markAttr(kinds)}>${inner}</li>`;
  });
  return `${pad}<${tag}${startAttr}>\n${lis.join("\n")}\n${pad}</${tag}>`;
}

function renderBlock(b, ctx, indent = 1) {
  const pad = "  ".repeat(indent);
  switch (b.type) {
    case "para": {
      const kinds = [];
      const inner = renderInline(b.text, { ...ctx, mark: true, kinds });
      noteCounts(ctx, kinds);
      return `${pad}<p${markAttr(kinds)}>${inner}</p>`;
    }
    case "code":
      return `${pad}<pre class="code"><code>${esc(b.text)}</code></pre>`;
    case "hr":
      return `${pad}<hr>`;
    case "quote":
      return `${pad}<blockquote>\n${b.blocks.map((x) => renderBlock(x, ctx, indent + 1)).join("\n")}\n${pad}</blockquote>`;
    case "table":
      return pad + renderTable(b, ctx);
    case "list":
      return renderList(b, ctx, indent);
    default:
      return "";
  }
}

/* 제목 한 줄의 번호·본문·id 를 해석한다 */
function parseHeading(b, secCount) {
  const text = b.text;
  if (b.level === 2) {
    const m = /^(\d+)\.\s+(.*)$/.exec(text);
    if (m) return { id: `s${m[1]}`, sn: `§${m[1]}`, title: m[2], num: m[1] };
    secCount.sec += 1;
    return { id: `sec-${secCount.sec}`, sn: "", title: text };
  }
  if (b.level === 3) {
    const m = /^(\d+)\.(\d+)\.?\s+(.*)$/.exec(text);
    if (m) return { id: `s${m[1]}-${m[2]}`, sn: `§${m[1]}.${m[2]}`, title: m[3] };
    secCount.sub += 1;
    return { id: `sub-${secCount.sub}`, sn: "", title: text };
  }
  return { id: "", sn: "", title: text };
}

function renderHeadingInner(h, ctx, kinds) {
  const sn = h.sn ? `<span class="sn">${h.sn}</span>` : "";
  return sn + renderInline(h.title, { ...ctx, noRef: true, mark: true, kinds });
}

/* 머리 목록: "라벨: 내용" 꼴은 메타 정보로, 나머지는 머리 설명으로 그린다 */
function renderHeadList(list, ctx) {
  const meta = [];
  const notes = [];
  const legend = { ...ctx, mark: false };
  for (const it of list.items) {
    const m = /^([^:：`[\]*]{1,12}):\s+([\s\S]+)$/.exec(it.text);
    if (m && !it.children.length) {
      const kinds = [];
      const dd = renderInline(m[2], { ...ctx, mark: true, kinds });
      noteCounts(ctx, kinds);
      const a = markAttr(kinds);
      meta.push(`    <dt${a}>${esc(m[1])}</dt><dd${a}>${dd}</dd>`);
    } else {
      const inner = renderInline(it.text, legend);
      const nested = it.children.map((ch) => "\n" + renderList(ch, legend, 3)).join("");
      notes.push(`    <li>${inner}${nested ? nested + "\n    " : ""}</li>`);
    }
  }
  const parts = [];
  if (meta.length) parts.push(`  <dl class="meta">\n${meta.join("\n")}\n  </dl>`);
  if (notes.length) parts.push(`  <ul class="headnotes">\n${notes.join("\n")}\n  </ul>`);
  return parts.join("\n");
}

function renderFilter(counts) {
  const total = KINDS.reduce((s, k) => s + (counts[k] ?? 0), 0);
  if (!total) return "";
  const btn = (k, n, pressed) =>
    `    <button type="button" data-f="${k}" aria-pressed="${pressed}">${k} <span class="n" data-n="${k}">${n}</span></button>`;
  return [
    '<div class="panel" id="legend">',
    "  <h2>표기 필터</h2>",
    '  <div class="filters" role="group" aria-label="표기 필터">',
    btn("전체", total, "true"),
    ...KINDS.map((k) => btn(k, counts[k] ?? 0, "false")),
    "  </div>",
    "</div>",
  ].join("\n");
}

/* Markdown 문자열을 HTML 문서 문자열로 바꾼다 */
export function mdToHtml(md, template = readFileSync(TEMPLATE_PATH, "utf8")) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks = parseBlocks(lines);

  // 첫 # 제목과 그 아래 첫 목록을 머리로 떼어 낸다
  let title = "";
  let k = 0;
  if (blocks[0] && blocks[0].type === "heading" && blocks[0].level === 1) {
    title = blocks[0].text;
    k = 1;
  }
  let headList = null;
  if (blocks[k] && blocks[k].type === "list") { headList = blocks[k]; k++; }
  const rest = blocks.slice(k);

  // 제목 id 수집(§ 링크 대상)
  const secCount = { sec: 0, sub: 0 };
  const ids = new Set();
  const heads = new Map();
  for (const b of rest) {
    if (b.type !== "heading" || b.level < 2 || b.level > 3) continue;
    const h = parseHeading(b, secCount);
    heads.set(b, h);
    ids.add(h.id);
  }

  const counts = {};
  const ctx = { ids, refs: true, counts };
  const headHtml = headList ? renderHeadList(headList, ctx) : "";

  // 절 단위로 묶어 본문을 만든다
  const out = [];
  const tocItems = [];
  let open = false;
  let intro = [];
  const closeSection = () => { if (open) out.push("</section>\n"); open = false; };
  for (const b of rest) {
    if (b.type === "heading" && b.level === 2) {
      closeSection();
      if (intro.length) { out.push(`<div class="intro">\n${intro.join("\n")}\n</div>\n`); intro = []; }
      const h = heads.get(b);
      const kinds = [];
      const inner = renderHeadingInner(h, ctx, kinds);
      noteCounts(ctx, kinds);
      out.push(`<section id="${h.id}">\n  <h2${markAttr(kinds)}>${inner}</h2>\n`);
      tocItems.push(h);
      open = true;
      continue;
    }
    let html;
    if (b.type === "heading") {
      const h = heads.get(b);
      const kinds = [];
      if (b.level === 3) {
        const inner = renderHeadingInner(h, ctx, kinds);
        noteCounts(ctx, kinds);
        html = `  <h3 id="${h.id}"${markAttr(kinds)}>${inner}</h3>`;
      } else {
        const tag = `h${Math.min(b.level, 6)}`;
        const inner = renderInline(b.text, { ...ctx, noRef: true, mark: true, kinds });
        noteCounts(ctx, kinds);
        html = `  <${tag}${markAttr(kinds)}>${inner}</${tag}>`;
      }
    } else if (b.type === "hr" && !open) {
      continue;
    } else {
      html = renderBlock(b, ctx, 1);
    }
    if (open) out.push(html + "\n");
    else intro.push(html);
  }
  closeSection();
  if (intro.length) out.unshift(`<div class="intro">\n${intro.join("\n")}\n</div>\n`);

  // 절 목차
  const numbered = tocItems.filter((h) => h.sn);
  let label = "절 목차";
  if (numbered.length && numbered.length === tocItems.length) {
    label += `(${numbered[0].sn}~${numbered[numbered.length - 1].sn})`;
  } else if (tocItems.length) label += `(${tocItems.length}개)`;
  const tocHtml = tocItems.length
    ? [
        '  <details id="tocd" open>',
        `    <summary>${esc(label)}</summary>`,
        "    <ul>",
        ...tocItems.map((h) => {
          const inner = renderInline(h.title, { ids, refs: false }).replace(/<a [^>]*>|<\/a>/g, "");
          return `      <li><a href="#${h.id}">${h.sn ? `<span class="sn">${h.sn}</span>` : ""}${inner}</a></li>`;
        }),
        "    </ul>",
        "  </details>",
      ].join("\n")
    : "";

  const plainTitle = title ? renderInline(title, { refs: false }).replace(/<[^>]+>/g, "") : "";
  const vals = {
    TITLE: plainTitle,
    H1: title ? renderInline(title, { refs: false }) : "",
    HEAD: headHtml,
    FILTER: renderFilter(counts),
    TOC: tocHtml,
    BODY: out.join("\n").replace(/\n+$/, ""),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in vals ? vals[key] : ""));
}

/* ---------- 명령줄 ---------- */

function main(argv) {
  const [input, output] = argv;
  if (!input) {
    process.stderr.write("사용: node scripts/md-page.mjs <입력.md> [출력.html]\n");
    return 2;
  }
  const out = output ?? input.replace(/\.[^./\\]+$/, "") + ".html";
  const html = mdToHtml(readFileSync(input, "utf8"));
  writeFileSync(out, html);
  process.stdout.write(`${out}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
