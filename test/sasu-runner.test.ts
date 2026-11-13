import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HewError } from "../src/core/errors.js";
import { readEvents } from "../src/core/events.js";
import { buildPacket } from "../src/core/packet.js";
import { HEW_ROOT, findingsBatchPath, runPaths } from "../src/core/paths.js";
import { loadRun } from "../src/core/run.js";
import { DEFAULT_MAX_STEPS, buildSpawnPlan, runLoop } from "../src/core/runner.js";
import { roleConfig } from "../src/core/roles.js";
import { createPlan } from "../src/core/sasu/plan.js";
import { loadPlan } from "../src/core/sasu/store.js";
import { submitArtifact } from "../src/core/submit.js";
import { buildAnalysis, setupRun } from "./analysis-fixtures.js";
import { makeRun, useTempRunsDir, writeItemsFile } from "./helpers.js";
import { EXAMPLE_DOC, FAKE_HEKA, exampleUnits, makeFakeClaude, readCalls, tempDir } from "./runner-helpers.js";
import { setupQaDesigned, submitAll } from "./sasu-fixtures.js";
import { buildScenarios } from "./scenarios-fixtures.js";

const runs = useTempRunsDir();
const fakeClaude = makeFakeClaude();

function fakeEnv(mode: string, extra: Record<string, string> = {}): { env: NodeJS.ProcessEnv; log: string } {
  const log = tempDir("hew-fake-log-");
  return {
    log,
    env: { ...process.env, HEW_RUNS_DIR: runs.dir, HEW_CLAUDE_BIN: fakeClaude, HEW_HEKA_BIN: FAKE_HEKA, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log, ...extra },
  };
}

const lines = (file: string): Record<string, any>[] => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);

