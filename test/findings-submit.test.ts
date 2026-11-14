import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { quoteInInputs } from "../src/core/findings/checks.js";
import { KINDS_BY_CODE, MISTAKE_TYPE_BY_KIND, FINDING_KINDS, splitWorkId } from "../src/core/findings/schema.js";
import { submitFindingsBatch } from "../src/core/findings/submit.js";
import { readEvents } from "../src/core/events.js";
import { HewError } from "../src/core/errors.js";
import { HEW_ROOT, findingsBatchPath, runPaths } from "../src/core/paths.js";
import { loadRun } from "../src/core/run.js";
import { SasuPlanSchema } from "../src/core/sasu/types.js";
import { useTempRunsDir, writeItemsFile } from "./helpers.js";
import { batchOf, planNow, setupAnalyzed, submitBatch, writeFindingsFile } from "./sasu-fixtures.js";

useTempRunsDir();

function failure(fn: () => unknown): HewError {
  try {
    fn();
  } catch (e) {
    if (e instanceof HewError) return e;
    throw e;
  }
  throw new Error("거부되어야 합니다");
}
const codes = (e: HewError): string[] => e.issues.map((i) => i.code);

describe("지적 제출: 거부 코드", () => {
  it("finding_missing: 묶음의 단위에 판정이 없다", () => {
    const { dir } = setupAnalyzed();
    const plan = planNow(dir);
    const file = writeItemsFile(dir, "f.json", { findings: [{ id: "F-1", work: "W2:요구-1", verdict: "ok" }] });
    const e = failure(() => submitFindingsBatch({ runDir: dir, batch: 1, file }));
    expect(e.exitCode).toBe(3);
    expect(codes(e)).toEqual(["finding_missing", "finding_missing"]);
    expect(e.issues.map((i) => i.ref)).toEqual(["W2:요구-2", "W2:요구-3"]);
    expect(plan.batches[0]?.unit_ids).toHaveLength(3);
  });

  it("finding_duplicate: 한 단위에 판정이 둘", () => {
    const { dir } = setupAnalyzed();
    planNow(dir);
    const ok = (id: string, work: string) => ({ id, work, verdict: "ok" });
    const file = writeItemsFile(dir, "f.json", { findings: [ok("F-1", "W2:요구-1"), ok("F-2", "W2:요구-1"), ok("F-3", "W2:요구-2"), ok("F-4", "W2:요구-3")] });
    expect(codes(failure(() => submitFindingsBatch({ runDir: dir, batch: 1, file })))).toEqual(["finding_duplicate"]);
  });

  it("finding_unknown_work: 묶음에 없는 단위", () => {
    const { dir } = setupAnalyzed();
    const plan = planNow(dir);
    const base = JSON.parse(readFileSync(writeFindingsFile(dir, plan, 1), "utf8")) as { findings: Record<string, unknown>[] };
    base.findings.push({ id: "F-9", work: "W3:U-1", verdict: "ok" });
    const e = failure(() => submitFindingsBatch({ runDir: dir, batch: 1, file: writeItemsFile(dir, "f2.json", base) }));
    expect(codes(e)).toEqual(["finding_unknown_work"]);
  });

  it("finding_incomplete: issue 인데 kind·claim·action 이 없다", () => {
    const { dir } = setupAnalyzed();
    const plan = planNow(dir);
    const file = writeFindingsFile(dir, plan, 1, { "W2:요구-1": { verdict: "issue" } });
    const e = failure(() => submitFindingsBatch({ runDir: dir, batch: 1, file }));
    expect(codes(e)).toEqual(["finding_incomplete"]);
    expect(e.issues[0]?.message).toContain("kind·claim·action");
  });

  it("finding_incomplete: claim 이 공백뿐이어도 없는 것으로 본다", () => {
    const { dir } = setupAnalyzed();
    const plan = planNow(dir);
    const file = writeFindingsFile(dir, plan, 1, { "W2:요구-1": { verdict: "issue", kind: "unsupported", claim: "  ", action: "fix" } });
    expect(codes(failure(() => submitFindingsBatch({ runDir: dir, batch: 1, file })))).toEqual(["finding_incomplete"]);
  });

  it("finding_kind_mismatch: 코드에 맞지 않는 kind", () => {
    const { dir } = setupAnalyzed();
    const plan = planNow(dir);
    const file = writeFindingsFile(dir, plan, 1, { "W2:요구-1": { verdict: "issue", kind: "missing", claim: "x", action: "fix" } });
    const e = failure(() => submitFindingsBatch({ runDir: dir, batch: 1, file }));
    expect(codes(e)).toEqual(["finding_kind_mismatch"]);
    expect(e.issues[0]?.message).toContain("unsupported");
  });

  it("코드마다 허용 kind 표가 §6.4 와 같다", () => {
    expect(KINDS_BY_CODE).toEqual({
      W2: ["unsupported"],
      W3: ["missing", "wrong_disposition"],
      W4: ["false_confirmed"],
      W5: ["ai_only_behavior"],
      W6: ["operator_row"],
      W7: ["visual_unlisted"],
      W8: ["bad_pairing"],
      W9: ["already_answered"],
      T1: ["ticket_contradicts", "ticket_missing_change", "ticket_missing_context"],
    });
    expect(Object.keys(MISTAKE_TYPE_BY_KIND).sort()).toEqual([...FINDING_KINDS].sort());
    expect(splitWorkId("W2:요구-3")).toEqual({ code: "W2", target: "요구-3" });
    expect(splitWorkId("X:1")).toBeNull();
  });

  it("W3 은 missing·wrong_disposition 둘 다 받는다", () => {
    const { dir } = setupAnalyzed();
    const plan = planNow(dir);
    const k = batchOf(plan, "W3:U-3");
    const result = submitBatch(dir, plan, k, {
      "W3:U-3": { verdict: "issue", kind: "wrong_disposition", claim: "처리가 틀렸다", action: "ask" },
      "W3:U-4": { verdict: "issue", kind: "missing", claim: "빠졌다", action: "fix" },
    });
    expect(result.issues).toBe(2);
  });

  it("batch_already_submitted: 이미 낸 묶음을 다시 낸다", () => {
    const { dir } = setupAnalyzed();
    const plan = planNow(dir);
    submitBatch(dir, plan, 1);
    const e = failure(() => submitBatch(dir, plan, 1));
    expect(e.exitCode).toBe(3);
    expect(codes(e)).toEqual(["batch_already_submitted"]);
  });

  it("batch_unknown: 계획에 없는 묶음", () => {
    const { dir } = setupAnalyzed();
    const plan = planNow(dir);
    const file = writeFindingsFile(dir, plan, 1);
    for (const batch of [0 + 99, plan.batches.length + 1]) {
      const e = failure(() => submitFindingsBatch({ runDir: dir, batch, file }));
      expect(e.exitCode).toBe(3);
      expect(codes(e)).toEqual(["batch_unknown"]);
    }
  });

  it("schema_invalid: 열거값·id 형식·JSON 오류", () => {
    const { dir } = setupAnalyzed();
    planNow(dir);
    const bad = (findings: unknown) => failure(() => submitFindingsBatch({ runDir: dir, batch: 1, file: writeItemsFile(dir, "b.json", findings) }));
    expect(codes(bad({ findings: [{ id: "F-1", work: "W2:요구-1", verdict: "maybe" }] }))).toContain("schema_invalid");
    expect(codes(bad({ findings: [{ id: "x", work: "W2:요구-1", verdict: "ok" }] }))).toContain("schema_invalid");
    expect(codes(bad({ findings: [{ id: "F-1", work: "W2:요구-1", verdict: "issue", kind: "nope", claim: "c", action: "fix" }] }))).toContain("schema_invalid");
    expect(codes(bad("{oops"))).toEqual(["json_parse"]);
  });

  it("id_duplicate: 지적 id 가 겹친다", () => {
    const { dir } = setupAnalyzed();
    planNow(dir);
    const file = writeItemsFile(dir, "f.json", {
      findings: ["W2:요구-1", "W2:요구-2", "W2:요구-3"].map((work) => ({ id: "F-1", work, verdict: "ok" })),
    });
    expect(codes(failure(() => submitFindingsBatch({ runDir: dir, batch: 1, file })))).toContain("id_duplicate");
  });

  it("거부되면 정본과 상태가 그대로이고 artifact_rejected 가 남는다", () => {
    const { dir } = setupAnalyzed();
    const plan = planNow(dir);
    const before = readFileSync(runPaths(dir).runJson, "utf8");
    failure(() => submitFindingsBatch({ runDir: dir, batch: 1, file: writeItemsFile(dir, "f.json", { findings: [] }) }));
    expect(readFileSync(runPaths(dir).runJson, "utf8")).toBe(before);
    expect(existsSync(findingsBatchPath(runPaths(dir), "analysis", 1, 1))).toBe(false);
    expect(readEvents(runPaths(dir).events).filter((e) => e.type === "artifact_rejected")).toHaveLength(1);
    expect(plan.batches.length).toBeGreaterThan(1);
  });

  it("계획이 없으면 종료 4, 사수 차례가 아닌 상태에서도 종료 4", () => {
    const { dir } = setupAnalyzed();
    const file = writeItemsFile(dir, "f.json", { findings: [] });
    expect(failure(() => submitFindingsBatch({ runDir: dir, batch: 1, file })).exitCode).toBe(4);
    const other = setupRunInState();
    expect(failure(() => submitFindingsBatch({ runDir: other, batch: 1, file: writeItemsFile(other, "f.json", { findings: [] }) })).exitCode).toBe(4);
  });

  it("제출 파일이 없으면 종료 2", () => {
    const { dir } = setupAnalyzed();
    planNow(dir);
    expect(failure(() => submitFindingsBatch({ runDir: dir, batch: 1, file: join(dir, "nope.json") })).exitCode).toBe(2);
  });
});

