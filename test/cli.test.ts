import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runPaths } from "../src/core/paths.js";
import { loadRun } from "../src/core/run.js";
import { PRD_URL, makeRun, useTempRunsDir, writeItemsFile } from "./helpers.js";

const runs = useTempRunsDir();
const BIN = join(import.meta.dirname, "..", "bin", "hew");

function hew(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(BIN, args, { env: { ...process.env, HEW_RUNS_DIR: runs.dir }, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const parse = (stdout: string) => {
  expect(stdout.trim().split("\n")).toHaveLength(1);
  return JSON.parse(stdout) as { ok: boolean; data: any; warnings: any[]; errors: any[] };
};

describe("CLI 계약(자식 프로세스)", () => {
  it("--json init 은 한 줄 {ok,data,warnings,errors} 와 종료 0, 폴더 생성", () => {
    const r = hew(["--json", "init", "--prd", PRD_URL, "--run-id", "spike-1"]);
    expect(r.code).toBe(0);
    const body = parse(r.stdout);
    expect(Object.keys(body).sort()).toEqual(["data", "errors", "ok", "warnings"]);
    expect(body).toMatchObject({ ok: true, warnings: [], errors: [], data: { run_id: "spike-1", state: "init" } });
    expect(existsSync(join(runs.dir, "spike-1", "run.json"))).toBe(true);
  });

  it("init 인자 오류는 종료 2 이고 errors 에 담긴다", () => {
    const r = hew(["--json", "init"]);
    expect(r.code).toBe(2);
    const body = parse(r.stdout);
    expect(body.ok).toBe(false);
    expect(body.data).toBeNull();
    expect(body.errors[0].code).toBe("usage");
  });

  it("replay 인데 --case 가 없으면 종료 2", () => {
    expect(hew(["--json", "init", "--prd", PRD_URL, "--mode", "replay"]).code).toBe(2);
  });

  it("사람이 읽는 출력은 한국어 문장이고 JSON 이 아니다", () => {
    const r = hew(["init", "--prd", PRD_URL, "--run-id", "h-1"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("실행 폴더를 만들었습니다");
    expect(() => JSON.parse(r.stdout)).toThrow();
  });

  it("status 와 next", () => {
    hew(["init", "--prd", PRD_URL, "--run-id", "s-1"]);
    const status = parse(hew(["--json", "status", "--run", "s-1"]).stdout);
    expect(status.data).toMatchObject({ run_id: "s-1", state: "init", revision: "none", open: 0, rework: { analysis: 0, plan: 0 }, submissions: {} });
    const next = parse(hew(["--json", "next", "--run", join(runs.dir, "s-1")]).stdout);
    expect(next.data).toEqual({ state: "init", next: { action: "spawn", role: "collector", purpose: "first" } });
  });

  it("next 는 아무것도 바꾸지 않는다", () => {
    hew(["init", "--prd", PRD_URL, "--run-id", "n-1"]);
    const file = runPaths(join(runs.dir, "n-1")).runJson;
    const before = readFileSync(file, "utf8");
    hew(["next", "--run", "n-1"]);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("없는 실행은 종료 2", () => {
    expect(hew(["--json", "status", "--run", "nope"]).code).toBe(2);
  });

  it("알 수 없는 명령은 종료 2", () => {
    expect(hew(["--json", "bogus"]).code).toBe(2);
  });

  it("submit 통과는 종료 0, 상태에 맞지 않으면 종료 4", () => {
    const { dir } = makeRun("collected", {}, "sub-1");
    const file = writeItemsFile(dir, "in.json", { a: 1 });
    const ok = hew(["--json", "submit", "analysis", "--run", "sub-1", "--file", file]);
    expect(ok.code).toBe(0);
    expect(parse(ok.stdout).data).toMatchObject({ kind: "analysis", attempt: 1, previous_state: "collected", state: "analyzed" });
    const bad = hew(["--json", "submit", "analysis", "--run", "sub-1", "--file", file]);
    expect(bad.code).toBe(4);
    expect(parse(bad.stdout).errors[0].code).toBe("state");
    expect(loadRun(dir).state).toBe("analyzed");
  });

  it("submit 의 잘못된 JSON 은 종료 3", () => {
    const { dir } = makeRun("collected", {}, "sub-2");
    const file = writeItemsFile(dir, "bad.json", "{oops");
    const r = hew(["--json", "submit", "analysis", "--run", "sub-2", "--file", file]);
    expect(r.code).toBe(3);
    expect(parse(r.stdout).errors.map((e: any) => e.code)).toContain("json_parse");
  });

  it("submit --withdraw 는 경고를 낸다", () => {
    const { dir } = makeRun("collected", {}, "sub-3");
    const file = writeItemsFile(dir, "in.json", {});
    const r = hew(["--json", "submit", "analysis", "--run", "sub-3", "--file", file, "--withdraw", "Q-1,Q-2"]);
    expect(r.code).toBe(0);
    expect(parse(r.stdout).warnings.map((w: any) => w.code)).toEqual(["withdraw_unsupported"]);
  });

  it("submit 종류가 잘못되면 종료 2", () => {
    makeRun("collected", {}, "sub-4");
    expect(hew(["--json", "submit", "weird", "--run", "sub-4", "--file", "x"]).code).toBe(2);
  });

  it("submit findings 에 --for 가 없으면 종료 2", () => {
    const { dir } = makeRun("qa_designed", {}, "sub-5");
    const file = writeItemsFile(dir, "f.json", { findings: [] });
    expect(hew(["--json", "submit", "findings", "--run", "sub-5", "--file", file]).code).toBe(2);
  });
});
