import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGate } from "../src/core/gate/build.js";
import { importAnswers } from "../src/core/gate/import.js";
import { buildGateModel } from "../src/core/gate/model.js";
import { HEW_ROOT, runPaths } from "../src/core/paths.js";
import { loadRun } from "../src/core/run.js";
import { runLoop } from "../src/core/runner.js";
import { setupRun } from "./analysis-fixtures.js";
import { EXAMPLE_SCENARIOS, answerEverything, loadGateLogic } from "./gate-helpers.js";
import { useTempRunsDir } from "./helpers.js";
import { EXAMPLE_DOC, FAKE_HEKA, exampleUnits, makeFakeClaude, tempDir } from "./runner-helpers.js";

const runs = useTempRunsDir();
const fakeClaude = makeFakeClaude();
const EXAMPLE_PLAN = join(HEW_ROOT, "refs", "plan.example.json");
const logic = loadGateLogic();

describe("끝에서 끝: collected → approved(예시 자료, 가짜 claude, gate import)", () => {
  it("분석·시나리오·사수·답·답 반영·분해안·티켓 사수·승인까지 한 번에 통과한다", async () => {
    const { dir } = setupRun({ units: exampleUnits() });
    const plan = {
      "technical-manager": [{ mode: "submit", doc: EXAMPLE_DOC }],
      "qa-designer": [{ mode: "submit", doc: EXAMPLE_SCENARIOS }],
      "manager-sasu": [{ mode: "sasu_ok" }],
      "ticket-maker": [{ mode: "submit", doc: EXAMPLE_PLAN }],
      "ticket-sasu": [{ mode: "sasu_ok" }],
    };
    const env = {
      ...process.env,
      HEW_RUNS_DIR: runs.dir,
      HEW_CLAUDE_BIN: fakeClaude,
      HEW_HEKA_BIN: FAKE_HEKA,
      FAKE_CLAUDE_MODE: "by_role",
      FAKE_CLAUDE_PLAN: JSON.stringify(plan),
      FAKE_CLAUDE_LOG: tempDir("hew-fake-log-"),
    };

    expect(await runLoop({ runDir: dir, until: "checked", env })).toMatchObject({ outcome: "until_reached", state: "checked" });

    // 답변 단계: 모든 질문·가정에 답하고 차이는 D-1 만 보류(예시 분해안이 전제한 결정)한다.
    expect(buildGate({ runDir: dir })).toMatchObject({ phase: "answer", state: "gate_answering" });
    const answerModel = JSON.parse(JSON.stringify(buildGateModel(dir, "answer").model));
    let state = answerEverything(logic, answerModel, "2026-11-14T10:00:00.000Z");
    const d1 = answerModel.screens.flatMap((s: any) => s.requirements.flatMap((r: any) => r.deltas)).find((d: any) => d.id === "D-1");
    state = logic.setDecision(state, answerModel.rules, d1, "hold", "2026-11-14T10:00:01.000Z");
    const answersFile = join(dir, "export-answers.json");
    writeFileSync(answersFile, JSON.stringify(logic.buildExport(answerModel, state, new Date("2026-11-14T10:01:00.000Z"))));
    expect(importAnswers({ runDir: dir, file: answersFile })).toMatchObject({ state: "answers_complete", open: 0 });

    // 답 반영, 분해안, 티켓 사수.
    expect(await runLoop({ runDir: dir, until: "plan_checked", env })).toMatchObject({ outcome: "until_reached", state: "plan_checked" });
    const roles = readFileSync(runPaths(dir).events, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === "agent_finished").map((e) => e.data.role);
    expect(roles.slice(-2)).toEqual(["ticket-maker", "ticket-sasu"]);
    expect(loadRun(dir)).toMatchObject({ state: "plan_checked", rework: { plan: 0 } });

    // 승인 단계: 분해안이 실리고 승인을 들여오면 approved.
    expect(buildGate({ runDir: dir })).toMatchObject({ phase: "approve", state: "gate_plan_review" });
    const approveModel = JSON.parse(JSON.stringify(buildGateModel(dir, "approve").model));
    expect(approveModel.plan.tickets).toHaveLength(4);
    expect(approveModel.plan.excluded[0]).toMatchObject({ kind: "delta", ref: "D-1" });
    expect(approveModel.head.open_ids).toEqual([]);
    const approved = logic.approveState(state, approveModel.head.revision, "2026-11-14T12:00:00.000Z");
    expect(logic.canApprove(approveModel, approved)).toBe(true);
    const approvalFile = join(dir, "export-approval.json");
    writeFileSync(approvalFile, JSON.stringify(logic.buildExport(approveModel, approved, new Date("2026-11-14T12:00:01.000Z"))));
    expect(importAnswers({ runDir: dir, file: approvalFile })).toMatchObject({ approved: true, state: "approved" });
    expect(loadRun(dir).state).toBe("approved");
    expect(JSON.parse(readFileSync(runPaths(dir).approval, "utf8"))).toMatchObject({ revision: approveModel.head.revision, source: "gate" });
  }, 120000);
});
