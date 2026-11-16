/** hew init: 실행 폴더와 run.json(state=init)을 만든다. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadCase, type CaseFile } from "./case.js";
import { usageError, type Issue } from "./errors.js";
import { appendEvent } from "./events.js";
import { SOURCE_SUBDIRS, resolveRunDir, runPaths, runsRoot } from "./paths.js";
import { INPUT_KINDS, RUN_MODES, loadRun, saveRun, type Run } from "./run.js";
import { NO_REVISION } from "./revision.js";
import { addSource } from "./sources.js";
import { emptyProgress } from "./state-machine.js";

export interface InitOptions {
  prd?: string;
  ticket?: string;
  mode?: string;
  case?: string;
  repo?: string;
  base?: string;
  runId?: string;
  /** 본문 링크로 찾지 못하는 시안을 직접 지정하는 Figma URL 목록. */
  figma?: string[];
  now?: Date;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw usageError(`URL 형식이 올바르지 않습니다: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw usageError(`http(s) URL 이어야 합니다: ${url}`);
  }
}

/** URL 에서 짧은 식별자를 뽑는다. Jira 키, Confluence 페이지 번호, 마지막 경로 조각, 그 밖은 "run". */
export function shortIdFromUrl(url: string): string {
  const jiraKey = url.match(/[A-Z][A-Z0-9]+-\d+/);
  if (jiraKey) return jiraKey[0];
  const pageId = url.match(/\/pages\/(\d+)/);
  if (pageId?.[1]) return pageId[1];
  const lastSegment = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
  const slug = lastSegment.replace(/[^A-Za-z0-9-]/g, "").slice(0, 24);
  return slug.length > 0 ? slug : "run";
}

const pad = (n: number): string => String(n).padStart(2, "0");

const dateStamp = (now: Date): string => `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;

function defaultRunId(url: string, now: Date): string {
  const base = `${dateStamp(now)}-${shortIdFromUrl(url)}`;
  let seq = 1;
  while (existsSync(join(runsRoot(), `${base}-${seq}`))) seq += 1;
  return `${base}-${seq}`;
}

export interface InitResult {
  run_id: string;
  dir: string;
  run: Run;
  warnings: Issue[];
}

const expandHome = (p: string): string => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** 대상 저장소의 base(없으면 HEAD)를 SHA 로 푼다. 실패하면 사유를 돌려준다. */
function resolveBaseSha(repo: string, base: string | undefined): { sha: string } | { error: string } {
  const r = spawnSync("git", ["-C", resolve(expandHome(repo)), "rev-parse", "--verify", `${base ?? "HEAD"}^{commit}`], { encoding: "utf8" });
  const sha = r.status === 0 ? r.stdout.trim() : "";
  if (/^[0-9a-f]{40,64}$/.test(sha)) return { sha };
  const why = r.error?.message ?? r.stderr.trim().split("\n")[0] ?? "";
  return { error: `git rev-parse ${base ?? "HEAD"} 실패(종료 ${r.status ?? "없음"}): ${why}` };
}

export function initRun(opts: InitOptions): InitResult {
  const now = opts.now ?? new Date();
  if ((opts.prd === undefined) === (opts.ticket === undefined)) {
    throw usageError("--prd 와 --ticket 중 정확히 하나만 지정해야 합니다");
  }
  const kind = opts.prd !== undefined ? INPUT_KINDS[0] : INPUT_KINDS[1];
  const url = (opts.prd ?? opts.ticket) as string;
  validateUrl(url);

  const mode = opts.mode ?? "live";
  if (!(RUN_MODES as readonly string[]).includes(mode)) {
    throw usageError(`--mode 는 live|replay|shadow 중 하나여야 합니다: ${mode}`);
  }
  if (mode === "replay" && (opts.case === undefined || opts.case.length === 0)) {
    throw usageError("replay 모드에는 --case <사례 파일> 이 필요합니다");
  }
  if (opts.runId !== undefined && !RUN_ID_PATTERN.test(opts.runId)) {
    throw usageError(`--run-id 형식이 올바르지 않습니다: ${opts.runId}`);
  }

  const caseFile: CaseFile | null = opts.case !== undefined && opts.case.length > 0 ? loadCase(opts.case) : null;

  const runId = opts.runId ?? defaultRunId(url, now);
  const dir = resolveRunDir(runId);
  if (existsSync(dir)) throw usageError(`이미 있는 실행 폴더입니다: ${dir}`);

  const p = runPaths(dir);
  for (const sub of SOURCE_SUBDIRS) mkdirSync(join(p.sources, sub), { recursive: true });
  for (const d of [p.packets, p.work, p.findingsDir, p.gateAssets]) mkdirSync(d, { recursive: true });
  for (const f of [p.costs, p.mistakes]) writeFileSync(f, "", "utf8");

  const stamp = now.toISOString();
  const run: Run = {
    run_id: runId,
    mode: mode as Run["mode"],
    input: { kind, url, ...(opts.figma !== undefined && opts.figma.length > 0 ? { figma: opts.figma } : {}) },
    repo: { path: opts.repo ?? null, base: opts.base ?? null },
    case: opts.case ?? null,
    ...(caseFile === null ? {} : { case_info: caseFile.info }),
    ...(caseFile?.info.known_at === undefined ? {} : { known_at: caseFile.info.known_at }),
    state: "init",
    revision: NO_REVISION,
    rework: { analysis: 0, plan: 0 },
    progress: emptyProgress(),
    open: 0,
    submissions: {},
    created_at: stamp,
    updated_at: stamp,
  };
  saveRun(dir, run, now);
  appendEvent(p.events, "run_created", { run_id: runId, mode, input: run.input, repo: run.repo, case: run.case }, now);

  const warnings: Issue[] = [];
  if (opts.repo !== undefined) {
    const base = opts.base ?? caseFile?.base;
    const resolved = resolveBaseSha(opts.repo, base);
    if ("sha" in resolved) {
      addSource({ runDir: dir, kind: "code", ref: opts.repo, baseSha: resolved.sha, now });
    } else {
      warnings.push({ code: "code_source_skipped", severity: "warn", ref: "code", message: `code 원천을 등록하지 못했습니다: ${resolved.error}` });
    }
  }
  return { run_id: runId, dir, run: loadRun(dir), warnings };
}
