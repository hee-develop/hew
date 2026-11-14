import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HewError } from "../src/core/errors.js";
import { readEvents } from "../src/core/events.js";
import { runPaths, sasuResponsesPath } from "../src/core/paths.js";
import { loadRun, saveRun } from "../src/core/run.js";
import { respondToFindings } from "../src/core/sasu/respond.js";
import { buildWorkUnits } from "../src/core/sasu/units.js";
import { makeRun, useTempRunsDir, writeItemsFile } from "./helpers.js";
import { planNow, readBatch, respond, setupAnalyzed, startNextRound, submitAll, type Overrides } from "./sasu-fixtures.js";

const runs = useTempRunsDir();
const BIN = join(import.meta.dirname, "..", "bin", "hew");
const hew = (args: string[]) => spawnSync(BIN, args, { env: { ...process.env, HEW_RUNS_DIR: runs.dir }, encoding: "utf8" });

const issue = (kind: string, quote: string, action: string, unit = "U-4"): Overrides[string] =>
  ({ verdict: "issue", kind, claim: "지적 내용", evidence: { unit_id: unit, quote }, action }) as Overrides[string];

/** 1회차에서 W2:요구-1(F-?) 이 fix, W3:U-1 이 ask 로 차단되어 반송 중인 실행. */
function setupReturned(): { dir: string; fixId: string; askId: string } {
  const { dir } = setupAnalyzed();
  submitAll(dir, planNow(dir), {
    "W2:요구-1": issue("unsupported", "홈 상단에 배너를 노출한다", "fix"),
    "W3:U-1": issue("missing", "배너를 노출한다", "ask", "U-1"),
  });
  const findings = JSON.parse(readFileSync(join(runPaths(dir).findingsDir, "analysis-1.json"), "utf8")).items.findings as { id: string; work: string }[];
  return { dir, fixId: findings.find((f) => f.work === "W2:요구-1")?.id ?? "", askId: findings.find((f) => f.work === "W3:U-1")?.id ?? "" };
}

const codes = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    return (e as HewError).issues.map((i) => i.code);
  }
  return [];
};
const exit = (fn: () => unknown): number => {
  try {
    fn();
  } catch (e) {
    return (e as HewError).exitCode;
  }
  return 0;
};

describe("hew sasu respond: 저장", () => {
  it("차단 지적(fix·ask 모두)에 낸 답변을 doc/sasu/analysis-<회차>.responses.json 에 저장하고 상태는 바꾸지 않는다", () => {
    const { dir, fixId, askId } = setupReturned();
    const before = loadRun(dir);
    const r = respond(dir, [
      { finding: fixId, response: "fixed", reason: "고쳤다" },
      { finding: askId, response: "rejected", reason: "원문이 말한다", evidence: { unit_id: "U-1", quote: "배너를 노출한다" } },
    ]);
    expect(r).toMatchObject({ round: 1, saved: 2, total: 2, path: sasuResponsesPath(runPaths(dir), "analysis", 1) });
    const saved = JSON.parse(readFileSync(r.path, "utf8"));
    expect(saved).toMatchObject({ for: "analysis", round: 1 });
    expect(saved.responses).toEqual([
      { finding: fixId, response: "fixed", reason: "고쳤다" },
      { finding: askId, response: "rejected", reason: "원문이 말한다", evidence: { unit_id: "U-1", quote: "배너를 노출한다" } },
    ]);
    const after = loadRun(dir);
    expect({ ...after, updated_at: "" }).toEqual({ ...before, updated_at: "" });
    expect(readEvents(runPaths(dir).events).some((e) => e.type === "sasu_responded")).toBe(true);
  });

  it("같은 지적에 다시 내면 덮어쓰고 다른 지적의 답변은 남는다", () => {
    const { dir, fixId, askId } = setupReturned();
    respond(dir, [{ finding: fixId, response: "fixed", reason: "처음" }, { finding: askId, response: "asked", reason: "질문" }]);
    const r = respond(dir, [{ finding: fixId, response: "rejected", reason: "다시 보니 틀린 지적" }], "again.json");
    expect(r).toMatchObject({ saved: 1, total: 2 });
    const saved = JSON.parse(readFileSync(r.path, "utf8")).responses;
    expect(saved.find((x: any) => x.finding === fixId)).toMatchObject({ response: "rejected", reason: "다시 보니 틀린 지적" });
    expect(saved.find((x: any) => x.finding === askId)).toMatchObject({ response: "asked" });
  });

  it("fixed·asked 는 reason 이 비어 있어도 받는다", () => {
    const { dir, fixId } = setupReturned();
    expect(respond(dir, [{ finding: fixId, response: "fixed" }])).toMatchObject({ saved: 1 });
  });
});

