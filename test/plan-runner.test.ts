import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEvents } from "../src/core/events.js";
import { HEW_ROOT, findingsBatchPath, findingsPath, runPaths } from "../src/core/paths.js";
import { loadRun } from "../src/core/run.js";
import { runLoop } from "../src/core/runner.js";
import { loadPlan } from "../src/core/sasu/store.js";
import { useTempRunsDir, writeItemsFile } from "./helpers.js";
import { buildPlan, clone, setupAnswersApplied } from "./plan-fixtures.js";
import { FAKE_HEKA, makeFakeClaude, readCalls, tempDir } from "./runner-helpers.js";

const runs = useTempRunsDir();
const fakeClaude = makeFakeClaude();

function fakeEnv(mode: string, extra: Record<string, string> = {}): { env: NodeJS.ProcessEnv; log: string } {
  const log = tempDir("hew-fake-log-");
  return {
    log,
    env: { ...process.env, HEW_RUNS_DIR: runs.dir, HEW_CLAUDE_BIN: fakeClaude, HEW_HEKA_BIN: FAKE_HEKA, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log, ...extra },
  };
}

const read = (path: string): string => readFileSync(path, "utf8");

describe("실행기: 분해안 한 바퀴(answers_applied -> planned -> plan_checked)", () => {
  it("ticket-maker 한 번, ticket-sasu 묶음마다 한 번을 띄우고 plan_checked 에 닿는다", async () => {
    const { dir } = setupAnswersApplied();
    const repo = tempDir("hew-repo-");
    const raw = JSON.parse(read(runPaths(dir).runJson));
    raw.repo = { path: repo, base: "abc" };
    writeFileSync(runPaths(dir).runJson, JSON.stringify(raw));
    const plan = {
      "ticket-maker": [{ mode: "submit", doc: writeItemsFile(dir, "plan-doc.json", buildPlan()) }],
      "ticket-sasu": [{ mode: "sasu_ok" }],
    };
    const { env, log } = fakeEnv("by_role", { FAKE_CLAUDE_PLAN: JSON.stringify(plan) });
    const result = await runLoop({ runDir: dir, until: "plan_checked", env });
    expect(result).toMatchObject({ outcome: "until_reached", state: "plan_checked", launches: 2 });
    expect(result.steps.map((s) => [s.role, s.purpose, s.attempt, s.progressed])).toEqual([
      ["ticket-maker", "first", 1, true],
      ["ticket-sasu", "first", 1, true],
    ]);

    const calls = readCalls(log);
    expect(calls[0]?.argv).toContain("hew:ticket-maker");
    expect(calls[0]?.argv).toContain("claude-sonnet-5-5");
    expect(calls[1]?.argv).toContain("hew:ticket-sasu");
    expect(calls[1]?.argv).toContain("claude-haiku-5-5");
    // 읽기 뿌리: ticket-maker 는 대상 저장소와 분해 규칙 폴더까지, ticket-sasu 는 실행 폴더와 refs 만.
    expect(calls[0]?.env.HEW_GUARD_READ_ROOTS).toBe([dir, repo, join(HEW_ROOT, "refs"), join(HEW_ROOT, "rules")].join(":"));
    expect(calls[1]?.env.HEW_GUARD_READ_ROOTS).toBe([dir, join(HEW_ROOT, "refs")].join(":"));

    const p = runPaths(dir);
    const makerPacket = read(join(p.packets, "ticket-maker-1.md"));
    expect(makerPacket).toContain("목적: first");
    expect(makerPacket).toContain(join(HEW_ROOT, "rules", "plan.yaml"));
    const sasuPacket = read(join(p.packets, "ticket-sasu-1.md"));
    expect(sasuPacket).toContain("submit findings --for plan --batch 1");
    expect(sasuPacket).toContain(loadPlan(dir, 1, "plan")?.batches[0]?.path ?? "없음");

    // 정본 틀에 세션·모델·비용이 채워진다.
    const planDoc = JSON.parse(read(p.plan));
    expect(planDoc.produced_by).toMatchObject({ role: "ticket-maker", model: "claude-sonnet-5-5", session_id: "sess-1" });
    expect(planDoc.cost).toEqual({ usd: 0.0123, duration_ms: 1234 });
    const batch = JSON.parse(read(findingsBatchPath(p, "plan", 1, 1)));
    expect(batch.produced_by).toMatchObject({ role: "ticket-sasu", model: "claude-haiku-5-5", session_id: "sess-2" });
    const round = JSON.parse(read(findingsPath(p, "plan", 1)));
    expect(round).toMatchObject({ stage: "findings_plan", produced_by: { role: "ticket-sasu" }, cost: { usd: 0.0123 } });
    expect(loadRun(dir)).toMatchObject({ state: "plan_checked", rework: { analysis: 0, plan: 0 } });
    expect(readEvents(p.events).filter((e) => e.type === "agent_finished")).toHaveLength(2);
  });

  it("차단 지적 반송 한 바퀴: ticket-sasu 지적 -> ticket-maker(rework, respond) 재제출 -> 바뀐 티켓만 ticket-sasu -> plan_checked", async () => {
    const { dir } = setupAnswersApplied();
    const second = clone(buildPlan());
    second.tickets[0].body.work = ["홈 상단에 배너 영역을 노출한다"];
    const plan = {
      "ticket-maker": [
        { mode: "submit", doc: writeItemsFile(dir, "plan-1.json", buildPlan()) },
        { mode: "tm_respond", response: "fixed", doc: writeItemsFile(dir, "plan-2.json", second) },
      ],
      "ticket-sasu": [{ mode: "sasu_issue_first", action: "fix" }, { mode: "sasu_ok" }],
    };
    const { env, log } = fakeEnv("by_role", { FAKE_CLAUDE_PLAN: JSON.stringify(plan) });
    const result = await runLoop({ runDir: dir, until: "plan_checked", env });
    expect(result).toMatchObject({ outcome: "until_reached", state: "plan_checked", launches: 4 });
    expect(result.steps.map((s) => [s.role, s.purpose])).toEqual([
      ["ticket-maker", "first"],
      ["ticket-sasu", "first"],
      ["ticket-maker", "rework"],
      ["ticket-sasu", "first"],
    ]);
    expect(readCalls(log)).toHaveLength(4);

    const p = runPaths(dir);
    const reworkPacket = read(join(p.packets, "ticket-maker-2.md"));
    expect(reworkPacket).toContain("목적: rework");
    expect(reworkPacket).toContain("| F-1 | T1:T1 | ticket_missing_context | 가짜 사수가 낸 지적 |");
    expect(reworkPacket).toContain("sasu respond --for plan");
    // 답변이 저장되었고 2회차 묶음에는 바뀐 티켓만, 직전 지적과 답변이 실린다.
    expect(existsSync(join(p.doc, "sasu", "plan-1.responses.json"))).toBe(true);
    const round2 = loadPlan(dir, 2, "plan");
    expect(round2?.units.filter((u) => u.reuse === true)).toHaveLength(4);
    const batch = JSON.parse(read(round2?.batches[0]?.path ?? ""));
    expect(batch.units.map((u: any) => u.id)).toEqual(["T1:T1"]);
    expect(batch.units[0].inputs.previous).toMatchObject({ kind: "ticket_missing_context", response: { response: "fixed" } });
    expect(loadRun(dir)).toMatchObject({ state: "plan_checked", rework: { analysis: 0, plan: 1 } });
    expect(loadRun(dir).submissions.plan?.attempt).toBe(2);
    expect(readdirSync(join(p.doc, "findings")).sort()).toEqual(["plan-1", "plan-1.json", "plan-2", "plan-2.json"]);
  });

  it("--dry: ticket-maker 와 ticket-sasu 의 띄울 명령을 만든다", async () => {
    const { dir } = setupAnswersApplied();
    const { env } = fakeEnv("noop");
    const maker = await runLoop({ runDir: dir, env, dry: true });
    expect(maker.dry?.args).toContain("hew:ticket-maker");
    expect(maker.dry?.env.HEW_GUARD_READ_ROOTS?.split(":")).toContain(join(HEW_ROOT, "rules"));
    const plan = { "ticket-maker": [{ mode: "submit", doc: writeItemsFile(dir, "plan-doc.json", buildPlan()) }] };
    await runLoop({ runDir: dir, until: "planned", env: fakeEnv("by_role", { FAKE_CLAUDE_PLAN: JSON.stringify(plan) }).env });
    expect(loadRun(dir).state).toBe("planned");
    const none = await runLoop({ runDir: dir, env, dry: true });
    expect(none).toMatchObject({ outcome: "dry", dry: null });
    expect(none.message).toContain("hew sasu plan --for plan");
  });

  it("plan_checked 에서는 게이트 게시 차례라 멈춘다", async () => {
    const { dir } = setupAnswersApplied();
    const plan = {
      "ticket-maker": [{ mode: "submit", doc: writeItemsFile(dir, "plan-doc.json", buildPlan()) }],
      "ticket-sasu": [{ mode: "sasu_ok" }],
    };
    const { env } = fakeEnv("by_role", { FAKE_CLAUDE_PLAN: JSON.stringify(plan) });
    const result = await runLoop({ runDir: dir, env });
    expect(result).toMatchObject({ outcome: "stopped", state: "plan_checked" });
    expect(result.message).toContain("게이트(approve)");
  });
});
