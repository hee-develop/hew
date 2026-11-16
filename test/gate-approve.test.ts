import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { approveRun } from "../src/core/gate/approve.js";
import { buildGate } from "../src/core/gate/build.js";
import { HewError } from "../src/core/errors.js";
import { readEvents } from "../src/core/events.js";
import { buildGateModel } from "../src/core/gate/model.js";
import { runPaths } from "../src/core/paths.js";
import { computeRevision } from "../src/core/revision.js";
import { loadRun } from "../src/core/run.js";
import { setState, writeJson } from "./analysis-fixtures.js";
import { answerEverything, loadGateLogic, setupGateRun, writePlan } from "./gate-helpers.js";
import { useTempRunsDir } from "./helpers.js";

useTempRunsDir();
const logic = loadGateLogic();

function reviewing(answered = true): { dir: string } {
  const { dir } = setupGateRun();
  if (answered) writeJson(runPaths(dir).answers, answerEverything(logic, JSON.parse(JSON.stringify(buildGateModel(dir, "answer").model))));
  writePlan(dir, { tickets: [] });
  setState(dir, "plan_checked");
  buildGate({ runDir: dir });
  return { dir };
}

const kindOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof HewError) return `${e.kind}:${e.exitCode}`;
    throw e;
  }
  return "ok";
};

describe("approve", () => {
  it("전체 해시나 앞 12자가 같으면 approved 로 잠그고 approval.json 을 쓴다", () => {
    const { dir } = reviewing();
    const rev = computeRevision(dir);
    const r = approveRun({ runDir: dir, revision: rev.slice(0, 12), source: "cli", now: new Date("2026-11-14T12:00:00Z") });
    expect(r).toMatchObject({ previous_state: "gate_plan_review", state: "approved", revision: rev });
    expect(JSON.parse(readFileSync(runPaths(dir).approval, "utf8"))).toEqual({ revision: rev, approved_at: "2026-11-14T12:00:00.000Z", source: "cli" });
    expect(loadRun(dir)).toMatchObject({ state: "approved", revision: rev });
    expect(readEvents(runPaths(dir).events).at(-1)?.type).toBe("approved");
  });

  it("revision 불일치는 종료 3 이고 상태가 그대로다", () => {
    const { dir } = reviewing();
    expect(kindOf(() => approveRun({ runDir: dir, revision: "0".repeat(12), source: "cli" }))).toBe("rejected:3");
    expect(loadRun(dir).state).toBe("gate_plan_review");
  });

  it("상태가 gate_plan_review 가 아니면 종료 4", () => {
    const { dir } = reviewing();
    setState(dir, "plan_checked");
    expect(kindOf(() => approveRun({ runDir: dir, revision: computeRevision(dir), source: "cli" }))).toBe("state:4");
  });

  it("열린 항목이 남아 있으면 종료 4, revision 인자가 너무 짧으면 종료 2", () => {
    const { dir } = reviewing(false);
    expect(kindOf(() => approveRun({ runDir: dir, revision: computeRevision(dir), source: "cli" }))).toBe("state:4");
    expect(kindOf(() => approveRun({ runDir: dir, revision: "abc", source: "cli" }))).toBe("usage:2");
    expect(loadRun(dir).state).toBe("gate_plan_review");
  });
});
