/** 묶음 제출 지적의 결정적 검사와 근거 대조(차단 여부 판정). */
import { isAbsolute, resolve } from "node:path";
import { normalizeText } from "../analysis/checks.js";
import type { Issue, Severity } from "../errors.js";
import type { BatchFile } from "../sasu/types.js";
import { KINDS_BY_CODE, type Finding, type StoredFinding, type WorkCode } from "./schema.js";

const issue = (code: string, severity: Severity, ref: string | null, message: string): Issue => ({ code, severity, ref, message });

/** 묶음에 든 단위가 판정을 정확히 하나씩 받았는지, issue 가 빠진 칸 없이 올바른 kind 인지 검사한다. */
export function checkBatchFindings(findings: Finding[], batch: BatchFile): Issue[] {
  const out: Issue[] = [];
  const unitIds = new Set(batch.units.map((u) => u.id));
  const seenWork = new Map<string, number>();
  const seenId = new Set<string>();
  for (const f of findings) {
    if (seenId.has(f.id)) out.push(issue("id_duplicate", "reject", f.id, `지적 id '${f.id}' 가 두 번 이상 쓰였습니다`));
    seenId.add(f.id);
    if (!unitIds.has(f.work)) {
      out.push(issue("finding_unknown_work", "reject", f.id, `${f.id} 가 이 묶음에 없는 작업 단위 '${f.work}' 를 가리킵니다`));
      continue;
    }
    seenWork.set(f.work, (seenWork.get(f.work) ?? 0) + 1);
    if (f.verdict !== "issue") continue;
    const missing = (["kind", "claim", "action"] as const).filter((key) => {
      const value = f[key];
      return value === undefined || (typeof value === "string" && value.trim().length === 0);
    });
    if (missing.length > 0) {
      out.push(issue("finding_incomplete", "reject", f.id, `${f.id} 는 issue 인데 ${missing.join("·")} 이(가) 없습니다`));
    }
    if (f.kind !== undefined && !KINDS_BY_CODE[batch.code].includes(f.kind)) {
      out.push(
        issue(
          "finding_kind_mismatch",
          "reject",
          f.id,
          `${f.id} 의 kind '${f.kind}' 는 ${batch.code} 에 맞지 않습니다(허용: ${KINDS_BY_CODE[batch.code].join(", ")})`,
        ),
      );
    }
  }
  for (const [work, count] of seenWork) {
    if (count > 1) out.push(issue("finding_duplicate", "reject", work, `작업 단위 ${work} 에 판정이 ${count}개 있습니다. 하나여야 합니다`));
  }
  for (const id of unitIds) {
    if (!seenWork.has(id)) out.push(issue("finding_missing", "reject", id, `작업 단위 ${id} 에 판정이 없습니다`));
  }
  return out;
}

function stringLeaves(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const child of value) stringLeaves(child, into);
  else if (value !== null && typeof value === "object") for (const child of Object.values(value as Record<string, unknown>)) stringLeaves(child, into);
  return into;
}

/** 인용이 단위 inputs 에 실린 텍스트 어딘가에 있는가(공백·Markdown 강조 표시를 지우고 비교). */
export function quoteInInputs(quote: string, inputs: Record<string, unknown>): boolean {
  const wanted = normalizeText(quote);
  if (wanted.length === 0) return false;
  return stringLeaves(inputs).some((text) => normalizeText(text).includes(wanted));
}

function imageInInputs(image: string, inputs: Record<string, unknown>, runDir: string): boolean {
  const given = isAbsolute(image) ? image : resolve(runDir, image);
  return [inputs.as_is, inputs.to_be].some((p) => typeof p === "string" && resolve(p) === resolve(given));
}

const isVerified = (code: WorkCode, f: Finding, inputs: Record<string, unknown>, runDir: string): boolean => {
  if (f.verdict !== "issue" || f.evidence === undefined) return false;
  if (code === "W7") return f.evidence.image !== undefined && imageInInputs(f.evidence.image, inputs, runDir);
  return f.evidence.quote !== undefined && quoteInInputs(f.evidence.quote, inputs);
};

/** 지적마다 근거를 대조해 blocking 을 붙인다. issue 인데 근거가 없거나 대조에 실패하면 경고를 낸다. */
export function classifyFindings(findings: Finding[], batch: BatchFile, runDir: string): { stored: StoredFinding[]; warnings: Issue[] } {
  const inputsOf = new Map(batch.units.map((u) => [u.id, u.inputs]));
  const warnings: Issue[] = [];
  const stored = findings.map((f): StoredFinding => {
    const blocking = isVerified(batch.code, f, inputsOf.get(f.work) ?? {}, runDir);
    if (f.verdict === "issue" && !blocking) {
      warnings.push(
        issue(
          "finding_evidence_unverified",
          "warn",
          f.id,
          `${f.id} 의 근거가 없거나 묶음에 실린 본문과 맞지 않아 차단하지 않는 지적으로만 남겼습니다`,
        ),
      );
    }
    return { ...f, blocking };
  });
  return { stored, warnings };
}
