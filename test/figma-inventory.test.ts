import { describe, expect, it } from "vitest";
import { inventoryFileFromContent, platformOf } from "../src/core/figma/inventory.js";
import { canvasTextsFromFile, parseMetadataText } from "../src/core/figma/metadata.js";
import { normalizeNodeId } from "../src/core/figma/node-ref.js";
import { FIGMA_META_JSON } from "./source-fixtures.js";

describe("Figma 메타데이터 파서", () => {
  it("배열 자리를 가정하지 않고 <canvas 로 시작하는 text 를 찾는다", () => {
    const texts = canvasTextsFromFile(FIGMA_META_JSON);
    expect(texts).toHaveLength(1);
    expect(texts[0]?.startsWith("<canvas")).toBe(true);
    expect(canvasTextsFromFile(JSON.stringify([{ type: "text", text: texts[0] }]))).toHaveLength(1);
  });

  it("깊이는 들여쓰기 2칸, 좌표 없는 노드와 제어 문자 이름도 읽는다", () => {
    const nodes = parseMetadataText(canvasTextsFromFile(FIGMA_META_JSON)[0] as string);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get("1:1")?.depth).toBe(0);
    expect(byId.get("2:1")?.depth).toBe(1);
    expect(byId.get("4:1")?.depth).toBe(2);
    expect(byId.get("4:2")?.depth).toBe(3);
    expect(byId.get("5:3")?.x).toBeUndefined();
    expect(byId.get("4:3")?.name).toBe("App/홈");
    expect(byId.get("6:5")?.hidden).toBe(true);
  });
});

describe("플랫폼 판정", () => {
  it.each([
    ["앱/홈", "app"],
    ["App/홈", "app"],
    ["모웹/홈", "mobile_web"],
    ["mweb/x", "mobile_web"],
    ["Mobile Web/x", "mobile_web"],
    ["웹/홈", "web"],
    ["WEB/x", "web"],
    ["판매자 스토어", "unknown"],
  ])("%s → %s", (name, platform) => {
    expect(platformOf(name)).toBe(platform);
  });
});

describe("화면 목록", () => {
  const inv = inventoryFileFromContent("S-3", "FigmaFileKeyExample001", FIGMA_META_JSON);
  const frame = (id: string) => inv.frames.find((f) => f.node_id === id);

  it("캔버스와 프레임 목록, 파일 키", () => {
    expect(inv.file_key).toBe("FigmaFileKeyExample001");
    expect(inv.canvases).toEqual([{ node_id: "1:1", name: "샘플 캔버스" }]);
    expect(inv.frames.map((f) => f.node_id)).toEqual(["4:1", "4:3", "5:1", "5:2", "5:3", "5:4", "6:2"]);
  });

  it("접두사로 플랫폼을 가르고 좌표 없는 프레임은 box 가 없다", () => {
    expect(inv.frames.map((f) => f.platform)).toEqual(["app", "app", "web", "mobile_web", "mobile_web", "unknown", "unknown"]);
    expect(frame("4:1")?.box).toEqual({ x: 100, y: 100, w: 375, h: 800 });
    expect(frame("5:3")?.box).toBeUndefined();
    expect(frame("4:1")?.section).toBe("섹션 A");
  });

  it("라벨 텍스트로 role 을 정하고 나란한 as-is·to-be 를 pair 로 잇는다", () => {
    expect(frame("4:1")).toMatchObject({ role: "as_is", pair: "4:3" });
    expect(frame("4:3")).toMatchObject({ role: "to_be", pair: "4:1" });
    expect(frame("5:1")?.role).toBeUndefined();
    expect(frame("5:1")?.pair).toBeUndefined();
  });

  it("설명 카드는 is_desc 이고 text 는 숨김을 뺀 텍스트 노드 이름", () => {
    expect(frame("6:2")).toMatchObject({ is_desc: true, text: "첫 줄 설명\n둘째 줄 설명" });
    expect(inv.frames.some((f) => f.node_id === "6:1")).toBe(false);
  });
});

describe("노드 참조", () => {
  it.each([
    ["12:34", "12:34"],
    ["FigmaFileKeyExample001:12:34", "12:34"],
    ["12-34", "12:34"],
    ["https://www.figma.com/design/FigmaFileKeyExample001/x?node-id=12-34", "12:34"],
  ])("%s", (value, node) => {
    expect(normalizeNodeId(value)).toBe(node);
  });
  it("읽을 수 없으면 undefined", () => {
    expect(normalizeNodeId("abc")).toBeUndefined();
  });
});