describe("실행기: 사수 단계(qa_designed -> checked)", () => {
  it("묶음마다 manager-sasu 를 순서대로 하나씩 띄우고 모든 묶음이 끝나면 checked", async () => {
    const { dir } = setupQaDesigned();
    const { env, log } = fakeEnv("sasu_ok");
    const result = await runLoop({ runDir: dir, until: "checked", env });
    expect(result).toMatchObject({ outcome: "until_reached", state: "checked", launches: 6 });
    expect(result.steps.map((s) => [s.role, s.attempt, s.progressed])).toEqual(Array.from({ length: 6 }, () => ["manager-sasu", 1, true]));

    const calls = readCalls(log);
    expect(calls).toHaveLength(6);
    for (const c of calls) {
      expect(c.argv).toContain("hew:manager-sasu");
      expect(c.argv).toContain("claude-haiku-5-5");
    }
    const plan = loadPlan(dir, 1);
    expect(plan?.batches).toHaveLength(6);
    const p = runPaths(dir);
    for (const b of plan?.batches ?? []) {
      expect(existsSync(findingsBatchPath(p, "analysis", 1, b.k))).toBe(true);
      const packet = readFileSync(join(p.packets, `manager-sasu-${b.k}.md`), "utf8");
      expect(packet).toContain(b.path);
      expect(packet).toContain(`submit findings --for analysis --batch ${b.k} --run ${dir} --file ${join(p.work, `manager-sasu-${b.k}`, "findings.json")}`);
    }
    expect(loadRun(dir).state).toBe("checked");
    const costs = lines(p.costs);
    expect(costs).toHaveLength(6);
    expect(costs.map((c) => c.batch)).toEqual([1, 2, 3, 4, 5, 6]);
    const events = readEvents(p.events);
    expect(events.filter((e) => e.type === "agent_finished")).toHaveLength(6);
    expect(events.some((e) => e.type === "sasu_round_completed")).toBe(true);
    // 묶음 정본에 세션·모델이 채워지고 합친 정본에 비용이 채워진다.
    const batch1 = JSON.parse(readFileSync(findingsBatchPath(p, "analysis", 1, 1), "utf8"));
    expect(batch1.produced_by).toMatchObject({ role: "manager-sasu", model: "claude-haiku-5-5", session_id: "sess-1" });
    expect(batch1.cost).toEqual({ usd: 0.0123, duration_ms: 1234 });
    const round = JSON.parse(readFileSync(join(p.findingsDir, "analysis-1.json"), "utf8"));
    expect(round.cost).toMatchObject({ usd: expect.closeTo(0.0738, 4) });
    expect(round.produced_by).toMatchObject({ role: "manager-sasu" });
  });

  it("패킷은 묶음 파일·형식 안내·제출 명령을 담고 대상 저장소를 주지 않는다", async () => {
    const { dir } = setupQaDesigned();
    const repo = tempDir("hew-repo-");
    const raw = JSON.parse(readFileSync(runPaths(dir).runJson, "utf8"));
    raw.repo = { path: repo, base: "abc" };
    writeFileSync(runPaths(dir).runJson, JSON.stringify(raw));
    const { env, log } = fakeEnv("sasu_ok");
    await runLoop({ runDir: dir, until: "checked", env, maxSteps: 1 });
    const call = readCalls(log)[0];
    expect(call?.env.HEW_GUARD_READ_ROOTS).toBe([dir, join(HEW_ROOT, "refs")].join(":"));
    expect(call?.env.HEW_GUARD_READ_ROOTS).not.toContain(repo);
    const text = readFileSync(join(runPaths(dir).packets, "manager-sasu-1.md"), "utf8");
    for (const ref of ["findings-format.md", "findings.example.json", "sasu-batch.example.json"]) expect(text).toContain(join(HEW_ROOT, "refs", ref));
    expect(text).not.toContain(repo);
    expect(text).toContain("종류 W2");
    expect(text).toContain("이 종류가 묻는 것");
  });

  it("묶음 하나가 3회 시도해도 제출되지 않으면 종료 5(external)", async () => {
    const { dir } = setupQaDesigned();
    const { env, log } = fakeEnv("noop");
    try {
      await runLoop({ runDir: dir, env });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HewError);
      expect((e as HewError).exitCode).toBe(5);
      expect((e as HewError).message).toContain("묶음 1");
    }
    expect(readCalls(log)).toHaveLength(3);
    expect(readEvents(runPaths(dir).events).some((e) => e.type === "agent_failed")).toBe(true);
    expect(loadRun(dir).state).toBe("qa_designed");
  }, 30000);

  it("--max-steps 는 사수 묶음 실행도 센다", async () => {
    const { dir } = setupQaDesigned();
    const { env, log } = fakeEnv("sasu_ok");
    const result = await runLoop({ runDir: dir, env, maxSteps: 2 });
    expect(result).toMatchObject({ outcome: "max_steps", launches: 2 });
    expect(readCalls(log)).toHaveLength(2);
    // 이어서 돌리면 남은 묶음만 띄운다.
    const rest = await runLoop({ runDir: dir, until: "checked", env: fakeEnv("sasu_ok").env });
    expect(rest).toMatchObject({ outcome: "until_reached", launches: 4 });
  });

  it("기본 띄우는 횟수 상한은 40", () => {
    expect(DEFAULT_MAX_STEPS).toBe(40);
  });

  it("다시 돌릴 단위가 0개이면 아무것도 띄우지 않고 회차를 완료한다", async () => {
    const { dir } = setupQaDesigned();
    createPlan(dir, "analysis");
    submitAll(dir, loadPlan(dir, 1)!);
    const raw = JSON.parse(readFileSync(runPaths(dir).runJson, "utf8"));
    raw.state = "answers_complete";
    raw.progress = { analysis: true, scenarios: true, sasu: false };
    writeFileSync(runPaths(dir).runJson, JSON.stringify(raw));
    const { env, log } = fakeEnv("sasu_ok");
    const result = await runLoop({ runDir: dir, until: "checked", env });
    expect(result).toMatchObject({ outcome: "until_reached", state: "checked", launches: 0 });
    expect(existsSync(log) ? readdirSync(log) : []).toEqual([]);
  });

  it("분해안 정본이 없는 planned 에서는 종료 4 로 멈추고 아무것도 띄우지 않는다", async () => {
    const { dir } = makeRun("planned");
    const { env, log } = fakeEnv("sasu_ok");
    await expect(runLoop({ runDir: dir, env })).rejects.toMatchObject({ exitCode: 4 });
    expect(existsSync(log) ? readdirSync(log) : []).toEqual([]);
  });

  it("--dry: 계획이 없으면 알리기만 하고, 있으면 첫 묶음의 명령을 만든다", async () => {
    const { dir } = setupQaDesigned();
    const { env } = fakeEnv("sasu_ok");
    const none = await runLoop({ runDir: dir, env, dry: true });
    expect(none).toMatchObject({ outcome: "dry", dry: null });
    expect(none.message).toContain("hew sasu plan");
    createPlan(dir, "analysis");
    const some = await runLoop({ runDir: dir, env, dry: true });
    expect(some.dry?.args).toContain("hew:manager-sasu");
    expect(existsSync(join(runPaths(dir).packets, "manager-sasu-1.md"))).toBe(false);
  });
});

