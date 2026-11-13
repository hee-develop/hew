import { describe, expect, it } from "vitest";
import { findActorColumn, judgeActor } from "../src/core/units/actor.js";
import { markdownFromSource } from "../src/core/units/extract.js";
import { parseMarkdownUnits } from "../src/core/units/markdown.js";
import { NO_ACTOR_MD, PRD_MD } from "./source-fixtures.js";

describe("문서 단위: 제목·글머리표·문단", () => {
  const units = parseMarkdownUnits(PRD_MD);
  const nonTable = units.filter((u) => u.kind !== "table_row");

  it("제목은 단위가 아니라 locator.section 경로가 된다", () => {
    expect(nonTable.map((u) => u.locator.section)).toEqual([
      ["목적", "배경"],
      ["목적", "배경"],
      ["목적", "배경"],
      ["목적", "배경"],
      ["목적", "배경"],
      ["목적", "배경", "세부"],
      ["Requirements"],
    ]);
  });

  it("글머리표와 하위 항목은 각각 단위이고 index 가 순서를 나타낸다", () => {
    const bullets = nonTable.filter((u) => u.kind === "bullet");
    expect(bullets.map((b) => b.text)).toEqual(["첫째 항목", "하위 항목 가나", "하위 항목 다라", "둘째 항목"]);
    expect(bullets.map((b) => b.locator.index)).toEqual([1, 2, 3, 4]);
  });

  it("문단 하나가 단위 하나이고 빈 줄·구분선은 건너뛴다", () => {
    const paragraphs = nonTable.filter((u) => u.kind === "paragraph");
    expect(paragraphs.map((p) => p.text)).toEqual([
      "본문 문단 하나입니다.\n같은 문단의 둘째 줄입니다.",
      "두 번째 문단입니다.",
      expect.stringContaining("figma.com"),
    ]);
  });

  it("2열 속성 표는 {이름: 값} 행 단위이고 값이 빈 행은 건너뛴다", () => {
    const attrs = units.filter((u) => u.locator.table === 1);
    expect(attrs.map((a) => a.columns)).toEqual([
      { Initiative: "[ABC-1](https://example.test/browse/ABC-1)" },
      { Squad: "샘플 스쿼드" },
    ]);
    expect(attrs[0]?.actor).toBeUndefined();
  });

  it("2열 표에서 첫 칸이 굵지 않으면 머리글 있는 표로 보되 첫 행도 단위로 싣는다", () => {
    const rows = parseMarkdownUnits(NO_ACTOR_MD);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ columns: { 항목: "설명" }, locator: { row: 0 } });
    expect(rows[1]).toMatchObject({ columns: { 항목: "가", 설명: "나" }, text: "항목: 가\n설명: 나" });
  });

  it("같은 입력은 항상 같은 결과", () => {
    expect(parseMarkdownUnits(PRD_MD)).toEqual(parseMarkdownUnits(PRD_MD));
  });
});

describe("문서 단위: 표 행과 주체", () => {
  const rows = parseMarkdownUnits(PRD_MD).filter((u) => u.locator.table === 2);

  it("데이터 행 하나가 단위 하나이고 내용 없는 행은 건너뛴다", () => {
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.locator.row)).toEqual([1, 2, 3, 4, 5]);
    expect(rows[0]?.locator.section).toEqual(["Requirements"]);
  });

  it("columns 와 text 는 머리글: 내용이고 <br> 은 줄바꿈이 된다", () => {
    expect(rows[0]?.columns).toEqual({
      "#": "1",
      "User Journey": "판매자가 홈에서 배너를 본다",
      기능: "배너를 노출한다\n탭하면 이동한다",
    });
    expect(rows[0]?.text).toBe("#: 1\nUser Journey: 판매자가 홈에서 배너를 본다\n기능: 배너를 노출한다\n탭하면 이동한다");
  });

  it("주체 열에서 operator·provider·customer 를 판정하고 그 밖은 비운다", () => {
    expect(rows.map((r) => r.actor)).toEqual(["provider", "operator", "operator", "customer", undefined]);
    expect(rows[1]?.actor_raw).toBe("운영자가 배너를 등록한다");
    expect(rows[4]?.actor_raw).toBe("시스템이 정산한다");
  });

  it("주체 열이 없는 표의 단위에는 actor 를 넣지 않는다", () => {
    expect(parseMarkdownUnits(NO_ACTOR_MD)[0]).not.toHaveProperty("actor_raw");
  });
});

describe("주체 판정 규칙", () => {
  it("머리글은 대소문자·굵게 표시와 무관하게 찾는다", () => {
    expect(findActorColumn(["#", "**USER JOURNEY**"])).toBe(1);
    expect(findActorColumn(["주체", "x"])).toBe(0);
    expect(findActorColumn(["Actor"])).toBe(0);
    expect(findActorColumn(["사용자"])).toBe(0);
    expect(findActorColumn(["기능"])).toBe(-1);
  });

  it.each([
    ["Admin 이 승인한다", "operator"],
    ["관리자", "operator"],
    ["판매자가 운영자에게 요청", "provider"],
    ["사내 어드민", "operator"],
    ["구매자", "customer"],
    ["enforcement", undefined],
    ["—", undefined],
  ])("%s → %s", (cell, expected) => {
    expect(judgeActor(cell)).toBe(expected);
  });
});

describe("JSON 원본에서 Markdown 꺼내기", () => {
  it("[{type:text,text}] 배열", () => {
    const json = JSON.stringify([{ type: "text", text: "## 제목\n\n문단" }]);
    expect(markdownFromSource(json, "x.json")).toBe("## 제목\n\n문단");
  });

  it("body·description 칸이 든 객체", () => {
    expect(markdownFromSource(JSON.stringify({ id: 1, body: "본문 MD" }), "x.json")).toBe("본문 MD");
    expect(markdownFromSource(JSON.stringify({ fields: { description: "설명 MD" } }), "x.json")).toBe("설명 MD");
  });

  it("text 안에 JSON 문자열로 든 객체", () => {
    const inner = JSON.stringify({ description: "- 항목" });
    expect(markdownFromSource(JSON.stringify([{ type: "text", text: inner }]), "x.json")).toBe("- 항목");
  });

  it(".json 이 아니면 내용 그대로", () => {
    expect(markdownFromSource("[a](b)", "x.md")).toBe("[a](b)");
  });
});

describe("굵은 표시가 없는 2열 표", () => {
  it("첫 행도 단위로 싣는다", () => {
    const md = ["## Overview", "", "| Initiative | APP-1 |", "| --- | --- |", "| Squad | 예시 스쿼드 |"].join("\n");
    const units = parseMarkdownUnits(md);
    const texts = units.map((u) => u.text);
    expect(units).toHaveLength(2);
    expect(texts).toContain("Initiative: APP-1");
    expect(texts).toContain("Initiative: Squad\nAPP-1: 예시 스쿼드");
  });
});
