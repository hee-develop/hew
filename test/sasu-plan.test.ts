import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEvents } from "../src/core/events.js";
import { runPaths } from "../src/core/paths.js";
import { loadRun } from "../src/core/run.js";
import { createPlan, splitBatches } from "../src/core/sasu/plan.js";
import { buildWorkUnits } from "../src/core/sasu/units.js";
import { BATCH_CHAR_LIMIT } from "../src/core/sasu/types.js";
import { submitArtifact } from "../src/core/submit.js";
import { buildAnalysis, buildUnits, clone, type Doc } from "./analysis-fixtures.js";
import { useTempRunsDir, writeItemsFile } from "./helpers.js";
import { buildScenarios } from "./scenarios-fixtures.js";
import { planNow, readBatch, setupQaDesigned, submitAll, type Overrides } from "./sasu-fixtures.js";

useTempRunsDir();

const unitsOf = (dir: string, code: string) => buildWorkUnits(dir).filter((u) => u.code === code);
const byId = (dir: string, id: string) => buildWorkUnits(dir).find((u) => u.id === id);

describe("사수 계획: 코드별 작업 단위", () => {
  it("합성 분석 문서에서 W2~W9 단위를 코드 순서로 만든다", () => {
    const { dir } = setupQaDesigned();
    const units = buildWorkUnits(dir);
    const counts: Record<string, number> = {};
    for (const u of units) counts[u.code] = (counts[u.code] ?? 0) + 1;
    expect(counts).toEqual({ W2: 3, W3: 7, W4: 1, W5: 1, W8: 2, W9: 3 });
    expect(units.map((u) => u.code)).toEqual([...units.map((u) => u.code)].sort());
    for (const u of units) {
      expect(u.id).toBe(`${u.code}:${u.target}`);
      expect(u.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(u.question.length).toBeGreaterThan(0);
    }
  });

  it("W1 단위는 만들지 않는다", () => {
    const { dir } = setupQaDesigned();
    expect(buildWorkUnits(dir).some((u) => u.code === ("W1" as string))).toBe(false);
  });

  it("W2: 제목, 변경 항목, 근거 단위의 id·text(이미지 근거는 절대 경로)", () => {
    const { dir } = setupQaDesigned();
    const inputs = byId(dir, "W2:요구-1")?.inputs as Record<string, any>;
    expect(inputs.title).toBe("홈에 배너를 노출한다");
    expect(inputs.changes[0]).toMatchObject({ text: "홈 상단에 배너를 노출한다", screen_id: "화면-1" });
    expect(inputs.changes[0].evidence[0]).toMatchObject({ unit_id: "U-1" });
    expect(inputs.changes[0].evidence[0].text).toContain("배너를");
    expect(inputs.changes[1].evidence[0]).toEqual({ unit_id: "U-6", image: join(dir, "sources/figma/s1.png") });
  });

  it("W3: 문서 단위와 figma_desc 하나씩. 웹 Figma 단위와 figma_screen 은 대상이 아니다", () => {
    const { dir } = setupQaDesigned();
    const targets = unitsOf(dir, "W3").map((u) => u.target);
    expect(targets).toEqual(["U-1", "U-2", "U-3", "U-4", "U-5", "U-7", "U-9"]);
  });

  it("W3: 웹·모바일웹 플랫폼의 figma_desc 도 대상이 아니다", () => {
    const units = buildUnits();
    units.push({ id: "U-10", source_id: "S-2", kind: "figma_desc", locator: { node_id: "1:9", name: "d" }, text: "웹 설명", platform: "web" });
    units.push({ id: "U-11", source_id: "S-2", kind: "figma_desc", locator: { node_id: "1:10", name: "d" }, text: "모웹 설명", platform: "mobile_web" });
    const { dir } = setupQaDesigned({ units });
    expect(unitsOf(dir, "W3").map((u) => u.target)).not.toContain("U-10");
    expect(unitsOf(dir, "W3").map((u) => u.target)).not.toContain("U-11");
  });

  it("W3: 단위 본문·열·주체, 범위 장부 행, 그 단위를 근거로 든 요구의 제목과 변경 문장", () => {
    const { dir } = setupQaDesigned();
    const u1 = byId(dir, "W3:U-1")?.inputs as Record<string, any>;
    expect(u1).toMatchObject({ actor: "provider", columns: { 기능: "배너를 노출한다" } });
    expect(u1.coverage).toEqual([{ id: "C-1", disposition: "covered" }]);
    expect(u1.requirements).toEqual([{ id: "요구-1", title: "홈에 배너를 노출한다", changes: ["홈 상단에 배너를 노출한다", "배너가 없으면 빈 상태를 보인다"] }]);
    const u2 = byId(dir, "W3:U-2")?.inputs as Record<string, any>;
    expect(u2.coverage).toEqual([{ id: "C-2", disposition: "not_app", reason: "운영자 어드민 입력" }]);
    expect(u2.requirements).toEqual([]);
  });

  it("W4: confirmed 요구만. 근거 단위 text 와 같은 절의 이웃 단위 text", () => {
    const { dir } = setupQaDesigned();
    const w4 = unitsOf(dir, "W4");
    expect(w4.map((u) => u.target)).toEqual(["요구-3"]);
    const inputs = w4[0]?.inputs as Record<string, any>;
    expect(inputs.evidence_units).toEqual([{ id: "U-3", text: "원가가 입력되지 않은 팩은 판매가만 노출한다" }]);
    const neighborIds = inputs.neighbors.map((n: any) => n.id);
    expect(neighborIds).toEqual(["U-1", "U-2", "U-4", "U-5", "U-9"]);
  });

  it("W4: 이웃 단위는 최대 12개", () => {
    const units = buildUnits();
    for (let n = 20; n < 40; n += 1) units.push({ id: `U-${n}`, source_id: "S-1", kind: "bullet", locator: { section: ["요구"], index: n }, text: `이웃 ${n}` });
    const { dir } = setupQaDesigned({ units, analysis: (doc) => void (doc.coverage[2].unit_ids.push(...Array.from({ length: 20 }, (_, i) => `U-${20 + i}`))) });
    const inputs = unitsOf(dir, "W4")[0]?.inputs as Record<string, any>;
    expect(inputs.neighbors).toHaveLength(12);
  });

  it("W5: ai.notes 가 있는 요구만. 사람용 칸과 ai.notes 의 text", () => {
    const { dir } = setupQaDesigned();
    const w5 = unitsOf(dir, "W5");
    expect(w5.map((u) => u.target)).toEqual(["요구-1"]);
    expect(w5[0]?.inputs).toEqual({
      title: "홈에 배너를 노출한다",
      changes: ["홈 상단에 배너를 노출한다", "배너가 없으면 빈 상태를 보인다"],
      acceptance: [{ id: "요구-1/AC-1", when: "홈에 진입한다", then: "배너가 보인다" }],
      ai_notes: ["배너는 최대 5개"],
    });
  });

  it("W6: 근거로 쓰인 table_row 중 actor 가 없는 것만", () => {
    const units = buildUnits();
    const row = units[0];
    if (row === undefined) throw new Error("fixture");
    delete row.actor;
    const { dir } = setupQaDesigned({ units });
    const w6 = unitsOf(dir, "W6");
    expect(w6.map((u) => u.target)).toEqual(["U-1"]);
    expect(w6[0]?.inputs).toMatchObject({ text: row.text, columns: row.columns });
  });

  it("W6: 근거로 쓰이지 않은 actor 없는 행은 대상이 아니다", () => {
    const units = buildUnits();
    units.push({ id: "U-10", source_id: "S-1", kind: "table_row", locator: { section: ["요구"], index: 10 }, text: "주체 없는 행", columns: { a: "b" } });
    const { dir } = setupQaDesigned({ units, analysis: (doc) => void doc.coverage[2].unit_ids.push("U-10") });
    expect(unitsOf(dir, "W6")).toEqual([]);
  });

  it("W7: 화면은 그 화면의 변경과 모든 변형의 변경을, 변형은 직접 걸린 변경과 부모 화면 전체의 변경을 구분해 싣는다", () => {
    const { dir } = setupQaDesigned({
      analysis: (doc) => {
        doc.screens[0].images = [{ role: "as_is", path: "sources/figma/a.png" }, { role: "to_be", path: "sources/figma/b.png" }];
        doc.screens[0].variants[0].images = [{ role: "as_is", path: "sources/figma/v-a.png" }, { role: "to_be", path: "sources/figma/v-b.png" }];
        // screen_id 가 없지만 요구의 screen_ids 에 화면-1 이 있는 변경.
        doc.requirements[1].changes.push({ text: "화면 전체에 적용되는 변경", evidence: [{ unit_id: "U-4", quote: "최대 5개까지" }] });
      },
    });
    const w7 = unitsOf(dir, "W7");
    expect(w7.map((u) => u.target)).toEqual(["화면-1", "화면-1.1"]);
    expect(w7[0]?.inputs).toEqual({
      as_is: join(dir, "sources/figma/a.png"),
      to_be: join(dir, "sources/figma/b.png"),
      changes_for_screen: ["홈 상단에 배너를 노출한다", "6번째부터는 그리지 않는다", "화면 전체에 적용되는 변경"],
      changes_for_variants: ["배너가 없으면 빈 상태를 보인다"],
    });
    expect(w7[1]?.inputs).toEqual({
      as_is: join(dir, "sources/figma/v-a.png"),
      to_be: join(dir, "sources/figma/v-b.png"),
      changes_for_variant: ["배너가 없으면 빈 상태를 보인다"],
      changes_for_screen: ["홈 상단에 배너를 노출한다", "6번째부터는 그리지 않는다", "화면 전체에 적용되는 변경"],
    });
  });

  it("W7: 변형만 이미지가 있어도 부모 화면의 변경이 실리고, 묶음의 질문이 화면 전체 변경까지 보라고 말한다", () => {
    const { dir } = setupQaDesigned({
      analysis: (doc) => {
        doc.screens[0].variants[0].images = [{ role: "as_is", path: "sources/figma/v-a.png" }, { role: "to_be", path: "sources/figma/v-b.png" }];
      },
    });
    const w7 = unitsOf(dir, "W7");
    expect(w7.map((u) => u.target)).toEqual(["화면-1.1"]);
    expect((w7[0]?.inputs as Record<string, any>).changes_for_screen).toEqual(["홈 상단에 배너를 노출한다", "6번째부터는 그리지 않는다"]);
    const batch = planNow(dir).batches.find((b) => b.code === "W7");
    expect(readBatch(batch?.path ?? "").question).toContain("이 변형과 그 화면 전체에 걸린 변경 항목 어디에도 없는 눈에 보이는 차이");
  });

  it("W7: 한쪽 이미지만 있거나 both 이미지뿐이면 대상이 아니다", () => {
    const { dir } = setupQaDesigned();
    expect(unitsOf(dir, "W7")).toEqual([]);
  });

  it("W8: comparison.rows 가 있는 차이. 비교 행과 양쪽 인용·단위 text", () => {
    const { dir } = setupQaDesigned();
    const w8 = unitsOf(dir, "W8");
    expect(w8.map((u) => u.target)).toEqual(["D-1", "D-2"]);
    const d1 = w8[0]?.inputs as Record<string, any>;
    expect(d1.rows).toEqual([{ aspect: "최대 개수", prd: "5개", figma: "3개" }]);
    expect(d1.prd_evidence[0]).toMatchObject({ unit_id: "U-4", quote: "최대 5개", text: "배너는 최대 5개까지 노출한다" });
    expect(d1.figma_evidence[0]).toMatchObject({ unit_id: "U-7", quote: "최대 5개" });
  });

  it("W8: 비교 행이 없는 차이는 대상이 아니다", () => {
    const { dir } = setupQaDesigned({ analysis: (doc) => void (doc.deltas[1].comparison = { rows: [] }) });
    expect(unitsOf(dir, "W8").map((u) => u.target)).toEqual(["D-1"]);
  });

  it("W9: analysis 와 scenarios 의 질문 모두. 선택지, rationale, affects 요구의 근거 단위 text", () => {
    const { dir } = setupQaDesigned();
    const w9 = unitsOf(dir, "W9");
    expect(w9.map((u) => u.target)).toEqual(["Q-1", "Q-2", "Q-3"]);
    const q1 = w9[0]?.inputs as Record<string, any>;
    expect(q1.options.map((o: any) => o.key)).toEqual(["a", "b"]);
    expect(q1.rationale[0]).toMatchObject({ unit_id: "U-3", quote: "판매가만 노출한다" });
    expect(q1.affects[0]).toMatchObject({ id: "요구-1" });
    expect(q1.affects[0].units.map((u: any) => u.id)).toEqual(["U-1", "U-6", "U-4"]);
    const q3 = w9[2]?.inputs as Record<string, any>;
    expect(q3.affects.map((a: any) => a.id)).toEqual(["요구-1"]);
  });

  it("W9: 사람이 이미 답한 질문과 origin 이 sasu 인 질문은 대상이 아니다", () => {
    const { dir } = setupQaDesigned({
      analysis: (doc) =>
        doc.questions.push({ id: "Q-9", text: "사수 확인(W2:요구-1, unsupported): x 어떻게 처리할까요?", origin: "sasu", blocking: true, options: [{ key: "fix", label: "고침", consequence: "고친다" }], rationale: [], affects: ["요구-1"], audience: [] }),
    });
    expect(unitsOf(dir, "W9").map((u) => u.target)).toEqual(["Q-1", "Q-2", "Q-3"]);
    writeAnswers(dir, { "Q-1": { option: "a", at: "t" } });
    expect(unitsOf(dir, "W9").map((u) => u.target)).toEqual(["Q-2", "Q-3"]);
  });
});

function writeAnswers(dir: string, answers: Record<string, unknown>): void {
  writeItemsFile(join(dir, "doc"), "answers.json", { answers });
}

describe("사수 계획: 묶음 크기 규칙", () => {
  const mk = (code: string, n: number, size = 10) =>
    Array.from({ length: n }, (_, i) => ({ id: `${code}:T-${i + 1}`, code: code as any, inputs: { t: "가".repeat(size) } }));

  it("같은 코드끼리 20개 이하로 묶는다", () => {
    const batches = splitBatches(mk("W3", 45));
    expect(batches.map((b) => b.unit_ids.length)).toEqual([20, 20, 5]);
  });

  it("코드가 바뀌면 묶음을 새로 시작한다", () => {
    const batches = splitBatches([...mk("W2", 3), ...mk("W3", 2), ...mk("W9", 1)]);
    expect(batches.map((b) => [b.code, b.unit_ids.length])).toEqual([["W2", 3], ["W3", 2], ["W9", 1]]);
  });

  it("W7 은 묶음당 4개 이하", () => {
    expect(splitBatches(mk("W7", 9)).map((b) => b.unit_ids.length)).toEqual([4, 4, 1]);
  });

  it("inputs JSON 글자 수 합이 60,000자를 넘지 않게 나눈다", () => {
    const size = 14_000;
    const batches = splitBatches(mk("W3", 10, size));
    const per = JSON.stringify({ t: "가".repeat(size) }).length;
    for (const b of batches) expect(per * b.unit_ids.length).toBeLessThanOrEqual(BATCH_CHAR_LIMIT);
    expect(batches.map((b) => b.unit_ids.length)).toEqual([4, 4, 2]);
  });

  it("혼자서 상한을 넘는 단위는 단독 묶음", () => {
    const batches = splitBatches([...mk("W3", 1), ...mk("W3", 1, 70_000).map((u) => ({ ...u, id: "W3:큰것" })), ...mk("W3", 1).map((u) => ({ ...u, id: "W3:뒤" }))]);
    expect(batches.map((b) => b.unit_ids)).toEqual([["W3:T-1"], ["W3:큰것"], ["W3:뒤"]]);
  });
});

describe("사수 계획: 저장", () => {
  it("계획과 묶음 파일을 쓴다(회차 1, 재사용 없음)", () => {
    const { dir } = setupQaDesigned();
    const { plan, created, completed } = createPlan(dir, "analysis");
    const p = runPaths(dir);
    expect(created).toBe(true);
    expect(completed).toBeNull();
    expect(plan).toMatchObject({ for: "analysis", round: 1 });
    expect(plan.units).toHaveLength(17);
    expect(plan.batches.map((b) => [b.k, b.code, b.unit_ids.length])).toEqual([[1, "W2", 3], [2, "W3", 7], [3, "W4", 1], [4, "W5", 1], [5, "W8", 2], [6, "W9", 3]]);
    expect(plan.batches[0]?.path).toBe(join(p.work, "sasu-analysis-1", "batch-1.json"));
    expect(JSON.parse(readFileSync(join(p.doc, "sasu", "analysis-1.plan.json"), "utf8"))).toEqual(plan);
    expect(plan.units.every((u) => u.reuse === undefined && u.batch !== null)).toBe(true);
    const batch = readBatch(plan.batches[0]?.path ?? "");
    expect(batch).toMatchObject({ for: "analysis", round: 1, batch: 1, code: "W2" });
    expect(batch.question).toContain("변경 항목");
    expect(batch.units.map((u) => u.id)).toEqual(["W2:요구-1", "W2:요구-2", "W2:요구-3"]);
    expect(Object.keys(batch.units[0] ?? {})).toEqual(["id", "target", "inputs"]);
    expect(readEvents(p.events).some((e) => e.type === "sasu_planned")).toBe(true);
  });

  it("같은 회차에 다시 부르면 만들어 둔 계획을 그대로 돌려준다", () => {
    const { dir } = setupQaDesigned();
    const first = createPlan(dir, "analysis");
    const second = createPlan(dir, "analysis");
    expect(second.created).toBe(false);
    expect(second.plan).toEqual(first.plan);
  });

  it("분해안 차례가 아닌 상태에서 --for plan 은 종료 4", () => {
    const { dir } = setupQaDesigned();
    expect(() => createPlan(dir, "plan")).toThrow(/분해안용 사수 계획을 만들 수 없습니다/);
  });

  it("사수 차례가 아닌 상태에서는 종료 4", () => {
    const { dir } = setupQaDesigned();
    submitAll(dir, planNow(dir));
    expect(loadRun(dir).state).toBe("checked");
    try {
      createPlan(dir, "analysis");
      expect.unreachable();
    } catch (e) {
      expect((e as { exitCode: number }).exitCode).toBe(4);
    }
  });
});

describe("사수 계획: 바뀐 것만 다시", () => {
  /** 1회차에서 overrides 를 내 반송(collected)시키고, 분석을 mutate 로 고쳐 다시 내 qa_designed 로 돌아온다. */
  function secondRound(overrides: Overrides, mutate: (doc: Doc) => void): { dir: string } {
    const { dir } = setupQaDesigned();
    submitAll(dir, planNow(dir), overrides);
    expect(loadRun(dir).state).toBe("collected");
    const doc = clone(buildAnalysis());
    mutate(doc);
    submitArtifact({ runDir: dir, kind: "analysis", file: writeItemsFile(dir, "a2.json", doc) });
    submitArtifact({ runDir: dir, kind: "scenarios", file: writeItemsFile(dir, "s2.json", buildScenarios()) });
    expect(loadRun(dir).state).toBe("qa_designed");
    return { dir };
  }

  const issue = (quote: string): Overrides[string] => ({ verdict: "issue", kind: "unsupported", claim: "근거가 없다", evidence: { unit_id: "U-4", quote }, action: "fix" });

  it("hash 가 같은 단위는 다시 돌리지 않고 직전 판정을 가져온다(reuse), 바뀐 요구만 다시 돌린다", () => {
    // 1회차에서 W2:요구-1 만 issue. 2회차에서 요구-1 을 고친다.
    const { dir } = secondRound({ "W2:요구-1": issue("홈 상단에 배너를 노출한다") }, (doc) => {
      doc.requirements[0].title = "홈 상단에 배너를 노출한다";
    });
    const { plan } = createPlan(dir, "analysis");
    expect(plan.round).toBe(2);
    const rerun = plan.units.filter((u) => u.reuse !== true).map((u) => u.id);
    expect(rerun).toContain("W2:요구-1");
    expect(rerun).not.toContain("W2:요구-2");
    expect(rerun).not.toContain("W2:요구-3");
    expect(plan.units.find((u) => u.id === "W2:요구-2")).toMatchObject({ reuse: true, batch: null });
    expect(plan.units.find((u) => u.id === "W2:요구-1")?.batch).not.toBeNull();
    const inBatches = plan.batches.flatMap((b) => b.unit_ids);
    expect(inBatches.sort()).toEqual([...rerun].sort());
    expect(rerun.length).toBeLessThan(plan.units.length);
  });

  it("직전 판정이 issue 였던 단위는 hash 가 같아도 다시 돌린다", () => {
    const { dir } = secondRound({ "W2:요구-2": issue("최대 5개까지"), "W2:요구-1": issue("홈 상단에 배너를 노출한다") }, (doc) => {
      doc.requirements[0].title = "홈 상단에 배너를 노출한다";
    });
    const { plan } = createPlan(dir, "analysis");
    expect(plan.units.find((u) => u.id === "W2:요구-2")).toMatchObject({ batch: expect.any(Number) });
    expect(plan.units.find((u) => u.id === "W2:요구-2")?.reuse).toBeUndefined();
  });

  it("차단하지 않는 issue(근거 없음)도 ok 가 아니므로 다시 돌린다", () => {
    // 근거 없는 issue 1건 + 차단 지적 1건(반송을 만들기 위해)
    const { dir } = secondRound(
      { "W2:요구-3": { verdict: "issue", kind: "unsupported", claim: "참고", action: "fix" }, "W2:요구-1": issue("홈 상단에 배너를 노출한다") },
      (doc) => void (doc.requirements[0].title = "다른 제목"),
    );
    const { plan } = createPlan(dir, "analysis");
    expect(plan.units.find((u) => u.id === "W2:요구-3")?.reuse).toBeUndefined();
  });

  it("재사용한 판정은 회차 정본에 reused 로 실린다", () => {
    const { dir } = secondRound({ "W2:요구-1": issue("홈 상단에 배너를 노출한다") }, (doc) => void (doc.requirements[0].title = "홈 상단에 배너를 노출한다"));
    const plan = planNow(dir);
    submitAll(dir, plan);
    const doc = JSON.parse(readFileSync(join(runPaths(dir).findingsDir, "analysis-2.json"), "utf8")) as { items: { findings: Record<string, any>[] } };
    const reused = doc.items.findings.filter((f) => f.reused === true);
    expect(reused.length).toBe(plan.units.filter((u) => u.reuse === true).length);
    expect(doc.items.findings).toHaveLength(plan.units.length);
    expect(doc.items.findings.map((f) => f.id)).toEqual(plan.units.map((_, i) => `F-${i + 1}`));
  });

  it("바뀐 단위가 0개이면 묶음도 0개이고 회차가 곧바로 완료 처리된다", () => {
    // 1회차: 요구-1 issue 로 반송. 2회차: 분석을 그대로(요구-1 도 그대로) 다시 낸다 -> 요구-1 만 직전 issue 라 다시 돈다.
    // 0묶음을 만들려면 직전 판정이 모두 ok 여야 하므로, 1회차는 ok 로 모두 통과시키되 answers_complete 에서 다시 돈다.
    const { dir } = setupQaDesigned();
    submitAll(dir, planNow(dir));
    expect(loadRun(dir).state).toBe("checked");
    // 게이트를 건너뛰고 answers_complete 로 두고 같은 분석·시나리오를 다시 낸 것으로 본다.
    const run = loadRun(dir);
    expect(run.submissions.findings_analysis?.attempt).toBe(1);
    const p = runPaths(dir);
    const raw = JSON.parse(readFileSync(p.runJson, "utf8"));
    raw.state = "answers_complete";
    raw.progress = { analysis: true, scenarios: true, sasu: false };
    writeItemsFile(dir, "run.json", raw);
    const result = createPlan(dir, "analysis");
    expect(result.plan.round).toBe(2);
    expect(result.plan.batches).toEqual([]);
    expect(result.plan.units.every((u) => u.reuse === true && u.batch === null)).toBe(true);
    expect(result.completed).toMatchObject({ round: 2, state: "checked", blocking: 0 });
    expect(existsSync(join(p.findingsDir, "analysis-2.json"))).toBe(true);
    expect(loadRun(dir).state).toBe("checked");
  });
});

describe("사수 입력: W2·W3 의 linked 와 status", () => {
  const unitOf = (dir: string, id: string): Record<string, any> => buildWorkUnits(dir).find((u) => u.id === id)?.inputs as Record<string, any>;

  it("W2 는 status 와, 요구에 걸린 차이·질문·가정을 linked 로 싣는다", () => {
    const { dir } = setupQaDesigned();
    const w1 = unitOf(dir, "W2:요구-1");
    expect(w1.status).toBe("pending");
    expect(w1.linked.deltas).toEqual([{ id: "D-2", kind: "figma_only", title: "빈 상태는 시안에만 있다", rows: [{ aspect: "빈 상태", figma: "문구 노출" }] }]);
    expect(w1.linked.questions).toEqual([{ id: "Q-1", text: "배너를 탭하면 어디로 이동하나요" }]);
    expect(w1.linked.assumptions).toEqual([]);
    const w2 = unitOf(dir, "W2:요구-2");
    expect(w2.linked.deltas.map((d: Doc) => d.id)).toEqual(["D-1"]);
    expect(w2.linked.assumptions).toEqual([{ id: "A-1", text: "배너는 서버가 정렬해 준다" }]);
    expect(unitOf(dir, "W2:요구-3")).toMatchObject({ status: "confirmed", linked: { deltas: [], questions: [], assumptions: [] } });
  });

  it("시나리오 질문도 affects 에 요구가 있으면 싣는다", () => {
    const { dir } = setupQaDesigned();
    const doc = JSON.parse(readFileSync(runPaths(dir).scenarios, "utf8"));
    doc.items.questions[0].affects = ["요구-3"];
    writeFileSync(runPaths(dir).scenarios, JSON.stringify(doc));
    expect(unitOf(dir, "W2:요구-3").linked.questions.map((q: Doc) => q.id)).toEqual(["Q-3"]);
  });

  it("W3 는 그 단위를 근거로 든 차이·질문과 요구들의 status 를 linked 로 싣는다", () => {
    const { dir } = setupQaDesigned();
    const u4 = unitOf(dir, "W3:U-4");
    expect(u4.linked.deltas.map((d: Doc) => d.id)).toEqual(["D-1"]);
    expect(u4.linked.requirements).toEqual([{ id: "요구-1", status: "pending" }, { id: "요구-2", status: "pending" }]);
    const u3 = unitOf(dir, "W3:U-3");
    expect(u3.linked.questions).toEqual([{ id: "Q-1", text: "배너를 탭하면 어디로 이동하나요" }]);
    expect(u3.linked.requirements).toEqual([{ id: "요구-3", status: "confirmed" }]);
    expect(unitOf(dir, "W3:U-7").linked.deltas.map((d: Doc) => d.id)).toEqual(["D-1", "D-2"]);
  });

  it("묶음의 W2·W3 질문 끝에 linked 안내가 붙고, linked 가 바뀌면 hash 가 달라진다", () => {
    const { dir } = setupQaDesigned();
    const plan = planNow(dir);
    for (const code of ["W2", "W3"]) {
      const b = plan.batches.find((x) => x.code === code);
      expect(readBatch(b?.path ?? "").question).toContain("`linked` 에 없는 어긋남만 지적한다.");
    }
    expect(readBatch(plan.batches.find((x) => x.code === "W4")?.path ?? "").question).not.toContain("linked");
    const before = buildWorkUnits(dir).find((u) => u.id === "W2:요구-3")?.hash;
    const doc = JSON.parse(readFileSync(runPaths(dir).analysis, "utf8"));
    doc.items.assumptions.push({ id: "A-2", text: "새 가정", basis: "b", requirement_ids: ["요구-3"] });
    writeFileSync(runPaths(dir).analysis, JSON.stringify(doc));
    expect(buildWorkUnits(dir).find((u) => u.id === "W2:요구-3")?.hash).not.toBe(before);
  });
});
