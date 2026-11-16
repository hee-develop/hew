/** rules/collect.yaml 을 읽어 수집 단계 설정을 돌려준다. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { HewError } from "../errors.js";
import { HEW_ROOT } from "../paths.js";

const CollectConfigSchema = z.object({
  max_shots: z.number().int().min(0).default(60),
  max_related: z.number().int().min(0).default(5),
  mcp_allow: z.array(z.string().min(1)).default([]),
  curl_hosts: z.array(z.string().min(1)).default([]),
});

export type CollectConfig = z.infer<typeof CollectConfigSchema>;

/** collect.yaml 을 읽는다. 파일이 없으면 기본값. */
export function loadCollectConfig(root: string = HEW_ROOT): CollectConfig {
  const file = join(root, "rules", "collect.yaml");
  if (!existsSync(file)) return CollectConfigSchema.parse({});
  const parsed = CollectConfigSchema.safeParse(parse(readFileSync(file, "utf8")) ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new HewError("internal", `collect.yaml 형식이 올바르지 않습니다: ${first?.path.join(".") ?? ""} ${first?.message ?? ""}`);
  }
  return parsed.data;
}
