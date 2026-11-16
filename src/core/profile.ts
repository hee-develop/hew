/** 프로필 폴더(도메인·팀에 특화된 값)를 찾고 읽는다. profile.yaml 은 필수, domain.md 는 선택. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { HewError } from "./errors.js";
import { HEW_ROOT } from "./paths.js";

const regexFragment = z.string().min(1).refine(
  (s) => {
    try {
      new RegExp(s);
      return true;
    } catch {
      return false;
    }
  },
  { message: "정규식 조각이 올바르지 않습니다" },
);
const actorWords = z.array(regexFragment).min(1);

const TitleFormat = z
  .string()
  .min(1)
  .refine((f) => f.includes("{epic}") && f.includes("{summary}"), { message: "{epic} 과 {summary} 가 모두 있어야 합니다" })
  .refine((f) => f.indexOf("{epic}") < f.indexOf("{summary}"), { message: "{epic} 이 {summary} 보다 앞에 있어야 합니다" });

export const ProfileSchema = z
  .object({
    actors: z.object({ operator: actorWords, provider: actorWords, customer: actorWords }).strict(),
    plan: z
      .object({
        sp: z.object({ min: z.number(), max: z.number(), hours_per_sp: z.number().positive() }).strict(),
        title: z.object({ format: TitleFormat }).strict(),
        pr: z.object({ max_tickets: z.number().int().min(1), base: z.string().min(1) }).strict(),
        notes: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    heka: z.record(z.array(z.string().min(1))).default({}),
    connections: z.object({ atlassian_cloud_id: z.string().min(1) }).strict(),
  })
  .strict();

export type ProfileData = z.infer<typeof ProfileSchema>;
export interface Profile extends ProfileData {
  dir: string;
  /** domain.md 내용(앞뒤 공백 제거). 없거나 비면 null. */
  domain: string | null;
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** 프로필 폴더 위치: HEW_PROFILE_DIR → ~/.hew/profile(폴더가 있을 때) → 저장소의 profiles/example. */
export function profileDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.HEW_PROFILE_DIR;
  if (fromEnv !== undefined && fromEnv.length > 0) return resolve(fromEnv);
  const home = join(homedir(), ".hew", "profile");
  if (isDir(home)) return home;
  return join(HEW_ROOT, "profiles", "example");
}

const cache = new Map<string, Profile>();

/** 테스트용: 읽어 둔 프로필을 비운다. */
export function clearProfileCache(): void {
  cache.clear();
}

/** 프로필을 읽어 검증한다. 폴더별로 한 번만 읽는다. 없거나 형식이 틀리면 내부 오류. */
export function loadProfile(dir: string = profileDir()): Profile {
  const key = resolve(dir);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const file = join(key, "profile.yaml");
  if (!existsSync(file)) throw new HewError("internal", `프로필 파일이 없습니다: ${file}`);
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new HewError("internal", `profile.yaml 을 읽을 수 없습니다: ${file} (${(e as Error).message})`);
  }
  const parsed = ProfileSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new HewError("internal", `profile.yaml 형식이 올바르지 않습니다: ${file} 의 ${first?.path.join(".") ?? ""} ${first?.message ?? ""}`);
  }
  const domainFile = join(key, "domain.md");
  const domainText = existsSync(domainFile) ? readFileSync(domainFile, "utf8").trim() : "";
  const profile: Profile = { ...parsed.data, dir: key, domain: domainText.length > 0 ? domainText : null };
  cache.set(key, profile);
  return profile;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 제목 형식에서 제목 정규식을 만든다. */
export function titlePattern(format: string): string {
  const body = escapeRegExp(format).replace("\\{epic\\}", ".+").replace("\\{summary\\}", ".+");
  return `^${body}$`;
}

/** 제목 형식에서 {summary} 앞부분에 일감명을 넣은 접두 문자열. */
export function titlePrefix(format: string, epic: string): string {
  return format.slice(0, format.indexOf("{summary}")).replace("{epic}", epic);
}

/** 사람이 읽는 형식 표기. */
export const humanTitleFormat = (format: string): string => format.replace("{epic}", "{일감명}").replace("{summary}", "{작업 요약}");
