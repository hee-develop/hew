/** 실수 기록(§12): mistakes.jsonl 에 한 줄씩 덧붙인다. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { usageError } from "./errors.js";
import { runPaths } from "./paths.js";
import { loadRun } from "./run.js";

export const MISTAKE_FOUND_BY = ["check", "sasu", "human_gate", "replay_judge", "review", "qa", "post"] as const;
export const MISTAKE_TYPES = [
  "missing_requirement",
  "invented_requirement",
  "false_confirmed",
  "scope_closed_by_guess",
  "wrong_evidence",
  "visual_missed",
  "needless_question",
  "missed_question",
  "bad_plan",
  "format",
  "other",
] as const;

export const MistakeVersionsSchema = z.object({
  role: z.string().nullable().optional(),
  role_sha: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  core: z.string().nullable().optional(),
});

export const MistakeSchema = z.object({
  id: z.string().regex(/^M-[1-9][0-9]*$/),
  run_id: z.string(),
  at: z.string(),
  found_stage: z.string().min(1),
  cause_stage: z.string().min(1),
  found_by: z.enum(MISTAKE_FOUND_BY),
  type: z.enum(MISTAKE_TYPES),
  target: z.string().min(1),
  evidence: z.string().min(1),
  versions: MistakeVersionsSchema.optional(),
  case: z.string().min(1).optional(),
});

export type Mistake = z.infer<typeof MistakeSchema>;
export type MistakeVersions = z.infer<typeof MistakeVersionsSchema>;

export interface MistakeInput {
  found_stage: string;
  cause_stage: string;
  found_by: string;
  type: string;
  target: string;
  evidence: string;
  versions?: MistakeVersions;
  case?: string;
}

/** 기록된 실수 줄을 모두 읽는다. 파일이 없으면 빈 목록. */
export function readMistakes(runDir: string): Mistake[] {
  const file = runPaths(runDir).mistakes;
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => MistakeSchema.parse(JSON.parse(line)));
}

/** 열거값을 검증하고 다음 M-n id 로 한 줄 덧붙인다. 열거값이 틀리면 사용법 오류. */
export function appendMistake(runDir: string, input: MistakeInput, now: Date = new Date()): Mistake {
  const run = loadRun(runDir);
  const n = readMistakes(runDir).reduce((max, m) => Math.max(max, Number(m.id.slice(2))), 0) + 1;
  const candidate = { id: `M-${n}`, run_id: run.run_id, at: now.toISOString(), ...input };
  const parsed = MistakeSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".") ?? "";
    const allowed =
      where === "found_by" ? ` (${MISTAKE_FOUND_BY.join("|")})` : where === "type" ? ` (${MISTAKE_TYPES.join("|")})` : "";
    throw usageError(`실수 기록의 ${where} 값이 올바르지 않습니다${allowed}: ${first?.message ?? ""}`);
  }
  const file = runPaths(runDir).mistakes;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(parsed.data)}\n`, "utf8");
  return parsed.data;
}
