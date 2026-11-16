/** 사례 파일(§11.1 형식과 옛 형식)을 읽어 run.json 의 case_info 로 만든다. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { usageError } from "./errors.js";
import type { CaseInfo } from "./run.js";

export interface CaseFile {
  info: CaseInfo;
  /** 사례가 정한 대상 저장소 base(있으면). */
  base?: string;
}

const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

const text = (v: unknown): string | undefined => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
};

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const strings = (v: unknown): string[] => list(v).flatMap((x) => (text(x) === undefined ? [] : [text(x) as string]));

const numbers = (v: unknown): number[] =>
  list(v).flatMap((x) => {
    const n = typeof x === "number" ? x : Number(String(x).replace(/^#/, ""));
    return Number.isInteger(n) ? [n] : [];
  });

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const expandHome = (p: string): string => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** 사례 파일 내용을 읽는다. 알아볼 수 없는 칸은 건너뛴다. */
export function parseCase(source: string): CaseFile {
  let doc: unknown;
  try {
    doc = parse(source);
  } catch (error) {
    throw usageError(`사례 파일을 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(doc)) throw usageError("사례 파일의 최상위가 매핑이 아닙니다");

  const prd = isRecord(doc.prd) ? doc.prd : {};
  const block = isRecord(doc.block) ? doc.block : {};
  const blocked = isRecord(doc.blocked) ? doc.blocked : {};
  const repo = isRecord(doc.repo) ? doc.repo : {};

  const jiraKeys = unique([
    ...strings(block.jira).filter((s) => JIRA_KEY.test(s)),
    ...strings(block.jira_keys).filter((s) => JIRA_KEY.test(s)),
    ...strings(blocked.jira_keys).filter((s) => JIRA_KEY.test(s)),
  ]);
  const info: CaseInfo = {
    block: {
      jira_keys: jiraKeys,
      pr_numbers: unique([...numbers(block.prs), ...numbers(block.pr_numbers), ...numbers(blocked.pr_numbers)]),
      heka_ids: unique(strings(block.heka_ids)),
    },
  };
  const story = text(doc.story) ?? text(doc.story_key);
  if (story !== undefined) info.story = story;
  const knownAt = text(doc.known_at);
  if (knownAt !== undefined) info.known_at = knownAt;
  const version = text(prd.version) ?? text(doc.prd_version);
  if (version !== undefined) info.prd_version = version;
  const base = text(repo.base) ?? text(doc.base_sha);
  return { info, ...(base === undefined ? {} : { base }) };
}

/** 사례 파일 경로(~ 허용)를 읽어 사례 정보로 만든다. */
export function loadCase(path: string): CaseFile {
  const file = resolve(expandHome(path));
  if (!existsSync(file)) throw usageError(`사례 파일이 없습니다: ${path}`);
  return parseCase(readFileSync(file, "utf8"));
}
