/** 테크니컬 매니저가 차단 지적마다 낸 답변(fixed·rejected·asked)을 검증해 저장한다. */
import { existsSync, readFileSync } from "node:fs";
import { normalizeText } from "../analysis/checks.js";
import { rejectedError, stateError, usageError, type Issue } from "../errors.js";
import { appendEvent } from "../events.js";
import { readJsonFile, writeJsonAtomic } from "../fsx.js";
import { runPaths, sasuResponsesPath } from "../paths.js";
import { loadRun } from "../run.js";
import { nextAction } from "../next.js";
import type { Unit } from "../units/types.js";
import { readResponses, readRoundFindings } from "./store.js";
import { ResponsesInputSchema, type Response, type ResponsesFile } from "./types.js";

export interface RespondOptions {
  runDir: string;
  target: string;
  file: string;
  now?: Date;
}

export interface RespondResult {
  round: number;
  path: string;
  /** 이번에 낸 답변 수. */
  saved: number;
  /** 저장된 답변 전체의 수. */
  total: number;
}

const reject = (code: string, ref: string | null, message: string): Issue => ({ code, severity: "reject", ref, message });

/** 반송 중(테크니컬 매니저가 사수 지적을 받아 고치는 중)인 상태에서만 답변을 받는다. */
function assertReworking(state: string, next: ReturnType<typeof nextAction>): void {
  if (next.action !== "spawn" || next.role !== "technical-manager" || next.purpose !== "rework") {
    throw stateError(`상태 ${state} 에서는 사수 지적에 대한 답변을 받을 수 없습니다(반송 중일 때만 받습니다)`);
  }
}

/** 답변을 검증해 doc/sasu/analysis-<회차>.responses.json 에 저장한다. 같은 지적에 다시 내면 덮어쓰고 상태는 바꾸지 않는다. */
export function respondToFindings(opts: RespondOptions): RespondResult {
  const now = opts.now ?? new Date();
  if (opts.target !== "analysis") throw usageError("분해안(plan) 사수 답변은 아직 지원하지 않습니다");
  if (!existsSync(opts.file)) throw usageError(`제출 파일이 없습니다: ${opts.file}`);
  const paths = runPaths(opts.runDir);
  const run = loadRun(opts.runDir);
  assertReworking(run.state, nextAction(run.state, { rework: run.rework, progress: run.progress }));
  const round = run.submissions.findings_analysis?.attempt ?? 0;

  const rejectAll = (issues: Issue[]): never => {
    appendEvent(paths.events, "artifact_rejected", { kind: "responses", for: "analysis", file: opts.file, issues }, now);
    throw rejectedError(`답변이 거부되었습니다(거부 ${issues.length}건). 저장된 답변은 바뀌지 않았습니다`, issues);
  };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(opts.file, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return rejectAll([reject("json_parse", null, `JSON 으로 읽을 수 없습니다: ${detail}`)]);
  }
  const parsed = ResponsesInputSchema.safeParse(raw);
  if (!parsed.success) {
    return rejectAll(parsed.error.issues.map((i) => reject("schema_invalid", i.path.length > 0 ? i.path.join(".") : null, i.message)));
  }

  const blockingIds = new Set(readRoundFindings(opts.runDir, round).filter((f) => f.verdict === "issue" && f.blocking).map((f) => f.id));
  const units = new Map(
    (existsSync(paths.units) ? ((readJsonFile(paths.units) as { units?: Unit[] }).units ?? []) : []).map((u) => [u.id, u] as const),
  );
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const r of parsed.data.responses) {
    if (seen.has(r.finding)) issues.push(reject("response_duplicate", r.finding, `지적 ${r.finding} 에 답변이 두 번 이상 있습니다`));
    seen.add(r.finding);
    if (!blockingIds.has(r.finding)) {
      issues.push(reject("response_unknown_finding", r.finding, `${r.finding} 는 회차 ${round} 의 차단 지적이 아닙니다`));
      continue;
    }
    if (r.response === "rejected" && r.reason.trim().length === 0) {
      issues.push(reject("response_without_reason", r.finding, `${r.finding} 를 rejected 로 답하려면 reason 이 있어야 합니다`));
    }
    if (r.evidence !== undefined) {
      const unit = units.get(r.evidence.unit_id);
      const quote = normalizeText(r.evidence.quote);
      if (unit === undefined || quote.length === 0 || !normalizeText(unit.text).includes(quote)) {
        issues.push(reject("quote_not_found", r.finding, `${r.finding} 의 근거 인용이 ${r.evidence.unit_id} 본문에 없습니다: "${r.evidence.quote}"`));
      }
    }
  }
  if (issues.length > 0) return rejectAll(issues);

  const given = new Set(parsed.data.responses.map((r) => r.finding));
  const kept: Response[] = readResponses(opts.runDir, round).filter((r) => !given.has(r.finding));
  const merged = [...kept, ...parsed.data.responses];
  const file: ResponsesFile = { for: "analysis", round, responses: merged };
  const path = sasuResponsesPath(paths, "analysis", round);
  writeJsonAtomic(path, file);
  appendEvent(
    paths.events,
    "sasu_responded",
    { for: "analysis", round, saved: parsed.data.responses.length, total: merged.length, path },
    now,
  );
  return { round, path, saved: parsed.data.responses.length, total: merged.length };
}
