/** 종료 코드(§2.5)를 가진 hew 오류 타입. */
export const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  rejected: 3,
  state: 4,
  external: 5,
} as const;

export type ErrorKind = "usage" | "rejected" | "state" | "external" | "internal";

export type Severity = "reject" | "warn" | "info";

/** 검사나 경고 한 건. */
export interface Issue {
  code: string;
  severity: Severity;
  ref: string | null;
  message: string;
}

const KIND_EXIT: Record<ErrorKind, number> = {
  usage: EXIT.usage,
  rejected: EXIT.rejected,
  state: EXIT.state,
  external: EXIT.external,
  internal: EXIT.internal,
};

export class HewError extends Error {
  readonly kind: ErrorKind;
  readonly issues: Issue[];

  constructor(kind: ErrorKind, message: string, issues: Issue[] = []) {
    super(message);
    this.name = "HewError";
    this.kind = kind;
    this.issues = issues;
  }

  get exitCode(): number {
    return KIND_EXIT[this.kind];
  }
}

export const usageError = (message: string): HewError => new HewError("usage", message);
export const stateError = (message: string): HewError => new HewError("state", message);
export const rejectedError = (message: string, issues: Issue[] = []): HewError =>
  new HewError("rejected", message, issues);
