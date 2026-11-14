/** 게이트 테스트 공용: 예시 정본으로 checked 상태 실행 만들기, PNG 만들기, 템플릿 논리 블록 꺼내 실행하기. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { deflateSync } from "node:zlib";
import "../src/core/analysis/index.js";
import "../src/core/scenarios/index.js";
import { TEMPLATE_PATH } from "../src/core/gate/build.js";
import { HEW_ROOT, runPaths } from "../src/core/paths.js";
import { submitArtifact } from "../src/core/submit.js";
import { setState, setupRun } from "./analysis-fixtures.js";
import { exampleUnits, EXAMPLE_DOC } from "./runner-helpers.js";

export const EXAMPLE_SCENARIOS = join(HEW_ROOT, "refs", "scenarios.example.json");

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (const b of buf) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** 단색 PNG 한 장(위쪽 절반은 조금 밝게)을 만든다. */
export function makePng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const row = (shade: number): Buffer => {
    const line = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) rgb.forEach((v, i) => line.writeUInt8(Math.min(255, v + shade), 1 + x * 3 + i));
    return line;
  };
  const raw = Buffer.concat(Array.from({ length: height }, (_, y) => row(y < height / 2 ? 24 : 0)));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(2, 9);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export function writeRunFile(dir: string, rel: string, data: string | Buffer): void {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
}

export interface GateRunOptions {
  /** 시안 이미지 파일을 실행 폴더에 만들어 둘지(기본 true). */
  images?: boolean;
}

/** 예시 분석·시나리오를 제출하고 checked 상태로 둔 실행을 만든다. */
export function setupGateRun(opts: GateRunOptions = {}): { dir: string } {
  const { dir } = setupRun({ units: exampleUnits() });
  submitArtifact({ runDir: dir, kind: "analysis", file: EXAMPLE_DOC });
  setState(dir, "vetted");
  submitArtifact({ runDir: dir, kind: "scenarios", file: EXAMPLE_SCENARIOS });
  setState(dir, "checked");
  if (opts.images !== false) writeRunFile(dir, "sources/figma/s1.png", makePng(250, 520, [70, 110, 200]));
  return { dir };
}

/** 임의의 plan 정본(자리표시자 스키마라 아무 객체나 통과)을 doc/plan.json 에 둔다. */
export function writePlan(dir: string, items: Record<string, unknown>): void {
  writeRunFile(dir, "doc/plan.json", JSON.stringify({ schema: "hew.plan/1", items }));
}

export const readTemplate = (): string => readFileSync(TEMPLATE_PATH, "utf8");

/** 템플릿의 `<script id="...">` 본문을 꺼낸다. */
export function scriptBlock(html: string, id: string): string {
  const m = new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`).exec(html);
  if (m?.[1] === undefined) throw new Error(`스크립트 블록 ${id} 가 없습니다`);
  return m[1];
}

export type GateLogic = Record<string, any>;

const LOGIC_NAMES = [
  "emptyState", "normalizeState", "mergeStates", "computeOpen", "computeProgress", "setAnswer", "setDecision", "setDecisionNote",
  "setAssumption", "setAssumptionNote", "setScenarioBackend", "addPlanRequest", "approveState", "canApprove", "buildExport",
  "storageKey", "planLayers", "decisionAllowed", "questionSuperseded", "isLaterAt", "effectiveBackend", "isApprovedInState",
];

/** gate-logic 블록을 node:vm 에서 실행하고 함수들을 돌려준다. */
export function loadGateLogic(html: string = readTemplate()): GateLogic {
  const context = vm.createContext({});
  const out = vm.runInContext(`${scriptBlock(html, "gate-logic")}\n({ ${LOGIC_NAMES.join(", ")} })`, context) as GateLogic;
  return out;
}

export interface GateModelLike {
  head: { run_id: string; revision: string };
  questions: { id: string; hash: string; options: { key: string }[]; source: string }[];
  screens: any[];
  unbound_requirements: any[];
  unbound_deltas: any[];
  assumptions: { id: string }[];
  rules: any;
  [key: string]: any;
}

/** 모든 질문(첫 선택지)·차이(첫 허용 결정)·가정(확인)에 답한 상태를 페이지 로직으로 만든다. */
export function answerEverything(logic: GateLogic, model: GateModelLike, at = "2026-11-14T10:00:00.000Z"): any {
  let state = logic.emptyState();
  for (const q of model.questions) state = logic.setAnswer(state, q, { option: q.options[0]?.key ?? "" }, at);
  const deltas: any[] = [];
  for (const s of model.screens) for (const r of s.requirements) deltas.push(...r.deltas);
  for (const r of model.unbound_requirements) deltas.push(...r.deltas);
  deltas.push(...model.unbound_deltas);
  for (const d of deltas) state = logic.setDecision(state, model.rules, d, model.rules.delta_choices[d.kind][0].value, at);
  for (const a of model.assumptions) state = logic.setAssumption(state, a.id, "confirmed", at);
  return state;
}