function setupRunInState(): string {
  const { dir } = setupAnalyzed();
  const raw = JSON.parse(readFileSync(runPaths(dir).runJson, "utf8"));
  raw.state = "analyzed";
  writeFileSync(runPaths(dir).runJson, JSON.stringify(raw));
  return dir;
}

describe("지적 제출: 근거 대조로 차단·비차단이 갈린다", () => {
  const stored = (dir: string, k: number) => (JSON.parse(readFileSync(findingsBatchPath(runPaths(dir), "analysis", 1, k), "utf8")) as { items: { findings: Record<string, any>[] } }).items.findings;

  it("인용이 inputs 의 텍스트에 있으면 blocking: true", () => {
    const { dir } = setupAnalyzed();
    const plan = planNow(dir);
    const r = submitBatch(dir, plan, 1, { "W2:요구-1": { verdict: "issue", kind: "unsupported", claim: "넓다", evidence: { unit_id: "U-1", quote: "홈 상단에 배너를 노출한다" }, action: "fix" } });
    expect(r.blocking).toBe(1);
    expect(r.warnings.map((w) => w.code)).not.toContain("finding_evidence_unverified");
    expect(stored(dir, 1).find((f) => f.work === "W2:요구-1")).toMatchObject({ blocking: true });
    expect(stored(dir, 1).filter((f) => f.verdict === "ok").every((f) => f.blocking === false)).toBe(true);
  });

  it("원문 단위 본문에 있는 인용도 인정한다(공백·Markdown 강조 무시)", () => {
    const { dir } = setupAnalyzed();
    const plan = planNow(dir);
    const r = submitBatch(dir, plan, 1, { "W2:요구-1": { verdict: "issue", kind: "unsupported", claim: "c", evidence: { quote: "배너를  노출한다" }, action: "fix" } });
    expect(r.blocking).toBe(1);
    expect(quoteInInputs("**배너를**\n노출한다", { t: "판매자가 | 배너를 노출한다" })).toBe(true);
    expect(quoteInInputs("`배너를` 노출", { t: "배너를노출한다" })).toBe(true);
  });

  it("인용이 inputs 에 없으면 거부하지 않고 blocking: false 와 경고", () => {
    const { dir } = setupAnalyzed();
    const plan = planNow(dir);
    const r = submitBatch(dir, plan, 1, { "W2:요구-1": { verdict: "issue", kind: "unsupported", claim: "넓다", evidence: { unit_id: "U-1", quote: "원문에 없는 문장" }, action: "fix" } });
    expect(r.blocking).toBe(0);
    expect(r.issues).toBe(1);
    expect(r.warnings).toEqual([expect.objectContaining({ code: "finding_evidence_unverified", ref: "F-1", severity: "warn" })]);
    expect(stored(dir, 1)[0]).toMatchObject({ verdict: "issue", blocking: false });
  });

  it("근거가 없으면 blocking: false 와 경고", () => {
    const { dir } = setupAnalyzed();
    const plan = planNow(dir);
    const r = submitBatch(dir, plan, 1, { "W2:요구-2": { verdict: "issue", kind: "unsupported", claim: "넓다", action: "drop" } });
    expect(r.blocking).toBe(0);
    expect(r.warnings.map((w) => w.code)).toEqual(["finding_evidence_unverified"]);
  });

  it("빈 인용은 대조에 실패한 것으로 본다", () => {
    expect(quoteInInputs("  ** ", { t: "아무 글" })).toBe(false);
  });

  it("W7: evidence.image 가 그 단위의 이미지 경로이면 차단", () => {
    const { dir } = setupAnalyzed({
      analysis: (doc) => void (doc.screens[0].images = [{ role: "as_is", path: "sources/figma/a.png" }, { role: "to_be", path: "sources/figma/b.png" }]),
    });
    const plan = planNow(dir);
    const k = batchOf(plan, "W7:화면-1");
    const issue = (image: string) => ({ "W7:화면-1": { verdict: "issue", kind: "visual_unlisted", claim: "아이콘이 바뀜", evidence: { image }, action: "fix" } as const });
    expect(submitBatch(dir, plan, k, issue(join(dir, "sources/figma/b.png"))).blocking).toBe(1);
  });

  it("W7: 다른 이미지 경로이거나 인용만 있으면 차단하지 않는다", () => {
    const { dir } = setupAnalyzed({
      analysis: (doc) => void (doc.screens[0].images = [{ role: "as_is", path: "sources/figma/a.png" }, { role: "to_be", path: "sources/figma/b.png" }]),
    });
    const plan = planNow(dir);
    const k = batchOf(plan, "W7:화면-1");
    const r = submitBatch(dir, plan, k, { "W7:화면-1": { verdict: "issue", kind: "visual_unlisted", claim: "c", evidence: { image: join(dir, "sources/figma/zzz.png"), quote: "홈 상단에 배너를 노출한다" }, action: "ask" } });
    expect(r.blocking).toBe(0);
    expect(r.warnings.map((w) => w.code)).toEqual(["finding_evidence_unverified"]);
  });

  it("W7: 상대 경로 이미지도 실행 폴더 기준으로 같으면 차단", () => {
    const { dir } = setupAnalyzed({
      analysis: (doc) => void (doc.screens[0].images = [{ role: "as_is", path: "sources/figma/a.png" }, { role: "to_be", path: "sources/figma/b.png" }]),
    });
    const plan = planNow(dir);
    const k = batchOf(plan, "W7:화면-1");
    expect(submitBatch(dir, plan, k, { "W7:화면-1": { verdict: "issue", kind: "visual_unlisted", claim: "c", evidence: { image: "sources/figma/a.png" }, action: "fix" } }).blocking).toBe(1);
  });

  it("스키마에 없는 칸(blocking 등)은 버리고 경고한다", () => {
    const { dir } = setupAnalyzed();
    const plan = planNow(dir);
    const file = writeFindingsFile(dir, plan, 1, { "W2:요구-1": { blocking: true } as never });
    const r = submitFindingsBatch({ runDir: dir, batch: 1, file });
    expect(r.warnings.map((w) => w.code)).toEqual(["unknown_field_dropped"]);
    expect(stored(dir, 1)[0]).toMatchObject({ blocking: false });
  });
});