describe("실행기: 사수 반송 한 바퀴", () => {
  it("qa_designed -> collected -> 가짜 TM 재제출 -> analyzed -> 가짜 QA 재제출 -> qa_designed -> 바뀐 단위만 다시 -> checked", async () => {
    const { dir } = setupQaDesigned();
    const tmDoc = buildAnalysis();
    tmDoc.requirements[0].title = "홈 상단에 배너를 노출한다";
    const tmFile = writeItemsFile(dir, "tm-doc.json", tmDoc);
    const qaFile = writeItemsFile(dir, "qa-doc.json", buildScenarios());
    const plan = {
      "technical-manager": [{ mode: "submit", doc: tmFile }],
      "qa-designer": [{ mode: "submit", doc: qaFile }],
      "manager-sasu": [{ mode: "sasu_issue_first" }, { mode: "sasu_ok" }],
    };
    const { env, log } = fakeEnv("by_role", { FAKE_CLAUDE_PLAN: JSON.stringify(plan) });
    const result = await runLoop({ runDir: dir, until: "checked", env });
    expect(result).toMatchObject({ outcome: "until_reached", state: "checked" });

    const roles = result.steps.map((s) => s.role);
    const firstBatches = loadPlan(dir, 1)?.batches.length ?? 0;
    const secondBatches = loadPlan(dir, 2)?.batches.length ?? 0;
    expect(firstBatches).toBe(6);
    expect(secondBatches).toBeGreaterThan(0);
    expect(secondBatches).toBeLessThan(firstBatches);
    expect(roles).toEqual([
      ...Array.from({ length: firstBatches }, () => "manager-sasu"),
      "technical-manager",
      "qa-designer",
      ...Array.from({ length: secondBatches }, () => "manager-sasu"),
    ]);
    expect(readCalls(log)).toHaveLength(roles.length);

    // 반송: TM 패킷에 차단 지적이 실렸다.
    const tmPacket = readFileSync(join(runPaths(dir).packets, "technical-manager-1.md"), "utf8");
    expect(tmPacket).toContain("목적: rework");
    expect(tmPacket).toContain("| F-1 | W2:요구-1 | unsupported | 가짜 사수가 낸 지적 |");

    // 바뀐 단위만 다시: 요구-1 은 다시 돌고 건드리지 않은 요구는 재사용.
    const second = loadPlan(dir, 2)!;
    expect(second.units.find((u) => u.id === "W2:요구-1")?.reuse).toBeUndefined();
    expect(second.units.find((u) => u.id === "W2:요구-2")).toMatchObject({ reuse: true, batch: null });
    const run = loadRun(dir);
    expect(run).toMatchObject({ state: "checked", rework: { analysis: 1, plan: 0 } });
    expect(run.submissions.findings_analysis?.attempt).toBe(2);
    const round2 = JSON.parse(readFileSync(join(runPaths(dir).findingsDir, "analysis-2.json"), "utf8"));
    expect(round2.items.findings).toHaveLength(second.units.length);
    expect(round2.items.findings.every((f: any) => f.blocking === false)).toBe(true);
    expect(lines(runPaths(dir).mistakes)).toHaveLength(1);
    expect(roleConfig("manager-sasu").model).toBe("claude-haiku-5-5");
  });

  it("사수 ask 지적 -> 반송 -> TM 이 respond(rejected) 후 재제출 -> 사수 ok -> checked, 질문도 실수 기록도 없다", async () => {
    const { dir } = setupQaDesigned();
    const plan = {
      "technical-manager": [{ mode: "tm_respond", response: "rejected", doc: writeItemsFile(dir, "tm-doc.json", buildAnalysis()) }],
      "qa-designer": [{ mode: "submit", doc: writeItemsFile(dir, "qa-doc.json", buildScenarios()) }],
      "manager-sasu": [{ mode: "sasu_issue_first", action: "ask" }, { mode: "sasu_ok" }],
    };
    const { env } = fakeEnv("by_role", { FAKE_CLAUDE_PLAN: JSON.stringify(plan) });
    const questionsBefore = JSON.parse(readFileSync(runPaths(dir).analysis, "utf8")).items.questions.length;
    const result = await runLoop({ runDir: dir, until: "checked", env });
    expect(result).toMatchObject({ outcome: "until_reached", state: "checked" });
    expect(result.steps.map((s) => s.role).filter((r) => r !== "manager-sasu")).toEqual(["technical-manager", "qa-designer"]);

    const p = runPaths(dir);
    // TM 패킷에 ask 지적이 실리고, 답변 파일이 회차 1 에 저장되었다.
    const tmPacket = readFileSync(join(p.packets, "technical-manager-1.md"), "utf8");
    expect(tmPacket).toContain("| F-1 | W2:요구-1 | unsupported | 가짜 사수가 낸 지적 |");
    expect(tmPacket).toContain("| ask |");
    expect(tmPacket).toContain("sasu respond --for analysis");
    const responses = JSON.parse(readFileSync(join(p.doc, "sasu", "analysis-1.responses.json"), "utf8"));
    expect(responses.responses).toEqual([{ finding: "F-1", response: "rejected", reason: "가짜 테크니컬 매니저가 낸 이유" }]);

    // 다음 회차 묶음에 직전 지적과 답변이 실렸다.
    const second = loadPlan(dir, 2)!;
    const batch = JSON.parse(readFileSync(second.batches[0]!.path, "utf8"));
    expect(batch.units[0]).toMatchObject({ id: "W2:요구-1", inputs: { previous: { claim: "가짜 사수가 낸 지적", kind: "unsupported", response: { response: "rejected" } } } });
    expect(batch.question).toContain("답변이 근거를 들어 반박했고");

    // 질문은 늘지 않았고, 사수의 오탐으로 기록되었다.
    expect(JSON.parse(readFileSync(p.analysis, "utf8")).items.questions).toHaveLength(questionsBefore);
    expect(existsSync(p.mistakes) ? lines(p.mistakes) : []).toEqual([]);
    const events = readEvents(p.events);
    expect(events.filter((e) => e.type === "sasu_false_positive")).toHaveLength(1);
    expect(events.some((e) => e.type === "sasu_questions_added")).toBe(false);
    expect(loadRun(dir)).toMatchObject({ state: "checked", rework: { analysis: 1, plan: 0 } });
  });

  it("answers_complete 반송: 사수가 차단하면 technical-manager rework 를 띄우고 시나리오는 다시 만들지 않는다", async () => {
    const { dir } = setupQaDesigned();
    const raw = JSON.parse(readFileSync(runPaths(dir).runJson, "utf8"));
    raw.state = "answers_complete";
    raw.progress = { analysis: true, scenarios: true, sasu: false };
    writeFileSync(runPaths(dir).runJson, JSON.stringify(raw));
    const tmDoc = buildAnalysis();
    tmDoc.requirements[0].title = "홈 상단에 배너를 노출한다";
    const plan = {
      "technical-manager": [{ mode: "submit", doc: writeItemsFile(dir, "tm-doc.json", tmDoc) }],
      "manager-sasu": [{ mode: "sasu_issue_first" }, { mode: "sasu_ok" }],
    };
    const { env } = fakeEnv("by_role", { FAKE_CLAUDE_PLAN: JSON.stringify(plan) });
    const result = await runLoop({ runDir: dir, until: "checked", env });
    expect(result.state).toBe("checked");
    const roles = result.steps.map((s) => s.role);
    expect(roles.filter((r) => r === "technical-manager")).toHaveLength(1);
    expect(roles).not.toContain("qa-designer");
    const tmPacket = readFileSync(join(runPaths(dir).packets, "technical-manager-1.md"), "utf8");
    expect(tmPacket).toContain("목적: rework");
    expect(loadRun(dir).rework.analysis).toBe(1);
  });
});

