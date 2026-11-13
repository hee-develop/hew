import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts/md-page.mjs");

type Converter = { mdToHtml: (md: string) => string };
const mod = (await import(SCRIPT)) as Converter;
const convert = mod.mdToHtml;

const DOCS = ["DESIGN", "SPEC-stage-1", "AUTO-DECISIONS-2026-11-14"];

/* 출력 HTML 에서 script·style·title 을 뺀 본문 텍스트(엔티티 해제, 공백 제거) */
function visibleText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<title>[\s\S]*?<\/title>/g, "")
    .replace(/<[^>]+>/g, "");
  return stripped
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, "");
}

const CHIP_SPLIT = /\[(?:결정|가정|제안|미결|사실)(?:\s*[,:：]\s*([^\]]*))?\]/g;

/* 한 줄의 글 조각을 뽑는다. 표기 마커는 경계로 쓰고 덧붙은 말은 별도 조각으로 둔다 */
function textPieces(text: string): string[] {
  const codes: string[] = [];
  const t = text.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  const clean = (s: string) =>
    s
      .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1")
      .replace(/\*\*/g, "")
      .replace(/~~/g, "")
      .replace(/\u0000(\d+)\u0000/g, (_, n: string) => codes[Number(n)] ?? "");
  const pieces: string[] = [];
  let last = 0;
  for (const m of t.matchAll(CHIP_SPLIT)) {
    pieces.push(clean(t.slice(last, m.index)));
    if (m[1]) pieces.push(clean(m[1]));
    last = (m.index ?? 0) + m[0].length;
  }
  pieces.push(clean(t.slice(last)));
  return pieces;
}

/* 원문에서 출력에 있어야 할 조각(공백 제거, 4글자 이상)을 모두 뽑는다 */
function sourcePieces(md: string): string[] {
  const out: string[] = [];
  let inCode = false;
  let inHead = true;
  for (const raw of md.split("\n")) {
    if (/^##\s/.test(raw)) inHead = false;
    if (/^\s*```/.test(raw)) { inCode = !inCode; continue; }
    if (inCode) { out.push(raw); continue; }
    if (!raw.trim() || /^\s*-{3,}\s*$/.test(raw)) continue;
    let line = raw;
    if (line.trim().startsWith("|")) {
      if (/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line)) continue;
      const cells = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/);
      for (const c of cells) out.push(...textPieces(c.replace(/\\\|/g, "|").trim()));
      continue;
    }
    line = line.replace(/^\s*>\s?/, "");
    // 절 번호는 "§n" 표식으로 그려지므로 번호 기호만 걷어 낸다
    line = line.replace(/^(#{2,3})\s+\d+(\.\d+)?\.?\s+/, "$1 ");
    line = line.replace(/^#{1,6}\s+/, "").replace(/^\s*([-*+]|\d+\.)\s+/, "");
    // 머리 정보의 "라벨: 내용" 은 라벨과 내용을 따로 그린다
    if (inHead) line = line.replace(/^([^:：`[\]*]{1,12}):\s+/, "$1 ");
    out.push(...textPieces(line));
  }
  return out.map((p) => p.replace(/\s+/g, "")).filter((p) => p.length >= 4);
}

