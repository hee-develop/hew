import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { record, savedPathOf } from "../hooks/record.mjs";

const HOOK = join(import.meta.dirname, "..", "hooks", "record.mjs");

let base = "";
let dir = "";
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "hew-record-"));
  dir = join(base, "calls");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const index = (): Record<string, any>[] =>
  readFileSync(join(dir, "index.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);

const notice = (file: string): string =>
  `Error: result (815,796 characters) exceeds maximum allowed tokens. Output has been saved to ${file}.\nFormat: JSON array with schema: [{type: string, text: string}]\n- 안내 문구`;

const payload = (tool = "mcp__x__y", response: unknown = "본문") => ({
  tool_name: tool,
  tool_input: { a: 1 },
  tool_response: response,
  tool_use_id: "toolu_1",
  session_id: "s",
  transcript_path: "/t",
  cwd: "/c",
});

const run = (stdin: string, env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [HOOK], { input: stdin, encoding: "utf8", env: { ...process.env, HEW_RECORD_DIR: "", ...env } });

describe("record 훅: 받아 적기", () => {
  it("작은 결과는 문자열 그대로 001.payload 에 쓰고 index 에 한 줄 남긴다", () => {
    const text = JSON.stringify({ content: { nodes: [{ id: "1", body: "가나다\n" }] } });
    expect(record(payload("mcp__a__get", text), { HEW_RECORD_DIR: dir })).toBe(1);
    const bytes = Buffer.from(text, "utf8");
    expect(readFileSync(join(dir, "001.payload"))).toEqual(bytes);
    expect(index()).toEqual([
      expect.objectContaining({ n: 1, tool: "mcp__a__get", input: { a: 1 }, tool_use_id: "toolu_1", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), from_file: false }),
    ]);
    expect(typeof index()[0]?.at).toBe("string");
    expect(index()[0]).not.toHaveProperty("error");
  });

  it("큰 결과 안내문이면 그 경로의 파일 내용을 바이트 그대로 받아 적는다", () => {
    const file = join(base, "tool-results", "mcp-figma.txt");
    const bytes = Buffer.concat([Buffer.from("[{\"type\":\"text\",\"text\":\"한글\"}]"), Buffer.from([0x0d, 0x0a])]);
    mkdirSync(join(base, "tool-results"), { recursive: true });
    writeFileSync(file, bytes);
    record(payload("mcp__figma__get_metadata", notice(file)), { HEW_RECORD_DIR: dir });
    expect(readFileSync(join(dir, "001.payload"))).toEqual(bytes);
    expect(index()[0]).toMatchObject({ n: 1, from_file: true, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(index()[0]).not.toHaveProperty("error");
  });

  it("안내문의 파일을 읽지 못하면 안내문을 그대로 저장하고 error 에 사유를 남긴다", () => {
    const text = notice(join(base, "없는", "파일.txt"));
    record(payload("mcp__a__b", text), { HEW_RECORD_DIR: dir });
    expect(readFileSync(join(dir, "001.payload"), "utf8")).toBe(text);
    expect(index()[0]).toMatchObject({ from_file: false });
    expect(index()[0]?.error).toContain("읽지 못했습니다");
  });

  it("문자열이 아닌 응답은 JSON 으로 직렬화해 쓴다", () => {
    record(payload("mcp__a__b", [{ type: "text", text: "x" }]), { HEW_RECORD_DIR: dir });
    expect(readFileSync(join(dir, "001.payload"), "utf8")).toBe('[{"type":"text","text":"x"}]');
    record(payload("mcp__a__b", { ok: true }), { HEW_RECORD_DIR: dir });
    expect(readFileSync(join(dir, "002.payload"), "utf8")).toBe('{"ok":true}');
  });

  it("HEW_RECORD_DIR 가 없으면 아무것도 하지 않는다", () => {
    expect(record(payload(), {})).toBeNull();
    expect(record(payload(), { HEW_RECORD_DIR: "" })).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  it("번호는 index 의 줄 수 + 1 로 늘어난다", () => {
    for (let i = 0; i < 3; i += 1) record(payload("mcp__a__b", `r${i}`), { HEW_RECORD_DIR: dir });
    expect(index().map((l) => l.n)).toEqual([1, 2, 3]);
    expect(readFileSync(join(dir, "003.payload"), "utf8")).toBe("r2");
  });

  it("이미 있는 번호 파일은 덮어쓰지 않고 다음 번호로 간다", () => {
    record(payload("mcp__a__b", "첫째"), { HEW_RECORD_DIR: dir });
    writeFileSync(join(dir, "002.payload"), "남이 쓴 것");
    record(payload("mcp__a__b", "둘째"), { HEW_RECORD_DIR: dir });
    expect(readFileSync(join(dir, "002.payload"), "utf8")).toBe("남이 쓴 것");
    expect(readFileSync(join(dir, "003.payload"), "utf8")).toBe("둘째");
    expect(index().map((l) => l.n)).toEqual([1, 3]);
  });

  it("안내문 경로 끝의 마침표는 경로가 아니다", () => {
    expect(savedPathOf(notice("/a/b/c.txt"))).toBe("/a/b/c.txt");
    expect(savedPathOf("Error: 다른 오류")).toBeNull();
    expect(savedPathOf(42)).toBeNull();
  });
});

describe("record 훅: 프로세스", () => {
  it("stdin 입력을 받아 적고 종료 0, stdout 은 비어 있다", () => {
    const r = run(JSON.stringify(payload("mcp__a__b", "x")), { HEW_RECORD_DIR: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(readFileSync(join(dir, "001.payload"), "utf8")).toBe("x");
  });

  it("깨진 입력이나 환경 변수 없음에도 종료 0 이고 stdout 이 비어 있다", () => {
    for (const r of [run("not json", { HEW_RECORD_DIR: dir }), run("", { HEW_RECORD_DIR: dir }), run(JSON.stringify(payload()), {})]) {
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
    expect(existsSync(join(dir, "001.payload"))).toBe(false);
  });

  it("받아 적을 폴더를 만들 수 없어도 종료 0", () => {
    const blocker = join(base, "file");
    writeFileSync(blocker, "x");
    const r = run(JSON.stringify(payload()), { HEW_RECORD_DIR: join(blocker, "sub") });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});

