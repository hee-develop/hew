import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRun } from "../src/core/run.js";
import { collectRunOpen } from "../src/core/open.js";
import { runPaths } from "../src/core/paths.js";
import { setState } from "./analysis-fixtures.js";
import { answerEverything, loadGateLogic, scriptBlock, setupGateRun, writePlan } from "./gate-helpers.js";
import { useTempRunsDir } from "./helpers.js";

const runs = useTempRunsDir();
const BIN = join(import.meta.dirname, "..", "bin", "hew");
const hew = (args: string[]) => spawnSync(BIN, ["--json", ...args], { env: { ...process.env, HEW_RUNS_DIR: runs.dir }, encoding: "utf8" });
const modelOfPage = (page: string): any =>
  JSON.parse(scriptBlock(readFileSync(page, "utf8").replace('<script type="application/json" id="gate-data">', '<script id="gate-data">'), "gate-data"));

describe("끝에서 끝: 예시 정본 → gate build → 페이지 로직 → gate import → approve", () => {
  it("모든 질문·차이·가정에 답한 내보내기를 들여오면 answers_complete, 이어서 승인까지 간다", () => {
    const { dir } = setupGateRun();
    const runId = loadRun(dir).run_id;
    const logic = loadGateLogic();

    const build = hew(["gate", "build", "--run", runId]);
    expect(JSON.parse(build.stdout)).toMatchObject({ ok: true, data: { state: "gate_answering", phase: "answer" } });
    const model = modelOfPage(runPaths(dir).gatePage);
    expect(model.head.open_ids).toEqual(collectRunOpen(dir));

    const state = answerEverything(logic, model);
    expect(logic.computeOpen(model, state).all).toEqual([]);
    const exportFile = join(dir, "gate-answers.json");
    writeFileSync(exportFile, JSON.stringify(logic.buildExport(model, state, new Date())));
    const imp = hew(["gate", "import", "--run", runId, "--file", exportFile]);
    expect(JSON.parse(imp.stdout)).toMatchObject({ ok: true, data: { state: "answers_complete", open: 0 } });
    expect(loadRun(dir)).toMatchObject({ state: "answers_complete", open: 0 });

    // 답 반영과 분해안 단계는 이번 조각 밖이라 상태만 plan_checked 로 옮긴다.
    writePlan(dir, { tickets: [] });
    setState(dir, "plan_checked");
    expect(JSON.parse(hew(["gate", "build", "--run", runId]).stdout).data).toMatchObject({ state: "gate_plan_review", phase: "approve" });
    const approveModel = modelOfPage(runPaths(dir).gatePage);
    expect(logic.canApprove(approveModel, logic.emptyState())).toBe(false);
    const approved = hew(["approve", "--run", runId, "--revision", approveModel.head.revision.slice(0, 12)]);
    expect(JSON.parse(approved.stdout)).toMatchObject({ ok: true, data: { state: "approved", source: "cli" } });
    expect(hew(["approve", "--run", runId, "--revision", approveModel.head.revision]).status).toBe(4);
  });
});