describe("실행기 인자 구성: 사수는 대상 저장소를 읽지 못한다", () => {
  it("sasu 역할은 읽기 뿌리가 실행 폴더와 refs 뿐이고 다른 역할은 저장소를 포함한다", () => {
    const { dir, run } = makeRun("qa_designed", { repo: { path: "/some/repo", base: "x" } }, "sp-1");
    const mk = (role: "manager-sasu" | "technical-manager") =>
      buildSpawnPlan(dir, run, role, "first", roleConfig(role), { path: "/p.md", workDir: "/w" }, { HEW_CLAUDE_BIN: "/bin/claude" });
    expect(mk("manager-sasu").env.HEW_GUARD_READ_ROOTS).toBe([dir, join(HEW_ROOT, "refs")].join(":"));
    expect(mk("technical-manager").env.HEW_GUARD_READ_ROOTS).toContain("/some/repo");
  });
});

describe("패킷: manager-sasu", () => {
  it("계획이 없으면 사용법 오류", () => {
    const { dir } = setupQaDesigned();
    expect(() => buildPacket({ runDir: dir, role: "manager-sasu", env: { ...process.env, HEW_HEKA_BIN: FAKE_HEKA } })).toThrow(/사수 계획/);
  });

  it("묶음을 정하지 않으면 아직 제출되지 않은 첫 묶음, --batch 로 정하면 그 묶음", () => {
    const { dir } = setupQaDesigned();
    const plan = createPlan(dir, "analysis").plan;
    const env = { ...process.env, HEW_HEKA_BIN: FAKE_HEKA };
    expect(readFileSync(buildPacket({ runDir: dir, role: "manager-sasu", env }).path, "utf8")).toContain("묶음 1 (종류 W2");
    expect(readFileSync(buildPacket({ runDir: dir, role: "manager-sasu", env, batch: 2 }).path, "utf8")).toContain("묶음 2 (종류 W3");
    expect(() => buildPacket({ runDir: dir, role: "manager-sasu", env, batch: 99 })).toThrow(/묶음 99/);
    expect(plan.batches).toHaveLength(6);
  });
});

describe("hew run 명령: 예시 분석·시나리오 -> checked", () => {
  it("예시 문서를 제출한 뒤 가짜 claude 로 --until checked 가 종료 0, status 가 checked", () => {
    const { dir } = setupRun({ units: exampleUnits() });
    submitArtifact({ runDir: dir, kind: "analysis", file: EXAMPLE_DOC });
    submitArtifact({ runDir: dir, kind: "scenarios", file: join(HEW_ROOT, "refs", "scenarios.example.json") });
    const { env } = fakeEnv("sasu_ok");
    const hew = (args: string[]) => spawnSync(join(HEW_ROOT, "bin", "hew"), args, { env, encoding: "utf8" });
    const r = hew(["--json", "run", "--run", dir, "--until", "checked"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, data: { outcome: "until_reached", state: "checked" } });
    expect((JSON.parse(hew(["--json", "status", "--run", dir]).stdout) as { data: { state: string } }).data.state).toBe("checked");
  }, 60000);
});