describe("hew sasu respond: 검증", () => {
  it("response_unknown_finding: 그 회차의 차단 지적 id 가 아니면(없는 id, 차단 아닌 지적) 거부(종료 3)하고 아무것도 저장하지 않는다", () => {
    const { dir, fixId } = setupReturned();
    // F-2 는 ok 판정이라 차단 지적이 아니다.
    const file = writeItemsFile(dir, "r.json", { responses: [{ finding: fixId, response: "fixed" }, { finding: "F-99", response: "fixed" }, { finding: "F-2", response: "asked" }] });
    const result = codes(() => respondToFindings({ runDir: dir, target: "analysis", file }));
    expect(result).toEqual(["response_unknown_finding", "response_unknown_finding"]);
    expect(exit(() => respondToFindings({ runDir: dir, target: "analysis", file }))).toBe(3);
    expect(existsSync(sasuResponsesPath(runPaths(dir), "analysis", 1))).toBe(false);
  });

  it("response_without_reason: rejected 인데 reason 이 비어 있거나 공백이면 거부", () => {
    const { dir, fixId } = setupReturned();
    expect(codes(() => respond(dir, [{ finding: fixId, response: "rejected", reason: "  " }]))).toEqual(["response_without_reason"]);
    expect(codes(() => respond(dir, [{ finding: fixId, response: "rejected" }]))).toEqual(["response_without_reason"]);
  });

  it("quote_not_found: evidence.quote 가 그 단위 본문에 없거나 단위가 없으면 거부, 공백·강조 표시는 무시하고 대조", () => {
    const { dir, fixId } = setupReturned();
    expect(codes(() => respond(dir, [{ finding: fixId, response: "rejected", reason: "r", evidence: { unit_id: "U-4", quote: "본문에 없는 문장" } }]))).toEqual(["quote_not_found"]);
    expect(codes(() => respond(dir, [{ finding: fixId, response: "rejected", reason: "r", evidence: { unit_id: "U-404", quote: "배너" } }]))).toEqual(["quote_not_found"]);
    expect(respond(dir, [{ finding: fixId, response: "rejected", reason: "r", evidence: { unit_id: "U-4", quote: "배너는 최대 5개까지  노출한다" } }])).toMatchObject({ saved: 1 });
  });

  it("schema_invalid: response 값이 열거값이 아니거나 finding 이 F-n 이 아니면 거부, JSON 이 아니면 json_parse", () => {
    const { dir, fixId } = setupReturned();
    expect(codes(() => respond(dir, [{ finding: fixId, response: "maybe" as never }]))).toEqual(["schema_invalid"]);
    expect(codes(() => respond(dir, [{ finding: "x", response: "fixed" }]))).toEqual(["schema_invalid"]);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{");
    expect(codes(() => respondToFindings({ runDir: dir, target: "analysis", file: bad }))).toEqual(["json_parse"]);
  });

  it("response_duplicate: 한 파일에 같은 지적이 두 번이면 거부", () => {
    const { dir, fixId } = setupReturned();
    expect(codes(() => respond(dir, [{ finding: fixId, response: "fixed" }, { finding: fixId, response: "asked" }]))).toEqual(["response_duplicate"]);
  });

  it("알 수 없는 --for 와 없는 파일은 종료 2, 분해안 반송 중이 아닐 때 --for plan 은 종료 4", () => {
    const { dir } = setupReturned();
    expect(exit(() => respondToFindings({ runDir: dir, target: "x", file: join(dir, "x.json") }))).toBe(2);
    expect(exit(() => respondToFindings({ runDir: dir, target: "plan", file: writeItemsFile(dir, "r.json", { responses: [] }) }))).toBe(4);
    expect(exit(() => respondToFindings({ runDir: dir, target: "analysis", file: join(dir, "없는.json") }))).toBe(2);
  });
});

describe("hew sasu respond: 받을 수 있는 상태", () => {
  it("반송 중이 아니면 종료 4(analyzed, 반송 회차 0의 collected, 사수 차례의 answers_complete)", () => {
    const { dir } = setupAnalyzed();
    const file = writeItemsFile(dir, "r.json", { responses: [] });
    expect(exit(() => respondToFindings({ runDir: dir, target: "analysis", file }))).toBe(4);
    const first = makeRun("collected", {}, "rs-1");
    const f1 = writeItemsFile(first.dir, "r.json", { responses: [] });
    expect(exit(() => respondToFindings({ runDir: first.dir, target: "analysis", file: f1 }))).toBe(4);
    const sasuTurn = makeRun("answers_complete", { progress: { analysis: true, scenarios: false, sasu: false } }, "rs-2");
    const f2 = writeItemsFile(sasuTurn.dir, "r.json", { responses: [] });
    expect(exit(() => respondToFindings({ runDir: sasuTurn.dir, target: "analysis", file: f2 }))).toBe(4);
  });

  it("answers_complete 에서 반송 중(분석 진행 false, 이번 구간의 반송 회차 있음)이면 받는다", () => {
    const { dir } = setupAnalyzed();
    saveRun(dir, { ...loadRun(dir), state: "answers_complete", progress: { analysis: true, scenarios: false, sasu: false } });
    submitAll(dir, planNow(dir), { "W2:요구-1": issue("unsupported", "홈 상단에 배너를 노출한다", "ask") });
    expect(loadRun(dir)).toMatchObject({ state: "answers_complete", rework: { analysis: 1 }, progress: { analysis: false, scenarios: false, sasu: false } });
    expect(respond(dir, [{ finding: "F-1", response: "asked", reason: "질문으로 올렸다" }])).toMatchObject({ round: 1, saved: 1 });
  });
});

describe("hew sasu respond: 명령줄", () => {
  it("저장하면 종료 0, 거부는 종료 3, 반송 중이 아니면 종료 4", () => {
    const { dir, fixId } = setupReturned();
    const run = loadRun(dir).run_id;
    const good = writeItemsFile(dir, "g.json", { responses: [{ finding: fixId, response: "fixed", reason: "고쳤다" }] });
    const ok = hew(["--json", "sasu", "respond", "--run", run, "--for", "analysis", "--file", good]);
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ ok: true, data: { for: "analysis", round: 1, saved: 1, total: 1 } });
    const bad = writeItemsFile(dir, "b.json", { responses: [{ finding: fixId, response: "rejected" }] });
    expect(hew(["--json", "sasu", "respond", "--run", run, "--for", "analysis", "--file", bad]).status).toBe(3);
    const other = makeRun("collected", {}, "rs-cli");
    expect(hew(["--json", "sasu", "respond", "--run", "rs-cli", "--for", "analysis", "--file", writeItemsFile(other.dir, "r.json", { responses: [] })]).status).toBe(4);
    expect(hew(["--json", "sasu", "respond", "--run", run, "--for", "x", "--file", good]).status).toBe(2);
  });
});