describe("지적 제출: 묶음 제출만으로는 상태가 바뀌지 않는다", () => {
  it("마지막 묶음 전까지 상태·run.json 이 그대로이고 마지막 묶음에서 회차가 완료된다", () => {
    const { dir } = setupAnalyzed();
    const plan = planNow(dir);
    const before = readFileSync(runPaths(dir).runJson, "utf8");
    for (const b of plan.batches.slice(0, -1)) {
      const r = submitBatch(dir, plan, b.k);
      expect(r).toMatchObject({ completed: null, previous_state: "analyzed", state: "analyzed" });
    }
    expect(readFileSync(runPaths(dir).runJson, "utf8")).toBe(before);
    expect(existsSync(join(runPaths(dir).findingsDir, "analysis-1.json"))).toBe(false);
    const last = submitBatch(dir, plan, plan.batches.length);
    expect(last.completed).not.toBeNull();
    expect(last.state).toBe("vetted");
    expect(loadRun(dir).submissions.findings_analysis?.attempt).toBe(1);
  });

  it("묶음 정본에 공통 틀이 있다", () => {
    const { dir } = setupAnalyzed();
    const plan = planNow(dir);
    submitBatch(dir, plan, 1);
    const doc = JSON.parse(readFileSync(findingsBatchPath(runPaths(dir), "analysis", 1, 1), "utf8"));
    expect(doc).toMatchObject({ schema: "hew.findings/1", stage: "findings_analysis", attempt: 1, run_id: loadRun(dir).run_id });
    expect(Object.keys(doc)).toEqual(["schema", "run_id", "stage", "attempt", "input_revision", "produced_by", "items", "open", "verdict", "cost"]);
  });
});

