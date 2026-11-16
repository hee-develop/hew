import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HewError } from "../src/core/errors.js";
import { MISTAKE_FOUND_BY, MISTAKE_TYPES, appendMistake, readMistakes } from "../src/core/mistakes.js";
import { runPaths } from "../src/core/paths.js";
import { makeRun, useTempRunsDir } from "./helpers.js";

useTempRunsDir();

const base = { found_stage: "sasu", cause_stage: "analysis", found_by: "sasu", type: "wrong_evidence", target: "요구-1", evidence: "인용이 원문에 없음" };

describe("실수 기록", () => {
  it("한 줄씩 덧붙이고 id 는 M-n 으로 센다", () => {
    const { dir } = makeRun("analyzed");
    const now = new Date("2026-11-14T00:00:00Z");
    const a = appendMistake(dir, base, now);
    const b = appendMistake(dir, { ...base, type: "visual_missed", target: "화면-1", versions: { role_sha: "abc", model: "m", effort: null }, case: "case-1" }, now);
    expect(a).toMatchObject({ id: "M-1", run_id: "t-1", at: "2026-11-14T00:00:00.000Z", ...base });
    expect(b).toMatchObject({ id: "M-2", type: "visual_missed", case: "case-1", versions: { role_sha: "abc", model: "m", effort: null } });
    const lines = readFileSync(runPaths(dir).mistakes, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(readMistakes(dir).map((m) => m.id)).toEqual(["M-1", "M-2"]);
  });

  it("열거값(found_by, type)이 틀리면 사용법 오류이고 아무것도 덧붙이지 않는다", () => {
    const { dir } = makeRun("analyzed");
    for (const patch of [{ found_by: "nobody" }, { type: "weird" }]) {
      try {
        appendMistake(dir, { ...base, ...patch });
        expect.unreachable();
      } catch (e) {
        expect((e as HewError).exitCode).toBe(2);
      }
    }
    expect(readMistakes(dir)).toEqual([]);
  });

  it("빈 단계·대상·근거는 거부한다", () => {
    const { dir } = makeRun("analyzed");
    expect(() => appendMistake(dir, { ...base, target: "" })).toThrow(/target/);
    expect(() => appendMistake(dir, { ...base, evidence: "" })).toThrow(/evidence/);
    expect(() => appendMistake(dir, { ...base, found_stage: "" })).toThrow(/found_stage/);
  });

  it("열거값은 명세 §12 와 같다", () => {
    expect([...MISTAKE_FOUND_BY]).toEqual(["check", "sasu", "human_gate", "replay_judge", "review", "qa", "post"]);
    expect(MISTAKE_TYPES).toHaveLength(11);
  });

  it("기록이 없으면 빈 목록", () => {
    const { dir } = makeRun("analyzed");
    expect(readMistakes(dir)).toEqual([]);
  });
});
