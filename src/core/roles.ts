/** rules/roles.yaml 을 읽어 역할별 실행 설정을 돌려준다(환경 변수로 모델·effort 덮어쓰기). */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { HewError, usageError } from "./errors.js";
import { HEW_ROOT } from "./paths.js";
import { loadProfile } from "./profile.js";

export const ROLE_NAMES = ["technical-manager", "qa-designer", "ticket-maker", "manager-sasu", "ticket-sasu", "collector"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const RoleConfigSchema = z.object({
  model: z.string().min(1),
  effort: z.string().min(1).nullable().default(null),
  isolated: z.boolean(),
  allowed_tools: z.array(z.string()).default([]),
  timeout_minutes: z.number().positive(),
  heka: z.array(z.string()).default([]),
  refs: z.array(z.string()).default([]),
});

export type RoleConfig = z.infer<typeof RoleConfigSchema>;

const RolesFileSchema = z.object({ roles: z.record(RoleConfigSchema) });

export const isRoleName = (value: string): value is RoleName => (ROLE_NAMES as readonly string[]).includes(value);

/** 역할 이름을 환경 변수 접미사로 바꾼다(대문자, 하이픈은 밑줄). */
export const envSuffix = (role: string): string => role.toUpperCase().replace(/-/g, "_");

/** roles.yaml 전체를 읽는다. 역할의 heka 목록은 프로필에서 채운다(없으면 빈 목록). */
export function loadRoles(root: string = HEW_ROOT): Record<string, RoleConfig> {
  const file = join(root, "rules", "roles.yaml");
  if (!existsSync(file)) throw new HewError("internal", `역할 설정 파일이 없습니다: ${file}`);
  const parsed = RolesFileSchema.safeParse(parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new HewError("internal", `roles.yaml 형식이 올바르지 않습니다: ${first?.path.join(".") ?? ""} ${first?.message ?? ""}`);
  }
  const { heka } = loadProfile();
  return Object.fromEntries(Object.entries(parsed.data.roles).map(([name, cfg]) => [name, { ...cfg, heka: heka[name] ?? [] }]));
}

/** 역할 하나의 설정. HEW_MODEL_<역할>, HEW_EFFORT_<역할> 이 있으면 덮어쓴다. */
export function roleConfig(role: string, env: NodeJS.ProcessEnv = process.env, root: string = HEW_ROOT): RoleConfig {
  if (!isRoleName(role)) throw usageError(`알 수 없는 역할입니다: ${role} (${ROLE_NAMES.join("|")})`);
  const base = loadRoles(root)[role];
  if (base === undefined) throw new HewError("internal", `roles.yaml 에 역할이 없습니다: ${role}`);
  const suffix = envSuffix(role);
  const model = env[`HEW_MODEL_${suffix}`];
  const effort = env[`HEW_EFFORT_${suffix}`];
  return {
    ...base,
    model: model !== undefined && model.length > 0 ? model : base.model,
    effort: effort !== undefined && effort.length > 0 ? effort : base.effort,
  };
}
