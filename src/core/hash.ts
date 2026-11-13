/** 정규화된 JSON(키 정렬, 공백 제거)의 sha256. revision 계산과 content_hash 에 쓴다. */
import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
/** 짧은 표시용 접두(12자). 승인 화면·로그에 쓴다. */
export function shortHash(hex: string): string {
  return hex.slice(0, 12);
}
