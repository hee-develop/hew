import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGate } from "../src/core/gate/build.js";
import { readEvents } from "../src/core/events.js";
import { HewError } from "../src/core/errors.js";
import { runPaths } from "../src/core/paths.js";
import { loadRun } from "../src/core/run.js";
import { setState } from "./analysis-fixtures.js";
import { readTemplate, scriptBlock, setupGateRun, writePlan } from "./gate-helpers.js";
import { useTempRunsDir } from "./helpers.js";

const runs = useTempRunsDir();
const BIN = join(import.meta.dirname, "..", "bin", "hew");

const exitOf = (fn: () => unknown): number => {
  try {
    fn();
  } catch (e) {
    if (e instanceof HewError) return e.exitCode;
    throw e;
  }
  return 0;
};

describe("gate build 상태 전이", () => {
  it("checked → gate_answering, 페이지와 path.txt, 이벤트", () => {
    const { dir } = setupGateRun();
    const r = buildGate({ runDir: dir });
    expect(r).toMatchObject({ phase: "answer", previous_state: "checked", state: "gate_answering", rebuilt: false, images: 1 });
    const p = runPaths(dir);
    expect(readFileSync(p.gatePath, "utf8").trim()).toBe(p.gatePage);
    expect(existsSync(p.gatePage)).toBe(true);
    expect(existsSync(join(p.gateAssets, readFileSync(p.gatePage, "utf8").match(/assets\/([0-9a-f]{16}\.png)/)?.[1] ?? "x"))).toBe(true);
    expect(loadRun(dir).state).toBe("gate_answering");
    expect(readEvents(p.events).filter((e) => e.type === "gate_built").at(-1)?.data).toMatchObject({ from: "checked", to: "gate_answering", row: 6 });
  });

  it("plan_checked → gate_plan_review(승인 단계), 분해안이 모델에 실린다", () => {
    const { dir } = setupGateRun();
    writePlan(dir, { tickets: [{ id: "T1", title: "[MO] 홈 / 배너", requirement_ids: ["요구-1"], sp: 3, depends_on: [], pr: "PR-1" }], prs: [{ id: "PR-1", title: "배너", ticket_ids: ["T1"], base: "develop", order: 1 }] });
    setState(dir, "plan_checked");
    const r = buildGate({ runDir: dir });
    expect(r).toMatchObject({ phase: "approve", state: "gate_plan_review", rebuilt: false });
    const html = readFileSync(r.path, "utf8");
    expect(html).toContain("[MO] 홈 / 배너");
    expect(html).toContain('"phase":"approve"');
  });

  it("이미 게시된 뒤에는 상태를 바꾸지 않고 페이지만 다시 만든다", () => {
    const { dir } = setupGateRun();
    buildGate({ runDir: dir });
    const again = buildGate({ runDir: dir });
    expect(again).toMatchObject({ previous_state: "gate_answering", state: "gate_answering", rebuilt: true });
    for (const state of ["answers_complete", "gate_plan_review", "approved"] as const) {
      setState(dir, state);
      const r = buildGate({ runDir: dir });
      expect(r).toMatchObject({ state, rebuilt: true });
      expect(loadRun(dir).state).toBe(state);
    }
  });

  it("checked 보다 앞선 상태는 종료 4", () => {
    const { dir } = setupGateRun();
    for (const state of ["init", "collected", "analyzed", "vetted"] as const) {
      setState(dir, state);
      expect(exitOf(() => buildGate({ runDir: dir }))).toBe(4);
    }
  });

  it("CLI: --json 한 줄 출력과 종료 코드", () => {
    const { dir } = setupGateRun();
    const r = spawnSync(BIN, ["--json", "gate", "build", "--run", dir], { env: { ...process.env, HEW_RUNS_DIR: runs.dir }, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, data: { state: "gate_answering", opened: false } });
    setState(dir, "analyzed");
    const bad = spawnSync(BIN, ["--json", "gate", "build", "--run", dir], { env: { ...process.env, HEW_RUNS_DIR: runs.dir }, encoding: "utf8" });
    expect(bad.status).toBe(4);
  });
});

describe("페이지 내용", () => {
  it("모델 JSON 이 들어 있고 외부 스크립트·스타일·폰트 주소가 없다", () => {
    const { dir } = setupGateRun();
    const html = readFileSync(buildGate({ runDir: dir }).path, "utf8");
    const data = scriptBlock(html.replace('<script type="application/json" id="gate-data">', '<script id="gate-data">'), "gate-data");
    const model = JSON.parse(data);
    expect(model.head.run_id).toBe(loadRun(dir).run_id);
    expect(model.questions).toHaveLength(3);
    expect(html).not.toContain("{{");
    expect(html).not.toMatch(/<(script|link|img|iframe)[^>]+(src|href)=["']https?:\/\//i);
    expect(html).not.toMatch(/@import|url\(["']?https?:/i);
  });

  it("모델 안의 < 는 이스케이프되어 스크립트를 끝내지 못한다", () => {
    const { dir } = setupGateRun();
    const html = readFileSync(buildGate({ runDir: dir }).path, "utf8");
    expect(html.match(/<\/script>/g)?.length).toBe(3);
  });

  it("템플릿의 인라인 스크립트는 문법 오류가 없다", () => {
    const html = readTemplate();
    for (const id of ["gate-logic", "gate-ui"]) expect(() => new Function(scriptBlock(html, id))).not.toThrow();
  });
});