describe("형식 안내 예시(refs/)", () => {
  it("예시 묶음 파일과 예시 지적 파일이 짝이 맞아 검사를 통과하고 근거 있는 issue 는 차단이다", () => {
    const { dir } = setupAnalyzed();
    const example = JSON.parse(readFileSync(join(HEW_ROOT, "refs", "sasu-batch.example.json"), "utf8")) as { units: { id: string }[] };
    const p = runPaths(dir);
    const batchPath = join(p.work, "sasu-analysis-1", "batch-1.json");
    mkdirSync(dirname(batchPath), { recursive: true });
    copyFileSync(join(HEW_ROOT, "refs", "sasu-batch.example.json"), batchPath);
    const plan = SasuPlanSchema.parse({
      for: "analysis",
      round: 1,
      units: example.units.map((u) => ({ id: u.id, code: "W3", target: u.id.slice(3), hash: "h", batch: 1 })),
      batches: [{ k: 1, code: "W3", unit_ids: example.units.map((u) => u.id), path: batchPath }],
    });
    mkdirSync(join(p.doc, "sasu"), { recursive: true });
    writeFileSync(join(p.doc, "sasu", "analysis-1.plan.json"), JSON.stringify(plan));
    const r = submitFindingsBatch({ runDir: dir, batch: 1, file: join(HEW_ROOT, "refs", "findings.example.json") });
    expect(r).toMatchObject({ units: 2, issues: 1, blocking: 1 });
    expect(r.warnings).toEqual([]);
  });
});