describe("md-page: 블록", () => {
  it("제목·문단·수평선·인용", () => {
    const html = convert("# 제목\n\n## 1. 첫 절\n\n본문 한 줄\n둘째 줄\n\n---\n\n> 인용문\n\n### 1.1 소절\n\n#### 작은 제목\n");
    expect(html).toContain('<section id="s1">');
    expect(html).toContain('<h3 id="s1-1"><span class="sn">§1.1</span>소절</h3>');
    expect(html).toContain("<h4>작은 제목</h4>");
    expect(html).toContain("<p>본문 한 줄\n둘째 줄</p>");
    expect(html).toContain("<hr>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<p>인용문</p>");
  });

  it("번호 없는 ## 는 순서대로 sec-k", () => {
    const html = convert("# t\n\n## A. 가\n\n## B. 나\n");
    expect(html).toContain('<section id="sec-1">');
    expect(html).toContain('<section id="sec-2">');
    expect(html).toContain("A. 가");
  });

  it("글머리표·번호 목록과 2칸 중첩", () => {
    const html = convert("# t\n\n## 1. 절\n\n- 가\n  - 나\n    - 다\n- 라\n\n1. 하나\n2. 둘\n");
    expect(html).toMatch(/<li>가\n\s*<ul>\n\s*<li>나\n\s*<ul>\n\s*<li>다<\/li>/);
    expect(html).toContain("<li>라</li>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>둘</li>");
  });

  it("GFM 표와 칸 안의 이스케이프된 파이프", () => {
    const html = convert("# t\n\n## 1. 절\n\n| 가 | 나 |\n|---|---|\n| a \\| b | `x\\|y` |\n");
    expect(html).toContain("<th>가</th><th>나</th>");
    expect(html).toContain("<td>a | b</td>");
    expect(html).toContain("<td><code>x|y</code></td>");
    expect(html).toContain('<div class="tw">');
  });

  it("펜스 코드 블록은 그대로 두고 안의 마크다운·꺾쇠를 해석하지 않는다", () => {
    const html = convert("# t\n\n```json\n  # 제목 아님 <run_id> **굵게**\n- 목록 아님\n```\n");
    expect(html).toContain('<pre class="code"><code>  # 제목 아님 &lt;run_id&gt; **굵게**\n- 목록 아님</code></pre>');
    expect(html).not.toContain("<h1>제목 아님");
  });
});

describe("md-page: 인라인", () => {
  it("코드·링크·굵게·취소선과 이스케이프", () => {
    const html = convert("# t\n\n문단 `a<b>` [글](https://x.test/?a=1&b=2) **굵게** ~~취소~~ <run_id> & \"따옴표\"\n");
    expect(html).toContain("<code>a&lt;b&gt;</code>");
    expect(html).toContain('<a href="https://x.test/?a=1&amp;b=2">글</a>');
    expect(html).toContain("<strong>굵게</strong>");
    expect(html).toContain("<del>취소</del>");
    expect(html).toContain("&lt;run_id&gt; &amp; &quot;따옴표&quot;");
  });

  it("코드 안의 별표·꺾쇠·대괄호는 해석하지 않는다", () => {
    const html = convert("# t\n\n`**a** [결정]` 뒤\n");
    expect(html).toContain("<code>**a** [결정]</code>");
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain('class="chip');
  });
});

describe("md-page: 표기 칩과 필터", () => {
  const md = [
    "# t",
    "",
    "## 1. 절",
    "",
    "문장 [결정] 과 [가정, 2026-10-20 결정 계승] 이다.",
    "",
    "- 항목 [미결: 실측]",
    "  - 하위 [사실: 근거 `코드` 있음]",
    "- 표기 없음",
    "",
    "| 열 | 값 |",
    "|---|---|",
    "| 가 | 나 [제안] |",
    "",
  ].join("\n");

  it("칩과 덧붙은 말을 그린다", () => {
    const html = convert(md);
    expect(html).toContain('<span class="chip c-d" data-k="결정">결정</span>');
    expect(html).toContain('<span class="chip c-g" data-k="가정">가정</span><span class="note">2026-10-20 결정 계승</span>');
    expect(html).toContain('<span class="chip c-m" data-k="미결">미결</span><span class="note">실측</span>');
    expect(html).toContain('<span class="note">근거 <code>코드</code> 있음</span>');
  });

  it("문장 단위 블록에 data-m 을 달고 한 블록의 표기가 여럿이면 모두 단다", () => {
    const html = convert(md);
    expect(html).toContain('<p class="m" data-m="결정 가정">');
    expect(html).toContain('<li class="m" data-m="사실">하위');
    expect(html).toContain('<tr class="m" data-m="제안">');
    expect(html).toContain('<li><span class="m" data-m="미결">항목');
    expect(html).toContain("<li>표기 없음</li>");
  });

  it("필터 개수를 표시하고 표기가 없으면 필터를 그리지 않는다", () => {
    const html = convert(md);
    expect(html).toContain('data-n="전체">5<');
    expect(html).toContain('data-n="결정">1<');
    expect(html).toContain('data-n="사실">1<');
    expect(convert("# t\n\n## 1. 절\n\n표기 없음\n")).not.toContain('class="filters"');
  });
});

