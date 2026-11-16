/** 실행 폴더 구조(§1.2)와 --run 인자 해석. */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const SOURCE_SUBDIRS = ["prd", "figma", "code", "openapi", "related"] as const;

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
    approval: join(dir, "approval.json"),
  };
}

/** findings 정본 경로. 회차는 그 종류의 제출 번호다. */
export function findingsPath(paths: RunPaths, target: "analysis" | "plan", attempt: number): string {
  return join(paths.findingsDir, `${target}-${attempt}.json`);
}
