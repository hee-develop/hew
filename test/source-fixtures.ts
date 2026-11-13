/** 소스·단위·Figma 테스트용 합성 자료와 파일 쓰기 도우미. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PRD_MD = `## Overview

| **Initiative** | [ABC-1](https://example.test/browse/ABC-1) |
| --- | --- |
| **Squad** | 샘플 스쿼드 |
| **2-Pager** |  |

## 목적

### 배경

- 첫째 항목
  - 하위 항목 가나
  - 하위 항목 다라
- 둘째 항목

본문 문단 하나입니다.
같은 문단의 둘째 줄입니다.

---

#### 세부

두 번째 문단입니다.

## Requirements

| # | **User Journey** | 기능 | 논의사항 |
| --- | --- | --- | --- |
| 1 | 판매자가 홈에서 배너를 본다 | 배너를 노출한다<br>탭하면 이동한다 | |
| 2 | 운영자가 배너를 등록한다 | 어드민에서 입력한다 | 확인 필요 |
| 3 | 사내 어드민이 승인한다 | 승인 | |
| 4 | 구매자가 결제한다 | 결제 | |
| 5 | 시스템이 정산한다 | 정산 | |
| | | | |

디자인: https://www.figma.com/design/FigmaFileKeyExample001/sample?node-id=1-92
`;

export const NO_ACTOR_MD = `## 표

| 항목 | 설명 |
| --- | --- |
| 가 | 나 |
`;

const ASIS_TOBE = [
  '<canvas id="1:1" name="샘플 캔버스" x="0" y="0" width="0" height="0">',
  '  <section id="2:1" name="섹션 A" x="0" y="0" width="5000" height="3000">',
  '    <instance id="3:1" name="asis_tobe_label" x="100" y="20" width="375" height="40">',
  '      <text id="3:2" name="AS-IS" x="0" y="0" width="50" height="20" />',
  "    </instance>",
  '    <instance id="3:3" name="asis_tobe_label" x="600" y="20" width="375" height="40">',
  '      <text id="3:4" name="TO-BE" x="0" y="0" width="50" height="20" />',
  "    </instance>",
  '    <frame id="4:1" name="앱/홈" x="100" y="100" width="375" height="800">',
  '      <text id="4:2" name="홈 제목" x="0" y="0" width="100" height="20" />',
  "    </frame>",
  '    <frame id="4:3" name="\u0008App/홈" x="600" y="100" width="375" height="800" />',
  '    <frame id="5:1" name="웹/홈" x="100" y="1000" width="1200" height="800" />',
  '    <frame id="5:2" name="Mobile Web/홈" x="1400" y="1000" width="375" height="800" />',
  '    <frame id="5:3" name="모웹/목록" />',
  '    <frame id="5:4" name="그냥 프레임" x="2000" y="1000" width="100" height="100" />',
  '    <frame id="6:1" name="desc" x="3000" y="100" width="520" height="500">',
  '      <frame id="6:2" name="description_unit_card" x="0" y="0" width="520" height="100">',
  '        <text id="6:3" name="첫 줄 설명" x="0" y="0" width="10" height="10" />',
  '        <text id="6:4" name="둘째 줄 설명" x="0" y="0" width="10" height="10" />',
  '        <text id="6:5" name="숨김 글" x="0" y="0" width="10" height="10" hidden="true" />',
  "      </frame>",
  "    </frame>",
  "  </section>",
  "</canvas>",
].join("\n");

/** get_metadata 결과 원본 모양: 선택 노드 블록이 앞에 있고 canvas 가 두 번째다. */
export const FIGMA_META_JSON = JSON.stringify([
  { type: "text", text: "Currently selected nodes:\n<frame id=\"9:9\" name=\"선택\" />" },
  { type: "text", text: ASIS_TOBE },
  { type: "text", text: "IMPORTANT: call get_design_context next." },
]);

export function writeFixture(dir: string, name: string, content: string | Buffer): string {
  const file = join(dir, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}
