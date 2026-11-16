import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { runPaths } from "../src/core/paths.js";
import { NO_REVISION, computeRevision, normalizeForRevision } from "../src/core/revision.js";
import { makeRun, useTempRunsDir } from "./helpers.js";

useTempRunsDir();

function put(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value), "utf8");
}

describe("revision", () => {
  it("정본이 하나도 없으면 none", () => {
    const { dir } = makeRun();
    expect(computeRevision(dir)).toBe(NO_REVISION);
  });

  it("키 순서·비용·시각·세션 id·빈 값에 흔들리지 않는다", () => {
    const { dir } = makeRun();
    const p = runPaths(dir);
    put(p.analysis, { items: { b: 1, a: { x: "가", y: 2 } }, cost: { usd: 1 }, produced_by: { session_id: "s1" } });
    const first = computeRevision(dir);
    put(p.analysis, {
      items: { a: { y: 2, x: "가", empty: [], blank: "", nothing: null, nested: { e: [] } }, b: 1, updated_at: "2026-01-01" },
      cost: { usd: 9 },
      produced_by: { session_id: "s2" },
      attempt: 5,
    });
    expect(computeRevision(dir)).toBe(first);
    expect(first).not.toBe(NO_REVISION);
  });

  it("내용이 바뀌면 달라진다", () => {
    const { dir } = makeRun();
    const p = runPaths(dir);
    put(p.analysis, { items: { a: 1 } });
    const before = computeRevision(dir);
    put(p.analysis, { items: { a: 2 } });
    expect(computeRevision(dir)).not.toBe(before);
  });

  it("scenarios·plan·answers·manifest 가 들어가면 달라지고, answers·manifest 는 파일 전체를 쓴다", () => {
    const { dir } = makeRun();
    const p = runPaths(dir);
    put(p.analysis, { items: { a: 1 } });
    const r0 = computeRevision(dir);
    put(p.scenarios, { items: { s: 1 } });
    const r1 = computeRevision(dir);
    put(p.plan, { items: { t: 1 } });
    const r2 = computeRevision(dir);
    put(p.answers, { answers: [{ id: "Q-1", value: "예" }] });
    const r3 = computeRevision(dir);
    put(p.manifest, { sources: [{ id: "S-1", sha256: "abc" }] });
    const r4 = computeRevision(dir);
    expect(new Set([r0, r1, r2, r3, r4]).size).toBe(5);
    put(p.answers, { answers: [{ id: "Q-1", value: "아니오" }] });
    expect(computeRevision(dir)).not.toBe(r4);
  });

  it("envelope 의 items 밖(attempt, verdict)은 영향이 없다", () => {
    const { dir } = makeRun();
    const p = runPaths(dir);
    put(p.plan, { items: { t: 1 }, attempt: 1, verdict: { status: "pass" } });
    const a = computeRevision(dir);
    put(p.plan, { items: { t: 1 }, attempt: 2, verdict: { status: "blocked" } });
    expect(computeRevision(dir)).toBe(a);
  });

  it("0 과 false 는 빈 값이 아니다", () => {
    expect(normalizeForRevision({ a: 0, b: false, c: [], d: "" })).toEqual({ a: 0, b: false });
  });
});
