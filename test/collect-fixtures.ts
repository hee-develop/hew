/** 수집 단계 테스트용 합성 자료: 도구 응답 모양의 JSON, Figma 메타데이터, 받아 적은 호출 심기. */
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const FIGMA_KEY = "FigmaFileKeyExample001";
export const SITE = "https://example.atlassian.net";

/** Confluence getConfluencePage 응답 모양(`content.nodes[0]`). */
export function confluenceResponse(body: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    content: { totalCount: 1, nodes: [{ id: "123", type: "page", status: "current", title: "합성 PRD", lastModified: "2026-09-09", summary: "요약", body, webUrl: `${SITE}/wiki/pages/123`, ...extra }] },
    context: { featureFlags: { x: true } },
  });
}

/** Jira getJiraIssue 응답 모양. */
export function jiraResponse(opts: { key: string; summary?: string; description?: string; parent?: string }): string {
  return JSON.stringify({
    key: opts.key,
    fields: {
      summary: opts.summary ?? "합성 티켓",
      description: opts.description ?? "",
      ...(opts.parent === undefined ? {} : { parent: { key: opts.parent, fields: { summary: "상위" } } }),
    },
  });
}

export const PRD_BODY = `## Overview

본문 문단입니다.

## Requirements

| # | **User Journey** | 기능 |
| --- | --- | --- |
| 1 | 판매자가 홈에서 배너를 본다 | 배너를 노출한다 |
| 2 | 구매자가 결제한다 | 결제 |

디자인: https://www.figma.com/design/${FIGMA_KEY}/sample?node-id=1-92
참고: ${SITE}/wiki/spaces/X/pages/456/ADR
다시: ${SITE}/wiki/pages/viewpage.action?pageId=789
자기 자신: ${SITE}/wiki/spaces/X/pages/123/T
다른 사이트: https://other.atlassian.net/wiki/spaces/X/pages/999/Z
`;

/** 앱 2개(하나만 라벨), 접두사 없는 프레임 2개(라벨 있음: 앱 화면 이름 / 웹처럼 보이는 이름), 웹·모웹, 라벨 없는 접두사 없는 프레임, 설명 카드. */
const NODES = [
  '<canvas id="1:92" name="샘플 캔버스" x="0" y="0" width="0" height="0">',
  '  <section id="2:1" name="섹션 A" x="0" y="0" width="5000" height="3000">',
  '    <instance id="3:1" name="asis_tobe_label" x="100" y="20" width="375" height="40" />',
  '    <instance id="3:2" name="asis_tobe_label" x="900" y="20" width="375" height="40" />',
  '    <instance id="3:3" name="asis_tobe_label" x="1300" y="20" width="375" height="40" />',
  '    <frame id="4:1" name="앱/홈" x="100" y="100" width="375" height="800" />',
  '    <frame id="4:2" name="앱/상세" x="500" y="100" width="375" height="800" />',
  '    <frame id="4:3" name="Screen A" x="900" y="100" width="375" height="800" />',
  '    <frame id="4:4" name="웹 관리자 화면" x="1300" y="100" width="375" height="800" />',
  '    <frame id="5:1" name="웹/홈" x="100" y="1000" width="1200" height="800" />',
  '    <frame id="5:2" name="모웹/홈" x="1400" y="1000" width="375" height="800" />',
  '    <frame id="5:3" name="아무 이름" x="2000" y="1000" width="100" height="100" />',
  '    <frame id="6:1" name="desc" x="3000" y="100" width="520" height="500">',
  '      <frame id="6:2" name="description_unit_card" x="0" y="0" width="520" height="100">',
  '        <text id="6:3" name="설명 한 줄" x="0" y="0" width="10" height="10" />',
  "      </frame>",
  "    </frame>",
  "  </section>",
  "</canvas>",
].join("\n");

/** get_metadata 결과 파일 모양: `[{type, text}]` JSON 배열. */
export const META_JSON = JSON.stringify([{ type: "text", text: NODES }, { type: "text", text: "IMPORTANT: call get_design_context next." }]);

export interface SeedCall {
  tool: string;
  input?: unknown;
  payload: string | Buffer;
  tool_use_id?: string;
  from_file?: boolean;
}

/** 수집 작업 폴더(work/collector-<n>/calls)에 받아 적은 호출을 심는다. 번호는 1 부터. */
export function seedCalls(runDir: string, calls: SeedCall[], n = 1): string {
  const dir = join(runDir, "work", `collector-${n}`, "calls");
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  calls.forEach((call, i) => {
    const bytes = typeof call.payload === "string" ? Buffer.from(call.payload, "utf8") : call.payload;
    writeFileSync(join(dir, `${String(i + 1).padStart(3, "0")}.payload`), bytes);
    lines.push(
      JSON.stringify({
        n: i + 1,
        tool: call.tool,
        input: call.input ?? {},
        tool_use_id: call.tool_use_id ?? `toolu_${i + 1}`,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        from_file: call.from_file ?? false,
        at: "2026-11-14T00:00:00.000Z",
      }),
    );
  });
  writeFileSync(join(dir, "index.jsonl"), `${lines.join("\n")}\n`);
  return dir;
}
