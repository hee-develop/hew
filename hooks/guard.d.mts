export interface GuardVerdict {
  decision: "allow" | "deny";
  reason: string;
}

export function decide(payload: unknown, env?: NodeJS.ProcessEnv | Record<string, string | undefined>): GuardVerdict;
export function physicalPath(absolute: string): string | null;
export function resolvePhysical(path: string, cwd: string): string | null;
export function tokenize(command: string): { words: string[]; redirs: { op: string; target: string }[] }[];
