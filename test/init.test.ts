import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HewError } from "../src/core/errors.js";
import { readEvents } from "../src/core/events.js";
import { initRun, shortIdFromUrl } from "../src/core/init.js";
import { resolveRunDir, runPaths, runsRoot } from "../src/core/paths.js";
import { loadRun } from "../src/core/run.js";
import { PRD_URL, useTempRunsDir } from "./helpers.js";

const runs = useTempRunsDir();

const usageCode = (fn: () => unknown): number | null => {
  try {
    fn();
  } catch (error) {
    return error instanceof HewError ? error.exitCode : -1;
  }
  return null;
};

describe("init", () => {
  it("실행 폴더 구조(§1.2)와 run.json(state=init)을 만든다", () => {
    const { dir } = initRun({ prd: PRD_URL, runId: "spike-1", repo: "/repo", base: "develop" });
    expect(dir).toBe(join(runs.dir, "spike-1"));
    const p = runPaths(dir);
    for (const sub of ["prd", "figma", "code", "openapi", "related"]) expect(statSync(join(p.sources, sub)).isDirectory()).toBe(true);
    for (const d of [p.packets, p.work, p.doc, p.findingsDir, p.gate, p.gateAssets]) expect(statSync(d).isDirectory()).toBe(true);
    for (const f of [p.runJson, p.events, p.costs, p.mistakes]) expect(existsSync(f)).toBe(true);
    const run = loadRun(dir);
    expect(run).toMatchObject({
      run_id: "spike-1",
      mode: "live",
      state: "init",
      revision: "none",
      input: { kind: "prd", url: PRD_URL },
      repo: { path: "/repo", base: "develop" },
      case: null,
      rework: { analysis: 0, plan: 0 },
      open: 0,
      submissions: {},
    });
    expect(run.created_at).toBe(run.updated_at);
  });

  it("run_created 이벤트를 남긴다", () => {
    const { dir } = initRun({ ticket: "https://x.atlassian.net/browse/APP-3372", runId: "a" });
    const events = readEvents(runPaths(dir).events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "run_created", data: { run_id: "a" } });
    expect(typeof events[0]?.ts).toBe("string");
  });

  it("run.json 쓰기 뒤 임시 파일이 남지 않는다(원자적 쓰기)", () => {
    const { dir } = initRun({ prd: PRD_URL, runId: "a" });
    expect(readFileSync(runPaths(dir).runJson, "utf8").endsWith("\n")).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("기본 run_id 는 날짜-식별자-일련번호이고 일련번호가 증가한다", () => {
    const now = new Date(2026, 10, 14, 9, 0, 0);
    const a = initRun({ prd: PRD_URL, now });
    const b = initRun({ prd: PRD_URL, now });
    expect(a.run_id).toBe("20261114-123-1");
    expect(b.run_id).toBe("20261114-123-2");
  });

  it("URL 에서 짧은 식별자를 뽑는다", () => {
    expect(shortIdFromUrl("https://x.atlassian.net/browse/APP-3008")).toBe("APP-3008");
    expect(shortIdFromUrl(PRD_URL)).toBe("123");
    expect(shortIdFromUrl("https://example.com/docs/guide")).toBe("guide");
    expect(shortIdFromUrl("https://example.com/")).toBe("run");
  });

  it("replay 는 --case 와 함께 받는다", () => {
    const file = join(runs.dir, "a.yaml");
    writeFileSync(file, "story: APP-1\n");
    const { run } = initRun({ prd: PRD_URL, mode: "replay", case: file, runId: "r" });
    expect(run).toMatchObject({ mode: "replay", case: file, case_info: { story: "APP-1" } });
  });

  describe("인자 오류는 종료 2", () => {
    it("--prd 와 --ticket 이 모두 없음", () => expect(usageCode(() => initRun({}))).toBe(2));
    it("--prd 와 --ticket 이 둘 다 있음", () => expect(usageCode(() => initRun({ prd: PRD_URL, ticket: PRD_URL }))).toBe(2));
    it("replay 인데 --case 가 없음", () => expect(usageCode(() => initRun({ prd: PRD_URL, mode: "replay" }))).toBe(2));
    it("알 수 없는 mode", () => expect(usageCode(() => initRun({ prd: PRD_URL, mode: "fast" }))).toBe(2));
    it("URL 이 아님", () => expect(usageCode(() => initRun({ prd: "nope" }))).toBe(2));
    it("http 가 아닌 URL", () => expect(usageCode(() => initRun({ prd: "ftp://x/y" }))).toBe(2));
    it("run-id 에 경로 문자가 있음", () => expect(usageCode(() => initRun({ prd: PRD_URL, runId: "../x" }))).toBe(2));
    it("이미 있는 run-id", () => {
      initRun({ prd: PRD_URL, runId: "dup" });
      expect(usageCode(() => initRun({ prd: PRD_URL, runId: "dup" }))).toBe(2);
    });
  });
});

describe("paths", () => {
  it("HEW_RUNS_DIR 가 실행 폴더 뿌리다", () => {
    expect(runsRoot()).toBe(runs.dir);
  });
  it("HEW_RUNS_DIR 가 없으면 ~/hew-runs", () => {
    const saved = process.env.HEW_RUNS_DIR;
    delete process.env.HEW_RUNS_DIR;
    try {
      expect(runsRoot().endsWith("/hew-runs")).toBe(true);
    } finally {
      process.env.HEW_RUNS_DIR = saved;
    }
  });
  it("--run 은 run_id 또는 폴더 경로를 받는다", () => {
    expect(resolveRunDir("abc")).toBe(join(runs.dir, "abc"));
    expect(resolveRunDir(join(runs.dir, "abc"))).toBe(join(runs.dir, "abc"));
    expect(resolveRunDir("./abc")).toBe(join(process.cwd(), "abc"));
  });
  it("없는 실행은 loadRun 에서 종료 2", () => {
    expect(usageCode(() => loadRun(resolveRunDir("none")))).toBe(2);
  });
});
