#!/usr/bin/env node
/** Claude Code PostToolUse 훅: 도구 결과를 원문 그대로 HEW_RECORD_DIR 에 받아 적는다. 어떤 경우에도 종료 0 이고 stdout 에 쓰지 않는다. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const NOTICE = /^Error: result \([^)]*\) exceeds maximum allowed tokens\. Output has been saved to (.+?)\.?[ \t]*(?:\r?\n|$)/;

/** 응답이 큰 결과 안내문이면 결과 파일 경로를, 아니면 null. */
export function savedPathOf(response) {
  if (typeof response !== "string") return null;
  const m = NOTICE.exec(response);
  return m === null ? null : m[1];
}

const pad = (n) => String(n).padStart(3, "0");

function countLines(file) {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0).length;
}

/** 훅 입력 하나를 받아 적는다. 받아 적은 번호를 돌려주고, 환경 변수가 없으면 null. */
export function record(payload, env = process.env) {
  const dir = env.HEW_RECORD_DIR;
  if (typeof dir !== "string" || dir.length === 0) return null;
  const response = payload?.tool_response;
  let bytes;
  let fromFile = false;
  let error;
  const saved = savedPathOf(response);
  if (saved !== null) {
    try {
      bytes = readFileSync(saved);
      fromFile = true;
    } catch (e) {
      bytes = Buffer.from(response, "utf8");
      error = `결과 파일을 읽지 못했습니다: ${saved} (${e instanceof Error ? e.message : String(e)})`;
    }
  } else if (typeof response === "string") {
    bytes = Buffer.from(response, "utf8");
  } else {
    bytes = Buffer.from(JSON.stringify(response === undefined ? null : response), "utf8");
  }
  mkdirSync(dir, { recursive: true });
  const index = join(dir, "index.jsonl");
  let n = countLines(index) + 1;
  for (;;) {
    try {
      writeFileSync(join(dir, `${pad(n)}.payload`), bytes, { flag: "wx" });
      break;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      n += 1;
    }
  }
  const line = {
    n,
    tool: payload?.tool_name ?? null,
    input: payload?.tool_input ?? null,
    tool_use_id: payload?.tool_use_id ?? null,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    from_file: fromFile,
    at: new Date().toISOString(),
    ...(error === undefined ? {} : { error }),
  };
  appendFileSync(index, `${JSON.stringify(line)}\n`, "utf8");
  return n;
}

function readStdin() {
  return new Promise((done) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => done(""));
  });
}

async function main() {
  try {
    const text = await readStdin();
    record(JSON.parse(text), process.env);
  } catch {
    // 도구 흐름을 막지 않는다
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
