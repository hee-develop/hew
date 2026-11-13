/** 도구 결과 원본(JSON)에서 Markdown 본문을 꺼낸다. */

const BODY_KEYS = ["body", "description", "content", "markdown", "text", "value", "fields"] as const;

function extractValue(value: unknown, depth: number): string {
  if (depth > 8) return "";
  if (typeof value === "string") {
    const trimmed = value.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return extractValue(JSON.parse(value), depth + 1);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => extractValue(item, depth + 1))
      .filter((s) => s.trim().length > 0)
      .join("\n\n");
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of BODY_KEYS) {
      if (record[key] === undefined || record[key] === null) continue;
      const found = extractValue(record[key], depth + 1);
      if (found.trim().length > 0) return found;
    }
  }
  return "";
}

/** 원천 파일 내용에서 파싱할 Markdown 을 정한다. .json 이 아니면 내용 그대로, .json 이면 그 안의 본문. */
export function markdownFromSource(content: string, fileName: string): string {
  if (!fileName.toLowerCase().endsWith(".json")) return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  return extractValue(parsed, 0);
}
