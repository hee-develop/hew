/** 명령 출력: --json 이면 stdout 한 줄 JSON, 아니면 한국어 문장. */
import { EXIT, HewError, type Issue } from "../core/errors.js";

export interface CommandResult {
  data: unknown;
  warnings?: Issue[];
  /** 사람이 읽는 성공 문장. */
  text: string;
}

export interface Envelope {
  ok: boolean;
  data: unknown;
  warnings: Issue[];
  errors: Issue[];
}

const toIssues = (error: unknown): Issue[] => {
  if (error instanceof HewError) {
    const base: Issue = { code: error.kind, severity: "reject", ref: null, message: error.message };
    return [base, ...error.issues];
  }
  const message = error instanceof Error ? error.message : String(error);
  return [{ code: "internal", severity: "reject", ref: null, message }];
};

export const exitCodeOf = (error: unknown): number => (error instanceof HewError ? error.exitCode : EXIT.internal);

function formatIssue(issue: Issue): string {
  const ref = issue.ref ? ` (${issue.ref})` : "";
  return `[${issue.code}]${ref} ${issue.message}`;
}

export function emitSuccess(json: boolean, result: CommandResult): void {
  const warnings = result.warnings ?? [];
  if (json) {
    const body: Envelope = { ok: true, data: result.data, warnings, errors: [] };
    process.stdout.write(`${JSON.stringify(body)}\n`);
    return;
  }
  process.stdout.write(`${result.text}\n`);
  for (const w of warnings) process.stderr.write(`경고: ${formatIssue(w)}\n`);
}

export function emitFailure(json: boolean, error: unknown): number {
  const errors = toIssues(error);
  if (json) {
    const body: Envelope = { ok: false, data: null, warnings: [], errors };
    process.stdout.write(`${JSON.stringify(body)}\n`);
  } else {
    const [first, ...rest] = errors;
    process.stderr.write(`오류: ${first?.message ?? "알 수 없는 오류"}\n`);
    for (const issue of rest) process.stderr.write(`  - ${formatIssue(issue)}\n`);
  }
  return exitCodeOf(error);
}
