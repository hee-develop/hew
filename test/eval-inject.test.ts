import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnalysisItemsSchema, type AnalysisItems } from "../src/core/analysis/schema.js";
import { HewError } from "../src/core/errors.js";
import { readEvents } from "../src/core/events.js";
import { injectAll, injectDefect } from "../src/core/eval/inject.js";
import { EVAL_KINDS, type EvalKind } from "../src/core/eval/kinds.js";
import { alterText, findCandidates } from "../src/core/eval/mutate.js";
import { collectRunOpen } from "../src/core/open.js";
import { evalPaths, runPaths } from "../src/core/paths.js";
import { computeRevision } from "../src/core/revision.js";
import { loadRun } from "../src/core/run.js";
import { createPlan } from "../src/core/sasu/plan.js";
import type { Unit } from "../src/core/units/types.js";
import { buildEvalAnalysis, buildEvalUnits, setupEvalSource } from "./eval-fixtures.js";
import { useTempRunsDir } from "./helpers.js";
import { readBatch } from "./sasu-fixtures.js";

const runs = useTempRunsDir();
const BIN = join(import.meta.dirname, "..", "bin", "hew");
const hew = (args: string[]) => spawnSync(BIN, args, { env: { ...process.env, HEW_RUNS_DIR: runs.dir }, encoding: "utf8" });

const items = (dir: string): AnalysisItems => AnalysisItemsSchema.parse((JSON.parse(readFileSync(runPaths(dir).analysis, "utf8")) as { items: unknown }).items);
const injection = (dir: string) => JSON.parse(readFileSync(evalPaths(dir).injection, "utf8")) as Record<string, any>;

/** 원본의 분석 정본을 검사 없이 직접 고친다. */
function rewriteAnalysis(dir: string, edit: (doc: Record<string, any>) => void): void {
  const file = runPaths(dir).analysis;
  const doc = JSON.parse(readFileSync(file, "utf8")) as { items: Record<string, any> };
  edit(doc.items);
  writeFileSync(file, JSON.stringify(doc));
}

/** 후보를 id 순으로 늘어놓았을 때 시드 0, 1, 2, 3 이 가리키는 expected. */
const EXPECTED: Record<EvalKind, string[]> = {
  w3_delete: ["W3:U-1", "W3:U-10", "W3:U-12", "W3:U-1"],
  w2_alter: ["W2:요구-1", "W2:요구-2", "W2:요구-4", "W2:요구-4"],
  w4_confirm: ["W4:요구-1", "W4:요구-2", "W4:요구-4", "W4:요구-1"],
  w5_ainote: ["W5:요구-1", "W5:요구-2", "W5:요구-3", "W5:요구-4"],
  w7_drop_visual: ["W7:화면-1.1", "W7:화면-2", "W7:화면-1.1", "W7:화면-2"],
  w8_pair: ["W8:D-1", "W8:D-3", "W8:D-1", "W8:D-3"],
};

const COUNT: Record<EvalKind, number> = { w3_delete: 3, w2_alter: 4, w4_confirm: 3, w5_ainote: 4, w7_drop_visual: 2, w8_pair: 2 };

describe("alterText", () => {
  it("첫 숫자에 2 를 더하되 % 나 px 앞 숫자를 먼저 본다", () => {
    expect(alterText("배너를 최대 5개 노출한다")).toBe("배너를 최대 7개 노출한다");
    expect(alterText("3개를 12px 간격으로")).toBe("3개를 14px 간격으로");
    expect(alterText("할인율 10% 적용, 3개")).toBe("할인율 12% 적용, 3개");
  });

  it("숫자가 없으면 낱말 하나를 반대로 바꾼다(앞선 규칙 먼저)", () => {
    expect(alterText("24시간 이내".replace("24", ""))).toBe("시간 이후");
    expect(alterText("종료일 이전에 보인다")).toBe("종료일 이후에 보인다");
    expect(alterText("항목을 추가한다")).toBe("항목을 없앤다");
    expect(alterText("아이콘이 글자 위에 보인다")).toBe("아이콘이 글자 아래에 보인다");
    expect(alterText("문구가 보인다")).toBe("문구가 숨긴다");
    expect(alterText("버튼이 숨긴다")).toBe("버튼이 보인다");
  });

  it("'위' 는 다른 낱말 속 글자로는 바꾸지 않고, 바꿀 곳이 없으면 null", () => {
    expect(alterText("위치를 정한다")).toBeNull();
    expect(alterText("위해 노력한다")).toBeNull();
    expect(alterText("내용을 정한다")).toBeNull();
  });
});

