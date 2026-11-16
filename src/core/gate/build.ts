/** 게이트 페이지 생성(§8.1, §9): 템플릿에 게이트 모델을 끼워 독립 HTML 한 파일과 이미지 복사본을 만든다. */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent } from "../events.js";
import { writeFileAtomic } from "../fsx.js";
import { HEW_ROOT, runPaths } from "../paths.js";
import { computeRevision } from "../revision.js";
import { loadRun, saveRun } from "../run.js";
import { stateError, type Issue } from "../errors.js";
import { transition, type RunState } from "../state-machine.js";
import { buildGateModel, phaseOfState, type GateModel, type GatePhase } from "./model.js";

export const TEMPLATE_PATH = join(HEW_ROOT, "gate", "template.html");

/** 게이트를 부를 수 있는 상태(checked 이후). 앞선 상태는 종료 4. */
const BUILDABLE: readonly RunState[] = [
  "checked",
  "gate_answering",
  "answers_complete",
  "answers_applied",
  "planned",
  "plan_checked",
  "gate_plan_review",
  "approved",
];

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `<script type="application/json">` 안에 안전하게 들어가도록 `<` 와 줄 구분 문자를 이스케이프한 JSON. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** 템플릿의 자리표시자에 제목과 모델을 채운다. */
export function renderPage(template: string, model: GateModel): string {
  return template
    .replace("{{TITLE}}", () => escapeHtml(`${model.head.title} · 확인 페이지`))
    .replace("{{GATE_DATA}}", () => embedJson(model));
}

export interface BuildGateOptions {
  runDir: string;
  now?: Date;
}

export interface BuildGateResult {
  path: string;
  phase: GatePhase;
  previous_state: RunState;
  state: RunState;
  /** 상태를 바꾸지 않고 페이지만 다시 만들었는가. */
  rebuilt: boolean;
  images: number;
  revision: string;
  warnings: Issue[];
}

/** 게이트 페이지를 만들고, checked·plan_checked 에서는 게시 사건을 적용한다. */
export function buildGate(opts: BuildGateOptions): BuildGateResult {
  const now = opts.now ?? new Date();
  const paths = runPaths(opts.runDir);
  const run = loadRun(opts.runDir);
  if (!BUILDABLE.includes(run.state)) {
    throw stateError(`상태 ${run.state} 에서는 게이트 페이지를 만들 수 없습니다. 사수 확인(checked)이 끝난 뒤에 부르세요`);
  }
  const phase = phaseOfState(run.state);
  const { model, assets, warnings } = buildGateModel(opts.runDir, phase, now);
  const html = renderPage(readFileSync(TEMPLATE_PATH, "utf8"), model);

  mkdirSync(paths.gateAssets, { recursive: true });
  for (const job of assets) {
    const target = join(paths.gateAssets, job.name);
    if (!existsSync(target)) copyFileSync(job.from, target);
  }
  writeFileAtomic(paths.gatePage, html);
  writeFileAtomic(paths.gatePath, `${paths.gatePage}\n`);

  const publishes = run.state === "checked" || run.state === "plan_checked";
  const result = publishes
    ? transition(run.state, { type: "gate_published", phase }, { rework: run.rework, progress: run.progress, open: run.open, revision: computeRevision(opts.runDir) })
    : null;
  if (result !== null) saveRun(opts.runDir, { ...run, state: result.state }, now);
  const state = result?.state ?? run.state;
  appendEvent(
    paths.events,
    "gate_built",
    { path: paths.gatePage, phase, from: run.state, to: state, row: result?.row ?? null, images: assets.length, revision: model.head.revision },
    now,
  );
  return {
    path: paths.gatePage,
    phase,
    previous_state: run.state,
    state,
    rebuilt: result === null,
    images: assets.length,
    revision: model.head.revision,
    warnings,
  };
}
