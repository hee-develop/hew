import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGateModel } from "../src/core/gate/model.js";
import { runPaths } from "../src/core/paths.js";
import { loadRun } from "../src/core/run.js";
import { makePng, setupGateRun, writeRunFile } from "./gate-helpers.js";
import { useTempRunsDir } from "./helpers.js";

useTempRunsDir();

const editAnalysis = (dir: string, edit: (items: Record<string, any>) => void): void => {
  const file = runPaths(dir).analysis;
  const doc = JSON.parse(readFileSync(file, "utf8"));
  edit(doc.items);
  writeFileSync(file, JSON.stringify(doc));
};

describe("게이트 모델", () => {
  it("화면과 변형 아래에 요구를 놓고, 변형에 걸린 변경은 그 변형 아래에 둔다", () => {
    const { dir } = setupGateRun();
    const { model } = buildGateModel(dir, "answer");
    const [home, detail] = model.screens;
    expect(home?.requirements.map((r) => r.id)).toEqual(["요구-1", "요구-2"]);
    expect(detail?.requirements.map((r) => r.id)).toEqual(["요구-3"]);
    expect(home?.requirements[0]?.changes.map((c) => c.text)).toEqual(["홈 상단에 배너를 노출한다"]);
    expect(home?.variants[0]?.changes).toEqual([{ requirement_id: "요구-1", requirement_title: "홈에 배너를 노출한다", text: "배너가 없으면 빈 상태를 보인다" }]);
    expect(model.unbound_requirements).toEqual([]);
  });

  it("화면이 없는 요구는 화면에 묶이지 않은 요구로 모은다", () => {
    const { dir } = setupGateRun();
    editAnalysis(dir, (items) => {
      items.requirements[2].screen_ids = [];
      items.requirements[2].changes[0].screen_id = undefined;
    });
    const { model } = buildGateModel(dir, "answer");
    expect(model.unbound_requirements.map((r) => r.id)).toEqual(["요구-3"]);
    expect(model.screens[1]?.requirements).toEqual([]);
  });

  it("차이는 대표 요구 아래 한 번만 두고 다른 관련 요구에는 링크 정보만 둔다", () => {
    const { dir } = setupGateRun();
    editAnalysis(dir, (items) => {
      items.deltas[0].requirement_ids = ["요구-2", "요구-1"];
    });
    const { model } = buildGateModel(dir, "answer");
    const [r1, r2] = model.screens[0]?.requirements ?? [];
    expect(r2?.deltas.map((d) => d.id)).toEqual(["D-1"]);
    expect(r1?.deltas.map((d) => d.id)).toEqual(["D-2"]);
    expect(r1?.links.deltas.map((d) => d.id)).toEqual(["D-1", "D-2"]);
    expect(model.unbound_deltas).toEqual([]);
  });

  it("대표 요구가 없는 차이는 묶이지 않은 차이가 된다", () => {
    const { dir } = setupGateRun();
    editAnalysis(dir, (items) => {
      items.deltas[1].requirement_ids = [];
    });
    expect(buildGateModel(dir, "answer").model.unbound_deltas.map((d) => d.id)).toEqual(["D-2"]);
  });

  it("이미지는 해시 이름으로 하나만 복사 목록에 올리고 모델에는 assets/ 상대 경로를 둔다", () => {
    const { dir } = setupGateRun();
    writeRunFile(dir, "sources/figma/copy.png", readFileSync(join(dir, "sources/figma/s1.png")));
    editAnalysis(dir, (items) => {
      items.screens[1].images[0].path = "sources/figma/copy.png";
    });
    const { model, assets, warnings } = buildGateModel(dir, "answer");
    expect(assets).toHaveLength(1);
    expect(warnings).toEqual([]);
    const srcs = model.screens.flatMap((s) => s.images.map((i) => i.src));
    expect(srcs).toHaveLength(2);
    expect(srcs[0]).toBe(srcs[1]);
    expect(srcs[0]).toMatch(/^assets\/[0-9a-f]{16}\.png$/);
    writeRunFile(dir, "sources/figma/other.png", makePng(10, 10, [1, 2, 3]));
    editAnalysis(dir, (items) => {
      items.screens[1].images[0].path = "sources/figma/other.png";
    });
    expect(buildGateModel(dir, "answer").assets).toHaveLength(2);
  });

  it("없는 이미지 파일은 src 를 비우고 경고한다", () => {
    const { dir } = setupGateRun({ images: false });
    const { model, warnings } = buildGateModel(dir, "answer");
    expect(model.screens[0]?.images[0]?.src).toBeNull();
    expect(warnings.map((w) => w.code)).toEqual(["image_missing", "image_missing"]);
  });

  it("범위 밖은 사유별로 묶고 단위 본문 발췌와 단위 id 를 싣는다", () => {
    const { dir } = setupGateRun();
    const { model } = buildGateModel(dir, "answer");
    expect(model.out_of_scope).toHaveLength(1);
    const group = model.out_of_scope[0];
    expect(group).toMatchObject({ disposition: "not_app", reason: "운영자 어드민 입력" });
    expect(group?.items[0]).toMatchObject({ row_id: "C-2", unit_ids: ["U-2"] });
    expect(group?.items[0]?.excerpts[0]).toContain("운영자가 배너를 등록한다");
  });

  it("AI용 칸은 ai 에만 싣고 사람용 칸에는 코드 경로가 없다", () => {
    const { dir } = setupGateRun();
    const { model } = buildGateModel(dir, "answer");
    const req = model.screens[0]?.requirements[0];
    expect(req?.ai.code[0]?.path).toBe("app/Home.tsx");
    const { ai: _ai, ...human } = req as NonNullable<typeof req>;
    expect(JSON.stringify(human)).not.toContain("app/Home.tsx");
  });

  it("머리, 질문, 시나리오, 분해안", () => {
    const { dir } = setupGateRun();
    const answer = buildGateModel(dir, "answer").model;
    expect(answer.head).toMatchObject({ phase: "answer", approved: false });
    expect(answer.head.run_id).toBe(loadRun(dir).run_id);
    expect(answer.head.questions).toEqual({ answered: 0, total: 3 });
    expect(answer.head.open_ids).toEqual(["Q-1", "Q-2", "D-1", "D-2", "A-1", "Q-3"]);
    expect(answer.head.environment?.name).toBe("dev");
    expect(answer.questions.map((q) => [q.id, q.source, q.origin_label])).toEqual([["Q-1", "analysis", null], ["Q-2", "analysis", "영향 분석"], ["Q-3", "scenarios", "QA 설계"]]);
    expect(answer.scenarios[2]).toMatchObject({ backend: "mock", mock: { endpoints: [{ path: "/v1/banners" }] } });
    expect(answer.plan).toBeNull();
    expect(answer.rules.delta_choices.figma_only?.map((c) => c.value)).toEqual(["follow_figma", "drop", "hold"]);
    expect(readdirSync(dir)).toContain("run.json");
  });
});
