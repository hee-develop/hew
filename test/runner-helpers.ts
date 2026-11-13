/** 실행기·패킷 테스트 공용: 가짜 claude 래퍼, 가짜 heka, 예시 분석 문서 경로. */
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEW_ROOT } from "../src/core/paths.js";
import type { Unit } from "../src/core/units/types.js";

export const EXAMPLE_DOC = join(HEW_ROOT, "refs", "analysis.example.json");
export const EXAMPLE_UNITS = join(HEW_ROOT, "refs", "analysis.example.units.json");
export const FAKE_HEKA = join(import.meta.dirname, "fake-heka.mjs");

export const exampleUnits = (): Unit[] => (JSON.parse(readFileSync(EXAMPLE_UNITS, "utf8")) as { units: Unit[] }).units;

/** 가짜 claude 를 부르는 셸 래퍼를 만들고 경로를 돌려준다. */
export function makeFakeClaude(): string {
  const dir = mkdtempSync(join(tmpdir(), "hew-fake-claude-"));
  const wrapper = join(dir, "claude");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fake-claude.mjs")}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

export interface FakeCall {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

/** 가짜 claude 가 남긴 호출 기록을 순서대로 읽는다. */
export function readCalls(logDir: string): FakeCall[] {
  return readdirSync(logDir)
    .filter((n) => n.startsWith("call-"))
    .sort((a, b) => Number(a.slice(5, -5)) - Number(b.slice(5, -5)))
    .map((n) => JSON.parse(readFileSync(join(logDir, n), "utf8")) as FakeCall);
}

export const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