describe("후보 찾기", () => {
  it("합성 자료는 종류마다 후보 수가 정해진 대로다", () => {
    const parsed = AnalysisItemsSchema.parse(buildEvalAnalysis());
    for (const kind of EVAL_KINDS) expect(findCandidates(kind, parsed, buildEvalUnits()).map((c) => c.expected)).toEqual(EXPECTED[kind].slice(0, COUNT[kind]));
  });

  it("w3 는 다른 변경·ai.notes 가 인용한 단위, 요구의 변경이 하나뿐인 요구, 문서 단위가 아닌 근거를 후보에서 뺀다", () => {
    const base = AnalysisItemsSchema.parse(buildEvalAnalysis());
    // 요구-2 변경 0(U-4)은 요구-1 의 ai.notes 가 인용한다.
    expect(findCandidates("w3_delete", base, buildEvalUnits()).map((c) => c.id)).not.toContain("요구-2#0");
    const cited = structuredClone(base);
    cited.requirements[2]?.ai.notes.push({ text: "알림", evidence: [{ unit_id: "U-10", quote: "24시간 이내" }] });
    expect(findCandidates("w3_delete", cited, buildEvalUnits()).map((c) => c.expected)).toEqual(["W3:U-1", "W3:U-12"]);
    const single = structuredClone(base);
    for (const r of single.requirements) r.changes = r.changes.slice(0, 1);
    expect(findCandidates("w3_delete", single, buildEvalUnits())).toEqual([]);
    const figma: Unit[] = buildEvalUnits().map((u) => (u.id === "U-1" ? { ...u, kind: "figma_desc" as const } : u));
    expect(findCandidates("w3_delete", base, figma).map((c) => c.expected)).toEqual(["W3:U-10", "W3:U-12"]);
  });

  it("w7 은 이미지 근거만 가진 변경 중 AS-IS·TO-BE 가 모두 있는 화면에 걸린 것만, 요구의 변경이 하나뿐이면 뺀다", () => {
    const base = AnalysisItemsSchema.parse(buildEvalAnalysis());
    const noPair = structuredClone(base);
    (noPair.screens[1] as { images: unknown }).images = [{ role: "to_be", path: "x.png" }];
    expect(findCandidates("w7_drop_visual", noPair, buildEvalUnits()).map((c) => c.expected)).toEqual(["W7:화면-1.1"]);
    const single = structuredClone(base);
    for (const r of single.requirements) r.changes = r.changes.slice(0, 1);
    expect(findCandidates("w7_drop_visual", single, buildEvalUnits())).toEqual([]);
  });

  it("w7 은 변경에 screen_id 가 없으면 요구의 대표 화면으로 잡는다", () => {
    const base = AnalysisItemsSchema.parse(buildEvalAnalysis());
    delete (base.requirements[1]?.changes[1] as { screen_id?: string }).screen_id;
    base.requirements[1]!.screen_ids = ["화면-2"];
    expect(findCandidates("w7_drop_visual", base, buildEvalUnits()).map((c) => c.expected)).toEqual(["W7:화면-1.1", "W7:화면-2"]);
  });

  it("w8 은 figma 칸이 서로 다른 짝지어진 행이 둘 이상인 차이만 후보다", () => {
    const base = AnalysisItemsSchema.parse(buildEvalAnalysis());
    const same = structuredClone(base);
    for (const row of same.deltas[0]!.comparison!.rows) row.figma = "같음";
    expect(findCandidates("w8_pair", same, buildEvalUnits()).map((c) => c.expected)).toEqual(["W8:D-3"]);
    const unpaired = structuredClone(base);
    delete (unpaired.deltas[2]!.comparison!.rows[1] as { prd?: string }).prd;
    expect(findCandidates("w8_pair", unpaired, buildEvalUnits()).map((c) => c.expected)).toEqual(["W8:D-1"]);
  });

  it("w4 는 미정 표시가 근거 단위나 이웃 단위(앞 12개 안)에 있는 pending 요구만 후보다", () => {
    const base = AnalysisItemsSchema.parse(buildEvalAnalysis());
    const clean = buildEvalUnits().map((u) => ({ ...u, text: u.text.replace("TBD", "정함").replace("미정", "정함").replace("논의 필요", "없음") }));
    expect(findCandidates("w4_confirm", base, clean)).toEqual([]);
    const otherSection = clean.map((u) => (u.id === "U-5" ? { ...u, text: "문단(확인 필요)", locator: { section: ["다른 절"], index: 5 } } : u));
    expect(findCandidates("w4_confirm", base, otherSection)).toEqual([]);
    const filler = (n: number): Unit => ({ id: `U-${20 + n}`, source_id: "S-1", kind: "bullet", locator: { section: ["요구"], index: 20 + n }, text: `채움 ${n}` });
    const late = [...clean.filter((u) => u.id !== "U-13"), ...Array.from({ length: 12 }, (_, n) => filler(n)), { ...filler(99), text: "문구는 TBD" }];
    expect(findCandidates("w4_confirm", base, late)).toEqual([]);
    const inCited = clean.map((u) => (u.id === "U-10" ? { ...u, text: `${u.text} 명확화 필요` } : u));
    expect(findCandidates("w4_confirm", base, inCited).map((c) => c.expected)).toEqual(["W4:요구-4"]);
  });
});