describe("다음 회차 계획: inputs.previous", () => {
  it("직전 회차에서 issue 였던 단위에만 previous(claim·kind·response)를 싣고, 답변이 없으면 response 가 없다", () => {
    const { dir, fixId } = setupReturned();
    respond(dir, [{ finding: fixId, response: "rejected", reason: "원문이 뒷받침한다", evidence: { unit_id: "U-4", quote: "배너는 최대 5개까지 노출한다" } }]);
    const plan2 = startNextRound(dir);
    const inputsOf = (id: string): Record<string, any> => {
      const b = plan2.batches.find((x) => x.unit_ids.includes(id));
      return readBatch(b?.path ?? "").units.find((u) => u.id === id)?.inputs ?? {};
    };
    expect(inputsOf("W2:요구-1").previous).toEqual({
      claim: "지적 내용",
      kind: "unsupported",
      response: { response: "rejected", reason: "원문이 뒷받침한다", evidence: { unit_id: "U-4", quote: "배너는 최대 5개까지 노출한다" } },
    });
    expect(inputsOf("W3:U-1").previous).toEqual({ claim: "지적 내용", kind: "missing" });
    // 직전에 ok 였던 단위는 재사용되어 묶음에 실리지 않는다.
    expect(plan2.units.find((u) => u.id === "W2:요구-2")).toMatchObject({ reuse: true, batch: null });
    const everyInput = plan2.batches.flatMap((b) => readBatch(b.path).units);
    expect(everyInput.filter((u) => "previous" in u.inputs).map((u) => u.id)).toEqual(["W2:요구-1", "W3:U-1"]);
  });

  it("previous 가 실린 묶음의 question 에만 답변을 읽고 다시 판정하라는 문장이 덧붙는다", () => {
    const { dir } = setupReturned();
    const plan2 = startNextRound(dir);
    const withPrev = plan2.batches.filter((b) => readBatch(b.path).units.some((u) => "previous" in u.inputs));
    expect(withPrev.length).toBeGreaterThan(0);
    for (const b of withPrev) expect(readBatch(b.path).question).toContain("답변이 근거를 들어 반박했고 그 근거가 맞으면 ok 다");
    for (const b of plan2.batches.filter((x) => !withPrev.includes(x))) expect(readBatch(b.path).question).not.toContain("previous");
  });

  it("hash 는 previous 를 빼고 계산해 단위의 hash 와 재사용 판정이 달라지지 않는다", () => {
    const { dir, fixId } = setupReturned();
    const plain = new Map(buildWorkUnits(dir).map((u) => [u.id, u.hash]));
    respond(dir, [{ finding: fixId, response: "fixed", reason: "고쳤다" }]);
    const plan2 = startNextRound(dir);
    for (const u of plan2.units) expect(u.hash).toBe(plain.get(u.id));
    // 2회차에서 ok 가 된 단위는 3회차에 hash 가 같으면 재사용된다.
    submitAll(dir, plan2);
    saveRun(dir, { ...loadRun(dir), state: "answers_complete", progress: { analysis: true, scenarios: false, sasu: false } });
    const plan3 = startNextRound(dir);
    expect(plan3.units.every((u) => u.reuse === true)).toBe(true);
  });

  it("사수가 근거로 quote 를 대도 previous 의 문장은 원문이 아니라 차단 근거로 인정되지 않는다", () => {
    const { dir } = setupReturned();
    const plan2 = startNextRound(dir);
    const r = submitAll(dir, plan2, { "W2:요구-1": issue("unsupported", "지적 내용", "fix", "U-4") });
    expect(r.completed).toMatchObject({ blocking: 0 });
  });
});
