/** 이 맥의 옛 실행 폴더가 있을 때만 도는 실자료 확인(자료는 저장소에 없다). */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inventoryFileFromContent } from "../src/core/figma/inventory.js";
import { captureTargets } from "../src/core/collect/plan.js";
import { parseCase } from "../src/core/case.js";
import { markdownFromSource } from "../src/core/units/extract.js";
import { parseMarkdownUnits } from "../src/core/units/markdown.js";

const root = join(homedir(), "Desktop", "mobile-workflow-runs");
const run1 = join(root, "20261021-1000000001-screens");
const run2 = join(root, "20261028-1000000002-screens");
const prd1 = join(run1, "sources", "prd-1000000001.md");
const prd2 = join(run2, "sources", "prd-1000000002.md");
const figma1 = join(run1, "sources", "figma-FigmaFileKeyExample001-1-92.json");
const screens1 = join(run1, "screens.json");

const tail = (id: string): string => id.split(":").slice(-2).join(":");

describe.skipIf(!existsSync(prd1))("실자료: PRD", () => {
  it("Requirements 표의 데이터 행 수만큼 table_row 단위가 그 섹션에 있다", () => {
    const md = readFileSync(prd1, "utf8");
    const units = parseMarkdownUnits(md);
    const section = md.split(/^## Requirements\s*$/m)[1]?.split(/^## /m)[0] ?? "";
    const dataRows = section.split("\n").filter((l) => l.startsWith("|")).length - 2;
    const rows = units.filter((u) => u.kind === "table_row" && u.locator.section.join("/") === "Requirements");
    console.log(`PRD1 단위 ${units.length}개, Requirements 표 행 ${rows.length}/${dataRows}, actor`, countActors(units));
    expect(units.length).toBeGreaterThan(0);
    expect(rows).toHaveLength(dataRows);
  });
});

describe.skipIf(!existsSync(prd2))("실자료: 주체 열이 있는 PRD", () => {
  it("operator 와 provider 단위가 모두 나온다", () => {
    const units = parseMarkdownUnits(readFileSync(prd2, "utf8"));
    const actors = countActors(units);
    console.log(`PRD2 단위 ${units.length}개, actor`, actors);
    expect(actors.operator ?? 0).toBeGreaterThanOrEqual(1);
    expect(actors.provider ?? 0).toBeGreaterThanOrEqual(1);
  });
});

describe.skipIf(!existsSync(figma1) || !existsSync(screens1))("실자료: Figma 메타데이터", () => {
  it("화면 목록이 만들어지고 옛 화면 목록의 as-is·to-be 노드가 모두 들어 있다", () => {
    const inv = inventoryFileFromContent("S-1", "FigmaFileKeyExample001", readFileSync(figma1, "utf8"));
    const byId = new Map(inv.frames.map((f) => [f.node_id, f]));
    const screens = JSON.parse(readFileSync(screens1, "utf8")).screens as {
      figma_as_is: string[];
      figma_to_be: string[];
      variants?: { figma_as_is?: string[]; figma_to_be?: string[] }[];
    }[];
    const ids = new Set<string>();
    for (const s of screens) {
      for (const id of [...s.figma_as_is, ...s.figma_to_be]) ids.add(tail(id));
      for (const v of s.variants ?? []) for (const id of [...(v.figma_as_is ?? []), ...(v.figma_to_be ?? [])]) ids.add(tail(id));
    }
    const missing = [...ids].filter((id) => !byId.has(id));
    const app = [...ids].filter((id) => byId.get(id)?.platform === "app").length;
    const byPlatform: Record<string, number> = {};
    for (const f of inv.frames) byPlatform[f.platform] = (byPlatform[f.platform] ?? 0) + 1;
    console.log(`Figma 프레임 ${inv.frames.length}개(설명 카드 ${inv.frames.filter((f) => f.is_desc).length}), 플랫폼`, byPlatform);
    console.log(`옛 화면 목록 노드 ${ids.size}개 중 inventory 포함 ${ids.size - missing.length}, 앱으로 분류 ${app} (${((app / ids.size) * 100).toFixed(0)}%)`);
    expect(inv.frames.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});

function countActors(units: { actor?: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of units) if (u.actor) out[u.actor] = (out[u.actor] ?? 0) + 1;
  return out;
}

// 무인 수집 세션이 받아 적은 실제 응답 사본(저장소에 넣지 않는다). HEW_RECORDED_SAMPLES 폴더(calls/001.json, keep/figma-tool-result.txt)가 있을 때만 돈다.
const rec = process.env.HEW_RECORDED_SAMPLES ?? join(homedir(), "hew-recorded-samples");
const recConfluence = join(rec, "calls", "001.json");
const recFigma = join(rec, "keep", "figma-tool-result.txt");

describe.skipIf(!existsSync(recConfluence))("실사본: Confluence 응답", () => {
  it("한 번 풀어 얻은 응답 문자열을 payload 로 넣으면 단위가 나오고 Requirements 표의 행이 table_row 가 된다", () => {
    const payload = JSON.parse(readFileSync(recConfluence, "utf8")) as string;
    const md = markdownFromSource(payload, "payload.json");
    const units = parseMarkdownUnits(md);
    const rows = units.filter((u) => u.kind === "table_row" && u.locator.section.join("/") === "Requirements");
    console.log(`Confluence 응답: 본문 ${md.length}자, 단위 ${units.length}개, table_row ${units.filter((u) => u.kind === "table_row").length}개(Requirements ${rows.length}개)`);
    expect(md.length).toBeGreaterThan(0);
    expect(units.length).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!existsSync(recFigma))("실사본: Figma get_metadata 결과 파일", () => {
  it("payload 로 넣으면 화면 목록이 만들어지고 캡처 대상이 계산된다", () => {
    const inv = inventoryFileFromContent("S-1", "FigmaFileKeyExample001", readFileSync(recFigma, "utf8"));
    const targets = captureTargets(inv.frames);
    const app = inv.frames.filter((f) => !f.is_desc && f.platform === "app").length;
    console.log(`Figma 결과: 프레임 ${inv.frames.length}개, 앱 ${app}개, 캡처 대상 ${targets.length}개`);
    expect(inv.frames.length).toBeGreaterThan(0);
    expect(app).toBeGreaterThan(0);
    expect(targets.length).toBeGreaterThanOrEqual(app);
  });
});

const oldCase = join(homedir(), "hew-old", "replay", "cases", "app-3008.yaml");

describe.skipIf(!existsSync(oldCase))("실자료: 옛 사례 파일", () => {
  it("옛 형식 사례 파일에서 PRD 버전·known_at·차단 목록을 읽는다", () => {
    const { info } = parseCase(readFileSync(oldCase, "utf8"));
    console.log(`옛 사례: prd_version ${info.prd_version}, known_at ${info.known_at}, 차단 Jira ${info.block.jira_keys.length}개, PR ${info.block.pr_numbers.length}개`);
    expect(info.prd_version).toBe("22");
    expect(info.known_at).toBe("2026-09-10");
    expect(info.block.jira_keys).toContain("APP-3094");
    expect(info.block.pr_numbers).toContain(1054);
  });
});