describe.each(EVAL_KINDS)("hew eval inject %s", (kind) => {
  it("같은 원본·종류·시드면 같은 결과, 시드가 다르면 다른 후보를 심는다", () => {
    const { dir } = setupEvalSource();
    const a = injectDefect({ source: dir, kind, seed: 0, outId: "inj-a" });
    const b = injectDefect({ source: dir, kind, seed: 0, outId: "inj-b" });
    expect(items(a.dir)).toEqual(items(b.dir));
    const { run_id: _x, dir: _y, ...left } = a;
    const { run_id: _z, dir: _w, ...right } = b;
    expect(left).toEqual(right);
    const c = injectDefect({ source: dir, kind, seed: 1, outId: "inj-c" });
    expect(c.target).not.toEqual(a.target);
    expect(items(c.dir)).not.toEqual(items(a.dir));
  });

  it("expected 가 시드마다 정해진 작업 단위 id 이고 후보 수가 맞다", () => {
    const { dir } = setupEvalSource();
    EXPECTED[kind].forEach((expected, seed) => {
      const r = injectDefect({ source: dir, kind, seed });
      expect(r.expected).toBe(expected);
      expect(r.candidates).toBe(COUNT[kind]);
    });
  });

  it("변형 뒤에도 스키마를 통과하고 원본과 다르며, injection.json 에 기록된다", () => {
    const { dir } = setupEvalSource();
    const r = injectDefect({ source: dir, kind, seed: 1 });
    expect(AnalysisItemsSchema.safeParse((JSON.parse(readFileSync(runPaths(r.dir).analysis, "utf8")) as { items: unknown }).items).success).toBe(true);
    expect(items(r.dir)).not.toEqual(items(dir));
    const file = injection(r.dir);
    expect(file).toMatchObject({ source_run: loadRun(dir).run_id, kind, seed: 1, expected: EXPECTED[kind][1], candidates: COUNT[kind] });
    expect(file.target).toBeTypeOf("object");
    expect(file).toHaveProperty("before");
    expect(file).toHaveProperty("after");
    expect(file.checks_after).toEqual([]);
    expect(file.before).not.toEqual(file.after);
  });

  it("후보가 없으면 종료 3(rejected)이고 실행 폴더를 만들지 않는다", () => {
    const { dir } = setupEvalSource();
    rewriteAnalysis(dir, (doc) => {
      doc.requirements = [];
      doc.deltas = [];
    });
    try {
      injectDefect({ source: dir, kind, seed: 1, outId: "inj-none" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HewError);
      expect((e as HewError).exitCode).toBe(3);
      expect((e as HewError).message).toContain("이 원본에서는 이 종류를 심을 수 없습니다");
    }
    expect(existsSync(join(runs.dir, "inj-none"))).toBe(false);
  });
});

describe("주입 뒤 사수 계획에 expected 단위가 있다", () => {
  function planAfter(kind: EvalKind, seed: number): { dir: string; expected: string; unit: Record<string, any> } {
    const { dir: source } = setupEvalSource();
    const r = injectDefect({ source, kind, seed });
    const plan = createPlan(r.dir, "analysis").plan;
    expect(plan.units.map((u) => u.id)).toContain(r.expected);
    const batch = plan.batches.find((b) => b.unit_ids.includes(r.expected));
    const unit = readBatch(batch?.path ?? "").units.find((u) => u.id === r.expected);
    return { dir: r.dir, expected: r.expected, unit: (unit?.inputs ?? {}) as Record<string, any> };
  }

  it("w3_delete: 그 단위의 W3 단위가 있고 그 단위를 근거로 든 요구가 비어 있다", () => {
    for (const seed of [0, 1, 2]) {
      const { unit } = planAfter("w3_delete", seed);
      expect(unit.requirements).toEqual([]);
      expect(unit.linked.requirements).toEqual([]);
    }
  });

  it("w2_alter: 요구의 W2 단위에 바뀐 문장이 실린다", () => {
    const { dir, unit } = planAfter("w2_alter", 0);
    const after = injection(dir).after as string;
    expect(after).toBe("홈 상단에 배너를 최대 7개 노출한다");
    expect(unit.changes.map((c: { text: string }) => c.text)).toContain(after);
  });

  it("w4_confirm: confirmed 요구의 W4 단위가 있고 근거나 이웃 단위에 미정 표시가 있다", () => {
    for (const seed of [0, 1, 2]) {
      const { unit } = planAfter("w4_confirm", seed);
      const texts = [...unit.evidence_units, ...unit.neighbors].map((u: { text: string }) => u.text);
      expect(texts.some((t) => /미정|논의|TBD|확인 필요|명확화|검토 중/.test(t))).toBe(true);
    }
  });

  it("w4_confirm: 질문·차이·가정은 남고 그 요구만 연결에서 빠진다", () => {
    const { dir: source } = setupEvalSource();
    const before = items(source);
    const r = injectDefect({ source, kind: "w4_confirm", seed: 0 });
    const after = items(r.dir);
    expect(after.requirements[0]?.status).toBe("confirmed");
    expect(after.questions.map((q) => q.id)).toEqual(before.questions.map((q) => q.id));
    expect(after.deltas.map((d) => d.id)).toEqual(before.deltas.map((d) => d.id));
    expect(after.assumptions.map((a) => a.id)).toEqual(before.assumptions.map((a) => a.id));
    expect(after.questions.some((q) => q.affects.includes("요구-1"))).toBe(false);
    expect(after.deltas.some((d) => d.requirement_ids.includes("요구-1"))).toBe(false);
    expect((r.before as { linked: { questions: string[] } }).linked.questions).toEqual(["Q-1"]);
  });

  it("w5_ainote: W5 단위에 사람용 문장에 없는 조건이 실리고 근거는 그 요구의 기존 인용이다", () => {
    const { dir, unit } = planAfter("w5_ainote", 2);
    const note = injection(dir).after as { text: string; evidence: { unit_id: string; quote: string }[] };
    expect(note.text).toBe("단, 상세에 처음 들어온 사용자에게만 적용하고 두 번째부터는 보이지 않는다");
    expect(unit.ai_notes).toContain(note.text);
    expect(note.evidence).toEqual([{ unit_id: "U-3", quote: "판매가만 노출한다" }]);
    expect(planAfter("w5_ainote", 0).unit.ai_notes.at(-1)).toContain("단, 홈에 처음 들어온 사용자에게만");
  });

  it("w7_drop_visual: 그 화면(또는 변형)의 W7 단위가 있고 지운 변경은 실리지 않는다", () => {
    for (const seed of [0, 1]) {
      const { dir, expected, unit } = planAfter("w7_drop_visual", seed);
      const removed = (injection(dir).before as { text: string }).text;
      const lists = [unit.changes_for_screen, unit.changes_for_variant, unit.changes_for_variants].flat().filter(Boolean) as string[];
      expect(lists).not.toContain(removed);
      expect(expected).toBe(EXPECTED.w7_drop_visual[seed]);
      expect(unit.as_is).toContain("sources/figma/s1.png");
    }
  });

  it("w8_pair: W8 단위의 비교 행에서 두 행의 figma 칸이 바뀌어 있다", () => {
    const { dir, unit } = planAfter("w8_pair", 0);
    expect(unit.rows).toEqual([
      { aspect: "최대 개수", prd: "5개", figma: "8px" },
      { aspect: "간격", prd: "12px", figma: "3개" },
    ]);
    expect(injection(dir).target).toEqual({ delta_id: "D-1", row_indexes: [0, 1] });
  });
});

describe("복사 규칙과 새 run.json", () => {
  function setupWithLeftovers() {
    const { dir } = setupEvalSource();
    const p = runPaths(dir);
    writeFileSync(p.answers, JSON.stringify({ answers: {}, scope: {}, assumptions: {} }));
    writeFileSync(p.manifest, JSON.stringify({ sources: [] }));
    for (const sub of ["doc/findings", "doc/sasu", "work/x", "packets", "gate"]) mkdirSync(join(dir, sub), { recursive: true });
    for (const f of ["doc/findings/analysis-1.json", "doc/sasu/analysis-1.plan.json", "work/x/a.json", "packets/p.md", "gate/page.html", "doc/plan.json"]) writeFileSync(join(dir, f), "{}");
    writeFileSync(p.costs, '{"role":"x"}\n');
    writeFileSync(p.mistakes, '{"id":"M-1"}\n');
    return dir;
  }

  it("sources 전체와 analysis·scenarios·answers 만 복사하고 나머지는 비운다", () => {
    const source = setupWithLeftovers();
    const r = injectDefect({ source, kind: "w3_delete", seed: 1 });
    const p = runPaths(r.dir);
    expect(existsSync(join(r.dir, "sources", "figma", "s1.png"))).toBe(true);
    expect(readFileSync(p.units, "utf8")).toBe(readFileSync(runPaths(source).units, "utf8"));
    expect(readFileSync(p.manifest, "utf8")).toBe(readFileSync(runPaths(source).manifest, "utf8"));
    expect(existsSync(p.analysis)).toBe(true);
    expect(existsSync(p.scenarios)).toBe(true);
    expect(readFileSync(p.answers, "utf8")).toBe(readFileSync(runPaths(source).answers, "utf8"));
    for (const dirName of [p.findingsDir, p.work, p.packets, p.gate, join(p.doc, "sasu")]) expect(existsSync(dirName) ? readdirSync(dirName).filter((n) => n !== "assets") : []).toEqual([]);
    expect(existsSync(p.plan)).toBe(false);
    expect(readFileSync(p.costs, "utf8")).toBe("");
    expect(readFileSync(p.mistakes, "utf8")).toBe("");
    const events = readEvents(p.events);
    expect(events.map((e) => e.type)).toEqual(["eval_injected"]);
  });

  it("answers.json 이 없으면 복사하지 않는다", () => {
    const { dir } = setupEvalSource();
    const r = injectDefect({ source: dir, kind: "w5_ainote", seed: 1 });
    expect(existsSync(runPaths(r.dir).answers)).toBe(false);
  });

  it("새 run.json: shadow, analyzed, 반송 0, 제출 기록 attempt 1, 원본 입력·저장소 유지, eval 칸, revision·open 다시 계산", () => {
    const source = setupWithLeftovers();
    const before = loadRun(source);
    const r = injectDefect({ source, kind: "w2_alter", seed: 1 });
    const run = loadRun(r.dir);
    expect(r.run_id).toBe(`${before.run_id}-inj-w2_alter-1`);
    expect(run).toMatchObject({
      run_id: r.run_id,
      mode: "shadow",
      state: "analyzed",
      rework: { analysis: 0, plan: 0 },
      open: collectRunOpen(r.dir).length,
      eval: { source_run: before.run_id, kind: "w2_alter", seed: 1 },
      input: before.input,
      repo: before.repo,
    });
    expect(run.revision).toBe(computeRevision(r.dir));
    expect(run.revision).not.toBe(before.revision);
    expect(Object.keys(run.submissions).sort()).toEqual(["analysis", "scenarios"]);
    expect(run.submissions.analysis?.attempt).toBe(1);
    expect(run.submissions.scenarios?.attempt).toBe(1);
    const envelope = JSON.parse(readFileSync(runPaths(r.dir).analysis, "utf8")) as Record<string, any>;
    expect(envelope).toMatchObject({ run_id: r.run_id, attempt: 1, cost: null });
  });

  it("변형 뒤 결정적 검사의 거부 코드는 기록만 하고 주입은 그대로 만든다", () => {
    const { dir } = setupEvalSource();
    rewriteAnalysis(dir, (doc) => {
      doc.requirements[2].acceptance = [];
    });
    const r = injectDefect({ source: dir, kind: "w5_ainote", seed: 1 });
    expect(r.checks_after).toEqual(["ac_missing"]);
    expect(injection(r.dir).checks_after).toEqual(["ac_missing"]);
  });

  it("원본은 바뀌지 않는다", () => {
    const source = setupWithLeftovers();
    const text = readFileSync(runPaths(source).analysis, "utf8");
    const run = readFileSync(runPaths(source).runJson, "utf8");
    injectDefect({ source, kind: "w3_delete", seed: 1 });
    expect(readFileSync(runPaths(source).analysis, "utf8")).toBe(text);
    expect(readFileSync(runPaths(source).runJson, "utf8")).toBe(run);
  });

  it("--out-id 를 쓰면 그 이름이고, 형식이 틀리거나 이미 있으면 종료 2", () => {
    const { dir } = setupEvalSource();
    const r = injectDefect({ source: dir, kind: "w3_delete", seed: 1, outId: "my-inj" });
    expect(r.run_id).toBe("my-inj");
    expect(loadRun(r.dir).run_id).toBe("my-inj");
    for (const outId of ["내-주입", "my-inj"]) {
      try {
        injectDefect({ source: dir, kind: "w3_delete", seed: 1, outId });
        expect.unreachable();
      } catch (e) {
        expect((e as HewError).exitCode).toBe(2);
      }
    }
  });
});

describe("원본 점검", () => {
  const exitOf = (fn: () => unknown): number => {
    try {
      fn();
    } catch (e) {
      return (e as HewError).exitCode;
    }
    return 0;
  };

  it("analyzed 앞 상태이거나 분석 정본이 없으면 종료 4, 시나리오 정본은 없어도 된다", () => {
    const { dir } = setupEvalSource();
    const file = runPaths(dir).runJson;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    for (const state of ["init", "collected"]) {
      writeFileSync(file, JSON.stringify({ ...raw, state }));
      expect(exitOf(() => injectDefect({ source: dir, kind: "w3_delete", seed: 1 }))).toBe(4);
    }
    for (const state of ["analyzed", "vetted", "checked"]) {
      writeFileSync(file, JSON.stringify({ ...raw, state }));
      expect(exitOf(() => injectDefect({ source: dir, kind: "w3_delete", seed: 1, outId: `ok-${state}` }))).toBe(0);
    }
    rmSync(runPaths(dir).scenarios);
    expect(exitOf(() => injectDefect({ source: dir, kind: "w3_delete", seed: 2 }))).toBe(0);
    rmSync(runPaths(dir).analysis);
    expect(exitOf(() => injectDefect({ source: dir, kind: "w3_delete", seed: 3 }))).toBe(4);
  });

  it("시나리오 정본이 없는 원본에서는 시나리오를 복사하지 않고 제출 기록도 분석만 둔다", () => {
    const { dir } = setupEvalSource({ withoutScenarios: true });
    const r = injectDefect({ source: dir, kind: "w3_delete", seed: 1 });
    expect(existsSync(runPaths(r.dir).scenarios)).toBe(false);
    const run = loadRun(r.dir);
    expect(run.state).toBe("analyzed");
    expect(Object.keys(run.submissions)).toEqual(["analysis"]);
    expect(run.revision).toBe(computeRevision(r.dir));
  });

  it("종류나 시드가 틀리면 종료 2", () => {
    const { dir } = setupEvalSource();
    expect(exitOf(() => injectDefect({ source: dir, kind: "w9_x" as EvalKind, seed: 1 }))).toBe(2);
    expect(exitOf(() => injectDefect({ source: dir, kind: "w3_delete", seed: -1 }))).toBe(2);
    expect(exitOf(() => injectDefect({ source: dir, kind: "w3_delete", seed: 1.5 }))).toBe(2);
  });
});

describe("hew eval inject-all", () => {
  it("종류 6개 × n 개를 만들고 같은 대상이 다시 뽑히면 건너뛴다", () => {
    const { dir } = setupEvalSource();
    const id = loadRun(dir).run_id;
    const r = injectAll({ source: dir, perKind: 3, seed: 1 });
    const count = (kind: EvalKind) => r.runs.filter((x) => x.kind === kind).length;
    expect(EVAL_KINDS.map(count)).toEqual([3, 3, 3, 3, 2, 2]);
    expect(r.runs).toHaveLength(16);
    expect(r.skipped).toEqual([
      { kind: "w7_drop_visual", seed: 3, reason: expect.stringContaining("같은 대상") },
      { kind: "w8_pair", seed: 3, reason: expect.stringContaining("같은 대상") },
    ]);
    expect(r.runs[0]).toEqual({ run_id: `${id}-inj-w3_delete-1`, kind: "w3_delete", seed: 1, expected: "W3:U-10" });
    expect(r.runs.every((x) => existsSync(join(runs.dir, x.run_id, "eval", "injection.json")))).toBe(true);
    // 같은 종류의 주입 실행은 서로 다른 대상을 심는다.
    for (const kind of EVAL_KINDS) {
      const targets = r.runs.filter((x) => x.kind === kind).map((x) => JSON.stringify(injection(join(runs.dir, x.run_id)).target));
      expect(new Set(targets).size).toBe(targets.length);
    }
  });

  it("n 기본값은 3 이고 시작 시드를 줄 수 있으며, 이미 있는 실행은 건너뛴다", () => {
    const { dir } = setupEvalSource();
    const first = injectAll({ source: dir, perKind: 1, seed: 5 });
    expect(first.runs.map((x) => x.seed)).toEqual([5, 5, 5, 5, 5, 5]);
    const again = injectAll({ source: dir, perKind: 1, seed: 5 });
    expect(again.runs).toEqual([]);
    expect(again.skipped).toHaveLength(6);
    expect(again.skipped[0]?.reason).toContain("이미 있는");
  });

  it("후보가 없는 종류는 사유와 함께 건너뛰고, n 이 1 보다 작으면 종료 2", () => {
    const { dir } = setupEvalSource();
    rewriteAnalysis(dir, (doc) => {
      doc.deltas = [];
    });
    const r = injectAll({ source: dir, perKind: 2, seed: 1 });
    expect(r.skipped.filter((x) => x.kind === "w8_pair")).toEqual([
      { kind: "w8_pair", seed: 1, reason: "후보가 없어 건너뜀" },
      { kind: "w8_pair", seed: 2, reason: "후보가 없어 건너뜀" },
    ]);
    expect(r.runs.filter((x) => x.kind === "w8_pair")).toEqual([]);
    expect(() => injectAll({ source: dir, perKind: 0, seed: 1 })).toThrow(HewError);
  });
});

describe("hew eval inject (CLI)", () => {
  it("종료 0 이고 요약을 낸다. --json 은 injection 내용을 담는다", () => {
    const { dir } = setupEvalSource();
    const id = loadRun(dir).run_id;
    const text = hew(["eval", "inject", "--run", id, "--kind", "w5_ainote", "--seed", "2"]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("잡아야 하는 단위: W5:요구-3");
    const json = hew(["--json", "eval", "inject", "--run", id, "--kind", "w8_pair", "--out-id", "cli-inj"]);
    expect(json.status).toBe(0);
    const body = JSON.parse(json.stdout) as { ok: boolean; data: Record<string, any> };
    expect(body.data).toMatchObject({ run_id: "cli-inj", kind: "w8_pair", seed: 1, expected: "W8:D-3", candidates: 2 });
  });

  it("후보 없음은 종료 3, 종류 오류는 종료 2, 상태 오류는 종료 4", () => {
    const { dir } = setupEvalSource();
    const id = loadRun(dir).run_id;
    expect(hew(["--json", "eval", "inject", "--run", id, "--kind", "w9"]).status).toBe(2);
    expect(hew(["--json", "eval", "inject", "--run", id, "--kind", "w8_pair", "--seed", "x"]).status).toBe(2);
    rewriteAnalysis(dir, (doc) => {
      doc.deltas = [];
    });
    const none = hew(["--json", "eval", "inject", "--run", id, "--kind", "w8_pair"]);
    expect(none.status).toBe(3);
    expect(none.stdout).toContain("이 원본에서는 이 종류를 심을 수 없습니다");
    const raw = JSON.parse(readFileSync(runPaths(dir).runJson, "utf8")) as Record<string, unknown>;
    writeFileSync(runPaths(dir).runJson, JSON.stringify({ ...raw, state: "collected" }));
    expect(hew(["--json", "eval", "inject", "--run", id, "--kind", "w3_delete"]).status).toBe(4);
  });

  it("inject-all 은 만든 실행과 건너뜀을 낸다", () => {
    const { dir } = setupEvalSource();
    const r = hew(["--json", "eval", "inject-all", "--run", loadRun(dir).run_id, "--per-kind", "2"]);
    expect(r.status).toBe(0);
    const body = JSON.parse(r.stdout) as { data: { runs: unknown[]; skipped: unknown[] } };
    expect(body.data.runs).toHaveLength(12);
    expect(body.data.skipped).toEqual([]);
  });
});
