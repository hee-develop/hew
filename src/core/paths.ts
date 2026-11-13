/** 실행 폴더 구조(§1.2)와 --run 인자 해석. */
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** hew 저장소 루트(agents, rules, refs, hooks 가 있는 곳). */
export const HEW_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const SOURCE_SUBDIRS = ["prd", "ticket", "figma", "code", "openapi", "related"] as const;

/** 실행 폴더 뿌리. 환경 변수 HEW_RUNS_DIR, 없으면 ~/hew-runs. */
export function runsRoot(): string {
  const fromEnv = process.env.HEW_RUNS_DIR;
  return fromEnv && fromEnv.length > 0 ? resolve(fromEnv) : join(homedir(), "hew-runs");
}

/** 경로 구분자·~·. 로 시작하면 폴더 경로로, 아니면 run_id 로 보고 실행 폴더를 정한다. */
export function resolveRunDir(runArg: string): string {
  const looksLikePath =
    runArg.includes("/") || runArg.startsWith(".") || runArg.startsWith("~") || isAbsolute(runArg);
  if (!looksLikePath) return join(runsRoot(), runArg);
  const expanded = runArg.startsWith("~") ? join(homedir(), runArg.slice(1)) : runArg;
  return resolve(expanded);
}

export interface RunPaths {
  dir: string;
  runJson: string;
  events: string;
  costs: string;
  mistakes: string;
  sources: string;
  manifest: string;
  requests: string;
  inventory: string;
  units: string;
  packets: string;
  work: string;
  doc: string;
  analysis: string;
  scenarios: string;
  plan: string;
  answers: string;
  findingsDir: string;
  gate: string;
  gateAssets: string;
  gatePage: string;
  gatePath: string;
  gateImports: string;
  approval: string;
}

export function runPaths(dir: string): RunPaths {
  const doc = join(dir, "doc");
  const sources = join(dir, "sources");
  const gate = join(dir, "gate");
  return {
    dir,
    runJson: join(dir, "run.json"),
    events: join(dir, "events.jsonl"),
    costs: join(dir, "costs.jsonl"),
    mistakes: join(dir, "mistakes.jsonl"),
    sources,
    manifest: join(sources, "manifest.json"),
    requests: join(sources, "requests.jsonl"),
    inventory: join(sources, "figma", "inventory.json"),
    units: join(sources, "units.json"),
    packets: join(dir, "packets"),
    work: join(dir, "work"),
    doc,
    analysis: join(doc, "analysis.json"),
    scenarios: join(doc, "scenarios.json"),
    plan: join(doc, "plan.json"),
    answers: join(doc, "answers.json"),
    findingsDir: join(doc, "findings"),
    gate,
    gateAssets: join(gate, "assets"),
    gatePage: join(gate, "page.html"),
    gatePath: join(gate, "path.txt"),
    gateImports: join(gate, "imports"),
    approval: join(dir, "approval.json"),
  };
}

/** findings 정본 경로. 회차는 그 종류의 제출 번호다. */
export function findingsPath(paths: RunPaths, target: "analysis" | "plan", attempt: number): string {
  return join(paths.findingsDir, `${target}-${attempt}.json`);
}

/** 사수 계획 파일 경로. 회차는 그 대상의 사수가 몇 번째로 도는지다. */
export function sasuPlanPath(paths: RunPaths, target: "analysis" | "plan", round: number): string {
  return join(paths.doc, "sasu", `${target}-${round}.plan.json`);
}

/** 테크니컬 매니저가 사수의 지적에 낸 답변 파일 경로. 회차는 그 지적이 나온 회차다. */
export function sasuResponsesPath(paths: RunPaths, target: "analysis" | "plan", round: number): string {
  return join(paths.doc, "sasu", `${target}-${round}.responses.json`);
}

/** 사수 묶음 파일(에이전트가 읽는 입력)이 놓이는 작업 폴더. */
export function sasuWorkDir(paths: RunPaths, target: "analysis" | "plan", round: number): string {
  return join(paths.work, `sasu-${target}-${round}`);
}

/** 묶음별 제출 정본 폴더(doc/findings/<대상>-<회차>/). */
export function findingsBatchDir(paths: RunPaths, target: "analysis" | "plan", round: number): string {
  return join(paths.findingsDir, `${target}-${round}`);
}

/** 묶음 하나의 제출 정본 경로. */
export function findingsBatchPath(paths: RunPaths, target: "analysis" | "plan", round: number, batch: number): string {
  return join(findingsBatchDir(paths, target, round), `batch-${batch}.json`);
}
