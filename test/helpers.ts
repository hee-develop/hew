/** 테스트 공용 도우미: 임시 HEW_RUNS_DIR, 상태를 정해 둔 실행 만들기. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { initRun } from "../src/core/init.js";
import { loadRun, saveRun, type Run } from "../src/core/run.js";
import type { RunState } from "../src/core/state-machine.js";

export const PRD_URL = "https://example.atlassian.net/wiki/spaces/X/pages/123/T";

/** 각 테스트마다 임시 HEW_RUNS_DIR 를 쓰고 끝나면 지운다. */
export function useTempRunsDir(): { readonly dir: string } {
  const holder = { dir: "" };
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.HEW_RUNS_DIR;
    holder.dir = mkdtempSync(join(tmpdir(), "hew-test-"));
    process.env.HEW_RUNS_DIR = holder.dir;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.HEW_RUNS_DIR;
    else process.env.HEW_RUNS_DIR = previous;
    rmSync(holder.dir, { recursive: true, force: true });
  });
  return holder;
}

/** 실행을 만들고 run.json 을 원하는 상태·값으로 고쳐 둔다. */
export function makeRun(state: RunState = "init", patch: Partial<Run> = {}, runId = "t-1"): { dir: string; run: Run } {
  const { dir } = initRun({ prd: PRD_URL, runId });
  const run = saveRun(dir, { ...loadRun(dir), state, ...patch });
  return { dir, run };
}

export function writeItemsFile(dir: string, name: string, value: unknown): string {
  const file = join(dir, name);
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), "utf8");
  return file;
}