describe("md-page: 머리와 목차와 § 링크", () => {
  const md = [
    "# 문서 제목",
    "",
    "- 작성: 2026-11-14",
    "- 상태: 초안 [가정]",
    "- 표기는 같다. [결정] 설명",
    "",
    "---",
    "",
    "## 1. 첫째",
    "",
    "참조 §2 와 §2.1 과 §9 와 설계 §2 와 설계 문서 §1 과 명세 §2.1 과 `§2`.",
    "",
    "## 2. 둘째",
    "",
    "### 2.1 소절",
    "",
  ].join("\n");

  it("첫 # 는 title 과 머리, 그 아래 목록은 머리 정보", () => {
    const html = convert(md);
    expect(html).toContain("<title>문서 제목</title>");
    expect(html).toContain("<h1>문서 제목</h1>");
    expect(html).toContain("<dt>작성</dt><dd>2026-11-14</dd>");
    expect(html).toContain('<ul class="headnotes">');
  });

  it("머리 안내의 범례 칩은 필터에 세지 않는다", () => {
    const html = convert(md);
    expect(html).toContain('data-n="전체">1<');
    expect(html).toContain('data-n="결정">0<');
  });

  it("같은 문서에 있는 id 만 링크하고 다른 문서 절 참조는 링크하지 않는다", () => {
    const html = convert(md);
    expect(html).toContain('<a href="#s2">§2</a> 와 <a href="#s2-1">§2.1</a> 과 §9 와 설계 §2 와 설계 문서 §1 과 명세 §2.1 과 <code>§2</code>.');
  });

  it("절 목차", () => {
    const html = convert(md);
    expect(html).toContain("절 목차(§1~§2)");
    expect(html).toContain('<a href="#s1"><span class="sn">§1</span>첫째</a>');
  });
});

describe("md-page: 실제 문서", () => {
  it("package.json 의 docs 명령이 세 문서를 변환한다", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    for (const d of DOCS) expect(pkg.scripts.docs).toContain(`node scripts/md-page.mjs docs/${d}.md`);
  });

  for (const name of DOCS) {
    const md = readFileSync(path.join(ROOT, "docs", `${name}.md`), "utf8");
    const html = convert(md);

    it(`${name}: 원문의 모든 글 조각이 출력에 있다`, () => {
      const text = visibleText(html);
      const pieces = sourcePieces(md);
      expect(pieces.length).toBeGreaterThan(50);
      const missing = pieces.filter((p) => !text.includes(p));
      expect(missing).toEqual([]);
    });

    it(`${name}: 독립 파일이며 외부 리소스는 Google Fonts 뿐이고 인라인 스크립트가 파싱된다`, () => {
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain('<html lang="ko">');
      expect(html).toContain('<meta charset="utf-8">');
      expect(html).toContain('name="viewport"');
      expect(html).not.toMatch(/<script[^>]*\ssrc=/);
      const hrefs = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
      for (const h of hrefs) expect(h).toMatch(/^https:\/\/fonts\.googleapis\.com\//);
      expect(html).not.toMatch(/@import|url\(\s*["']?https?:/);
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
      expect(scripts.length).toBeGreaterThan(0);
      for (const s of scripts) expect(() => new Function(s)).not.toThrow();
    });

    it(`${name}: 같은 입력이면 같은 출력`, () => {
      expect(convert(md)).toBe(html);
    });
  }

  it("명령줄: 출력 경로를 생략하면 같은 이름의 .html 을 쓴다", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "md-page-"));
    const src = path.join(dir, "a.md");
    writeFileSync(src, "# 제목\n\n## 1. 절\n\n본문\n");
    execFileSync("node", [SCRIPT, src]);
    expect(readFileSync(path.join(dir, "a.html"), "utf8")).toBe(convert("# 제목\n\n## 1. 절\n\n본문\n"));
  });
});
