import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPacket, hewBinPath, planPacket } from "../src/core/packet.js";
import { HEW_ROOT, runPaths } from "../src/core/paths.js";
import { loadRun, saveRun } from "../src/core/run.js";
import { submitArtifact } from "../src/core/submit.js";
import type { Doc } from "./analysis-fixtures.js";
import { makeRun, useTempRunsDir, writeItemsFile } from "./helpers.js";
import { buildScenarios, setupVetted } from "./scenarios-fixtures.js";
import { FAKE_HEKA, tempDir } from "./runner-helpers.js";

const runs = useTempRunsDir();
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...process.env, HEW_HEKA_BIN: FAKE_HEKA, ...extra });
const read = (path: string): string => readFileSync(path, "utf8");

describe("패킷: 이번 일·읽을 것·쓰는 곳", () => {
  it("처음(first): 읽을 파일, 제출 명령, 작업 폴더, Bash 목록이 있다", () => {
    const { dir } = makeRun("collected");
    const p = runPaths(dir);
    const r = buildPacket({ runDir: dir, role: "technical-manager", env: env() });
    expect(r).toMatchObject({ n: 1, purpose: "first", role: "technical-manager" });
    expect(r.path).toBe(join(p.packets, "technical-manager-1.md"));
    expect(r.workDir).toBe(join(p.work, "technical-manager-1"));
    expect(existsSync(r.workDir)).toBe(true);
    const text = read(r.path);
    expect(text).toContain("## 이번 일");
    expect(text).toContain("목적: first");
    expect(text).toContain("live");
    for (const path of [dir, p.manifest, p.units]) expect(text).toContain(path);
    expect(text).not.toContain(p.inventory);
    for (const ref of ["analysis-format.md", "analysis.example.json", "analysis.example.units.json"]) expect(text).toContain(join(HEW_ROOT, "refs", ref));
    expect(text).toContain(`${hewBinPath()} --json submit analysis --run ${dir} --file ${r.workDir}/analysis.json`);
    expect(text).toContain(`\`${r.workDir}\``);
    expect(text).toContain("- rg");
    expect(text).toContain("제출이 거부되면");
  });

  it("있는 것만 싣는다: 인벤토리, 스크린샷 폴더, openapi, 대상 저장소와 base", () => {
    const { dir } = makeRun("collected", { repo: { path: "/some/repo", base: "abc123" } });
    const p = runPaths(dir);
    mkdirSync(join(p.sources, "figma"), { recursive: true });
    writeFileSync(p.inventory, "{}");
    writeFileSync(join(p.sources, "figma", "s1.png"), "x");
    writeFileSync(join(p.sources, "openapi", "dev.json"), "{}");
    const text = read(buildPacket({ runDir: dir, role: "technical-manager", env: env() }).path);
    expect(text).toContain(p.inventory);
    expect(text).toContain(`${join(p.sources, "figma")}\``);
    expect(text).toContain(join(p.sources, "openapi"));
    expect(text).toContain("/some/repo");
    expect(text).toContain("abc123");
  });

  it("패킷 번호는 그 역할의 몇 번째인지다", () => {
    const { dir } = makeRun("collected");
    expect(planPacket(dir, "technical-manager").n).toBe(1);
    buildPacket({ runDir: dir, role: "technical-manager", env: env() });
    const second = buildPacket({ runDir: dir, role: "technical-manager", env: env() });
    expect(second.n).toBe(2);
    expect(buildPacket({ runDir: dir, role: "qa-designer", env: env() }).n).toBe(1);
  });

  it("qa-designer 패킷은 분석 정본 경로와 시나리오 제출 명령을 싣는다", () => {
    const { dir } = makeRun("vetted");
    writeFileSync(runPaths(dir).analysis, "{}");
    const r = buildPacket({ runDir: dir, role: "qa-designer", env: env() });
    const text = read(r.path);
    expect(text).toContain(runPaths(dir).analysis);
    expect(text).toContain("submit scenarios");
    expect(text).toContain("따로 지정된 규칙이 없습니다");
  });

  it("qa-designer 패킷은 분석 정본과 있으면 OpenAPI 폴더, 형식 안내 세 파일을 읽을 것에 싣고 scenarios 제출 줄을 쓴다", () => {
    const { dir } = makeRun("vetted");
    const p = runPaths(dir);
    writeFileSync(p.analysis, "{}");
    mkdirSync(join(p.sources, "openapi"), { recursive: true });
    writeFileSync(join(p.sources, "openapi", "dev.json"), "{}");
    const text = read(buildPacket({ runDir: dir, role: "qa-designer", env: env() }).path);
    const readSection = text.split("## 읽을 것")[1]!.split("## ")[0]!;
    expect(readSection).toContain(`\`${p.analysis}\``);
    expect(readSection).toContain(`\`${join(p.sources, "openapi")}\``);
    for (const ref of ["scenarios-format.md", "scenarios.example.json", "analysis.example.json"]) expect(readSection).toContain(join(HEW_ROOT, "refs", ref));
    const submitLine = /```sh\n(.+)\n```/.exec(text)?.[1] ?? "";
    expect(submitLine).toContain("submit scenarios");
    expect(submitLine).toContain(`--file ${join(runPaths(dir).work, "qa-designer-1", "scenarios.json")}`);
  });

  it("qa-designer 패킷은 OpenAPI 가 없으면 그 줄을 싣지 않는다", () => {
    const { dir } = makeRun("vetted");
    writeFileSync(runPaths(dir).analysis, "{}");
    const text = read(buildPacket({ runDir: dir, role: "qa-designer", env: env() }).path);
    expect(text).not.toContain("환경별 OpenAPI");
  });

  it("상태에서 목적을 정한다(collected 에서 반송 회차가 있으면 rework)", () => {
    const { dir } = makeRun("collected", { rework: { analysis: 1, plan: 0 } });
    expect(buildPacket({ runDir: dir, role: "technical-manager", env: env() }).purpose).toBe("rework");
  });

  it("알 수 없는 역할·목적은 사용법 오류", () => {
    const { dir } = makeRun("collected");
    expect(() => buildPacket({ runDir: dir, role: "nobody" })).toThrow(/알 수 없는 역할/);
    expect(() => buildPacket({ runDir: dir, role: "technical-manager", purpose: "x", env: env() })).toThrow(/--purpose/);
  });

  it("앞 단계 에이전트의 추론을 담는 칸이 없다", () => {
    const { dir } = makeRun("vetted");
    const text = read(buildPacket({ runDir: dir, role: "qa-designer", env: env() }).path);
    expect(text).not.toMatch(/추론|보고 내용|reasoning/);
  });
});

describe("패킷: qa-designer 의 이전 시나리오 안내와 바뀐 요구 표", () => {
  /** 분석을 내고 시나리오까지 한 번 낸 실행. 그 뒤 분석을 mutate 로 고쳐 정본에 다시 쓴다. */
  function setupWithScenarios(): { dir: string } {
    const { dir } = setupVetted();
    submitArtifact({ runDir: dir, kind: "scenarios", file: writeItemsFile(dir, "sc-in.json", buildScenarios()) });
    return { dir };
  }
  function mutateAnalysis(dir: string, mutate: (items: Doc) => void): void {
    const file = runPaths(dir).analysis;
    const doc = JSON.parse(read(file)) as { items: Doc };
    mutate(doc.items);
    writeFileSync(file, JSON.stringify(doc));
  }
  const qaText = (dir: string, purpose?: string): string => read(buildPacket({ runDir: dir, role: "qa-designer", purpose, env: env() }).path);

  it("이전 시나리오가 없으면 안내도 표도 싣지 않는다", () => {
    const { dir } = setupVetted();
    const text = qaText(dir);
    expect(text).not.toContain("## 이전 시나리오");
    expect(text).not.toContain(runPaths(dir).scenarios);
  });

  it("이전 시나리오가 있으면 목적이 first 이든 apply_answers 이든 안내와 경로를 싣는다", () => {
    const { dir } = setupWithScenarios();
    for (const purpose of ["first", "apply_answers"]) {
      const text = qaText(dir, purpose);
      expect(text).toContain("## 이전 시나리오");
      expect(text).toContain("분석이 바뀐 부분에 걸린 시나리오만 고치고 나머지는 id 와 내용을 유지해 다시 제출한다");
      const readSection = text.split("## 읽을 것")[1]!.split("## ")[0]!;
      expect(readSection).toContain(`\`${runPaths(dir).scenarios}\``);
    }
  });

  it("분석이 그대로이면 바뀐 요구가 없다고 적는다", () => {
    const { dir } = setupWithScenarios();
    const text = qaText(dir);
    expect(text).toContain("바뀐 요구가 없다");
    expect(text).not.toContain("| 요구 id | 변화 |");
  });

  it("요구가 바뀜·추가·삭제되면 id 순으로 표에 싣는다", () => {
    const { dir } = setupWithScenarios();
    mutateAnalysis(dir, (items) => {
      const reqs = items.requirements as Doc[];
      reqs[0]!.title = "바뀐 제목";
      reqs.push({ ...JSON.parse(JSON.stringify(reqs[1]!)), id: "요구-9", title: "새 요구" });
      items.requirements = reqs.filter((r) => r.id !== "요구-2");
    });
    const text = qaText(dir);
    const table = text.split("| 요구 id | 변화 |")[1]!.split("\n\n")[0]!;
    expect(table.trim().split("\n")).toEqual(["|---|---|", "| 요구-1 | 바뀜 |", "| 요구-2 | 삭제 |", "| 요구-9 | 추가 |"]);
  });

  it("basis 가 없는 옛 시나리오 정본이면 바뀐 요구를 알 수 없다고 적고 모든 요구를 대조하라고 한다", () => {
    const { dir } = setupWithScenarios();
    const file = runPaths(dir).scenarios;
    const doc = JSON.parse(read(file)) as Record<string, unknown>;
    delete doc.basis;
    writeFileSync(file, JSON.stringify(doc));
    const text = qaText(dir);
    expect(text).toContain("basis");
    expect(text).toContain("모든 요구를 이전 시나리오와 대조한다");
    expect(text).not.toContain("| 요구 id | 변화 |");
  });
});

describe("패킷: 반송과 답 반영", () => {
  it("반송: 최신 findings 의 차단 issue(fix·ask·drop)만 표로 싣는다", () => {
    const { dir, run } = makeRun("collected", { rework: { analysis: 1, plan: 0 } });
    const p = runPaths(dir);
    const findings = (attempt: number, rows: unknown[]): void =>
      writeFileSync(join(p.findingsDir, `analysis-${attempt}.json`), JSON.stringify({ items: { findings: rows } }));
    findings(1, [{ id: "F-9", work: "W2:요구-9", verdict: "issue", claim: "옛 지적" }]);
    findings(2, [
      { id: "F-1", work: "W2:요구-1", verdict: "issue", kind: "unsupported", claim: "근거에 없는 변경|파이프", evidence: { unit_id: "U-4", quote: "최대 5개" }, action: "fix", blocking: true },
      { id: "F-2", work: "W3:U-4", verdict: "ok", claim: "" },
      { id: "F-3", work: "W9:Q-1", verdict: "issue", kind: "already_answered", claim: "이미 답이 있음", action: "drop", blocking: true },
      { id: "F-4", work: "W2:요구-2", verdict: "issue", kind: "unsupported", claim: "근거 없는 참고", action: "fix", blocking: false },
      { id: "F-5", work: "W2:요구-3", verdict: "issue", kind: "unsupported", claim: "사람에게 물을 것", evidence: { quote: "x" }, action: "ask", blocking: true },
    ]);
    saveRun(dir, { ...run, submissions: { findings_analysis: { attempt: 2, at: "t", hash: "h" } } });
    const r = buildPacket({ runDir: dir, role: "technical-manager", purpose: "rework", env: env() });
    const text = read(r.path);
    expect(text).toContain(join(p.findingsDir, "analysis-2.json"));
    expect(text).toContain("| F-1 | W2:요구-1 | unsupported | 근거에 없는 변경\\|파이프 | U-4: 최대 5개 | fix |");
    expect(text).toContain("| F-3 | W9:Q-1 | already_answered | 이미 답이 있음 |  | drop |");
    expect(text).not.toContain("F-2");
    expect(text).not.toContain("F-4");
    expect(text).toContain("| F-5 | W2:요구-3 | unsupported | 사람에게 물을 것 | x | ask |");
    expect(text).not.toContain("F-9");
  });

  it("반송: 종류·주장이 같은 지적은 한 줄로 묶고 id·대상을 한 칸에 모두 적는다", () => {
    const { dir, run } = makeRun("collected", { rework: { analysis: 1, plan: 0 } });
    const p = runPaths(dir);
    const row = (id: string, work: string, claim: string, action: string) => ({ id, work, verdict: "issue", kind: "missing", claim, evidence: { quote: "q" }, action, blocking: true });
    writeFileSync(
      join(p.findingsDir, "analysis-1.json"),
      JSON.stringify({ items: { findings: [row("F-1", "W3:U-27", "같은 문장 입니다", "ask"), row("F-2", "W3:U-29", "같은문장입니다", "ask"), row("F-3", "W3:U-30", "다른 문장", "fix"), row("F-4", "W3:U-32", "같은 문장입니다", "fix")] } }),
    );
    saveRun(dir, { ...run, submissions: { findings_analysis: { attempt: 1, at: "t", hash: "h" } } });
    const text = read(buildPacket({ runDir: dir, role: "technical-manager", purpose: "rework", env: env() }).path);
    expect(text).toContain("| F-1, F-2, F-4 | W3:U-27, W3:U-29, W3:U-32 | missing | 같은 문장 입니다 | q | ask, fix |");
    expect(text).toContain("| F-3 | W3:U-30 | missing | 다른 문장 | q | fix |");
  });

  it("분석 반송 패킷은 지적 표 아래에 답변 안내와 명령 한 줄, 형식 예시를 싣는다", () => {
    const { dir, run } = makeRun("collected", { rework: { analysis: 1, plan: 0 } });
    const p = runPaths(dir);
    writeFileSync(join(p.findingsDir, "analysis-1.json"), JSON.stringify({ items: { findings: [{ id: "F-1", work: "W2:요구-1", verdict: "issue", kind: "unsupported", claim: "c", action: "ask", blocking: true }] } }));
    saveRun(dir, { ...run, submissions: { findings_analysis: { attempt: 1, at: "t", hash: "h" } } });
    const r = buildPacket({ runDir: dir, role: "technical-manager", purpose: "rework", env: env() });
    const text = read(r.path);
    const [before, after] = text.split("`hew sasu respond`");
    expect(before).toContain("| F-1 |");
    expect(after).toContain("fixed");
    expect(text).toContain(`${join(HEW_ROOT, "bin", "hew")} --json sasu respond --for analysis --run ${dir} --file ${join(p.work, "technical-manager-1", "responses.json")}`);
    expect(text).toContain('"response": "rejected"');
    expect(/```sh\n(.+)\n```/.exec(text)?.[1]).toContain("submit analysis");
  });

  it("분해안 반송 패킷에는 --for plan 답변 안내가 있다", () => {
    const { dir, run } = makeRun("answers_applied", { rework: { analysis: 0, plan: 1 } });
    writeFileSync(join(runPaths(dir).findingsDir, "plan-1.json"), JSON.stringify({ items: { findings: [{ id: "F-1", work: "T1", verdict: "issue", claim: "c" }] } }));
    saveRun(dir, { ...run, submissions: { findings_plan: { attempt: 1, at: "t", hash: "h" } } });
    const text = read(buildPacket({ runDir: dir, role: "ticket-maker", env: env() }).path);
    expect(text).toContain(`sasu respond --for plan --run ${dir} --file ${join(runPaths(dir).work, "ticket-maker-1", "responses.json")}`);
    expect(text).toContain("티켓 id");
  });

  it("ticket-maker 반송은 plan 용 findings 를 본다", () => {
    const { dir, run } = makeRun("answers_applied", { rework: { analysis: 0, plan: 1 } });
    const p = runPaths(dir);
    writeFileSync(join(p.findingsDir, "plan-1.json"), JSON.stringify({ items: { findings: [{ id: "F-1", work: "T1", verdict: "issue", claim: "맥락 누락" }] } }));
    saveRun(dir, { ...run, submissions: { findings_plan: { attempt: 1, at: "t", hash: "h" } } });
    const text = read(buildPacket({ runDir: dir, role: "ticket-maker", env: env() }).path);
    expect(text).toContain("맥락 누락");
    expect(text).toContain("submit plan");
  });

  it("답 반영: answers.json 경로와 답·결정·가정 확인을 표로 싣는다", () => {
    const { dir } = makeRun("answers_complete");
    const p = runPaths(dir);
    writeFileSync(
      p.answers,
      JSON.stringify({
        answers: { "Q-1": { option: "a", at: "t" }, "Q-2": { text: "자유 답", at: "t" } },
        scope: { "D-1": { decision: "follow_figma", note: "시안 우선", at: "t" } },
        assumptions: { "A-1": { status: "confirmed", at: "t" } },
      }),
    );
    const text = read(buildPacket({ runDir: dir, role: "technical-manager", purpose: "apply_answers", env: env() }).path);
    expect(text).toContain(p.answers);
    expect(text).toContain("| 질문 답 | Q-1 | a |");
    expect(text).toContain("| 질문 답 | Q-2 | 자유 답 |");
    expect(text).toContain("| 차이 결정 | D-1 | follow_figma | 시안 우선 |");
    expect(text).toContain("| 가정 확인 | A-1 | confirmed |");
    expect(text).toContain("목적: apply_answers");
  });
});

describe("패킷: 따를 규칙(heka)", () => {
  it("열 개 규칙의 제목과 본문을 싣는다", () => {
    const { dir } = makeRun("collected");
    const r = buildPacket({ runDir: dir, role: "technical-manager", env: env() });
    const text = read(r.path);
    expect(r.warnings).toEqual([]);
    for (const id of ["requirement-source-priority-figma-first", "hew-id-labels-korean", "figma-to-mobile-component-lookup"]) {
      expect(text).toContain(`### ${id} — 제목 ${id}`);
      expect(text).toContain(`본문 ${id}`);
    }
  });

  it("본문은 1,500자에서 자른다", () => {
    const { dir } = makeRun("collected");
    const text = read(buildPacket({ runDir: dir, role: "technical-manager", env: env({ FAKE_HEKA_MODE: "long" }) }).path);
    expect(text).toContain(`${"가".repeat(1500)}…(이하 생략)`);
    expect(text).not.toContain("가".repeat(1501));
  });

  it("replay 에서도 known_at 으로 거르지 않고 역할별 규칙을 항상 싣는다", () => {
    const { dir } = makeRun("collected", { mode: "replay", case: "c.yaml", known_at: "2026-10-01" });
    const text = read(buildPacket({ runDir: dir, role: "technical-manager", env: env({ FAKE_HEKA_LATE: "hew-id-labels-korean" }) }).path);
    expect(text).toContain("본문 hew-id-labels-korean");
    expect(text).not.toContain("시점 이후라 제외");
    expect(text).toContain("본문 hew-2026-10-21-figma-prd");
  });

  it("live 에서는 known_at 이 있어도 거르지 않는다", () => {
    const { dir } = makeRun("collected", { known_at: "2026-10-01" });
    const text = read(buildPacket({ runDir: dir, role: "technical-manager", env: env({ FAKE_HEKA_LATE: "hew-id-labels-korean" }) }).path);
    expect(text).toContain("본문 hew-id-labels-korean");
  });

  it("사례의 차단 heka id 만 빼고 이유를 적는다", () => {
    const { dir } = makeRun("collected", {
      mode: "replay",
      case: "c.yaml",
      case_info: { block: { jira_keys: [], pr_numbers: [], heka_ids: ["hew-id-labels-korean"] } },
    });
    const r = buildPacket({ runDir: dir, role: "technical-manager", env: env() });
    const text = read(r.path);
    expect(text).toMatch(/### hew-id-labels-korean\n\n사례의 차단 목록에 있어 제외/);
    expect(text).not.toContain("본문 hew-id-labels-korean");
    expect(text).toContain("본문 hew-2026-10-21-figma-prd");
    expect(text).toContain("본문 figma-to-mobile-component-lookup");
    expect(r.warnings).toEqual([]);
  });

  it("차단 id 는 모드와 상관없이 case_info 가 있으면 뺀다", () => {
    const { dir } = makeRun("collected", { case_info: { block: { jira_keys: [], pr_numbers: [], heka_ids: ["small-commits"] } } });
    const text = read(buildPacket({ runDir: dir, role: "ticket-maker", env: env() }).path);
    expect(text).toMatch(/### small-commits\n\n사례의 차단 목록에 있어 제외/);
    expect(text).toContain("본문 jira-ticket-title-format");
  });

  it("heka 도구가 실패하면 id 와 '본문을 읽지 못함' 만 싣고 경고를 낸다(생성은 성공)", () => {
    const { dir } = makeRun("collected");
    const r = buildPacket({ runDir: dir, role: "technical-manager", env: env({ FAKE_HEKA_MODE: "fail" }) });
    const text = read(r.path);
    expect(existsSync(r.path)).toBe(true);
    expect(text).toMatch(/### hew-id-labels-korean\n\n본문을 읽지 못함/);
    expect(r.warnings).toHaveLength(10);
    expect(r.warnings[0]).toMatchObject({ code: "heka_unreadable", severity: "warn" });
  });

  it("heka 출력이 JSON 이 아니거나 도구 파일이 없어도 경고만 낸다", () => {
    const { dir } = makeRun("collected");
    const bad = buildPacket({ runDir: dir, role: "technical-manager", env: env({ FAKE_HEKA_MODE: "badjson" }) });
    expect(bad.warnings).toHaveLength(10);
    const missing = buildPacket({ runDir: dir, role: "technical-manager", env: env({ HEW_HEKA_BIN: join(tempDir("hew-nobin-"), "nope.js") }) });
    expect(missing.warnings[0]?.message).toContain("heka 도구가 없습니다");
  });
});

describe("패킷: collector", () => {
  let seq = 0;
  const collectorPacket = (patch: Parameters<typeof makeRun>[1] = {}) => {
    const { dir } = makeRun("init", patch, `col-${++seq}`);
    const r = buildPacket({ runDir: dir, role: "collector", env: env() });
    return { dir, r, text: read(r.path) };
  };

  it("실행 폴더, 모드, 수집 계획 표, 쓸 명령(정확한 형태와 예시)이 있다", () => {
    const { dir, r, text } = collectorPacket();
    const hew = hewBinPath();
    expect(r).toMatchObject({ n: 1, purpose: "first", role: "collector" });
    expect(text).toContain(`실행 폴더: \`${dir}\``);
    expect(text).toContain("live");
    expect(text).toContain("| 항목 id | 처리 | 무엇 | 도구 | 등록 값 | 비고 |");
    expect(text).toContain("| prd:123 | 가져옴 | Confluence PRD 페이지 123 |");
    expect(text).toContain("--kind prd --ref 123");
    for (const sub of ["plan", "calls", "done"]) expect(text).toContain(`\`${hew} --json source ${sub} --run ${dir}\``);
    expect(text).toContain(`${hew} --json source add --run ${dir} <등록 값> --from-call <번호>`);
    expect(text).toContain(`${hew} --json source add --run ${dir} <등록 값> --file ${r.workDir}/shots/<이름>.png`);
    expect(text).toContain(`${hew} --json source fail --run ${dir} --item <항목 id> --reason "<사유>"`);
    expect(text).toContain(`--kind prd --ref 123456 --version 22 --from-call 1`);
    expect(existsSync(join(r.workDir, "shots"))).toBe(true);
  });

  it("읽기 도구 이름, cloudId, 지정 버전 조회 방법, 스크린샷 내려받기 형태", () => {
    const { text } = collectorPacket();
    expect(text).toContain("cloudId: `example.atlassian.net`");
    expect(text).toContain("`getConfluencePage`(cloudId, pageId, contentFormat: markdown)");
    expect(text).toContain("`getConfluenceContentVersion`(contentId, versionNumber, content_format: markdown)");
    expect(text).toContain("`responseFields` 를 주지 않는다");
    expect(text).toContain("`ToolSearch` 로 `get_metadata`·`get_screenshot` 을 찾은 뒤");
    expect(text).toContain("`get_screenshot`(fileKey, nodeId, maxDimension)");
    expect(text).toMatch(/curl -sS -L -f --max-time 60 -o \S+\/shots\/12-34\.png "https:\/\/<주소>"/);
  });

  it("사례의 PRD 버전은 계획 표에 지정 버전만 가져오라는 비고로 실린다", () => {
    const { text } = collectorPacket({ case_info: { prd_version: "22", block: { jira_keys: [], pr_numbers: [], heka_ids: [] } } });
    expect(text).toContain("지정 버전만. 현재 버전으로 대신하지 않는다");
    expect(text).toContain("--kind prd --ref 123 --version 22");
  });

  it("차단 목록이 있으면 읽지 않을 것 표를 싣고 없으면 절이 없다", () => {
    const blocked = collectorPacket({ case_info: { block: { jira_keys: ["APP-3094"], pr_numbers: [1054], heka_ids: [] } } }).text;
    expect(blocked).toContain("## 읽지 않을 것");
    expect(blocked).toContain("| Jira | APP-3094 |");
    expect(blocked).toContain("| PR | #1054 |");
    expect(collectorPacket().text).not.toContain("## 읽지 않을 것");
  });

  it("역할 규칙(heka)을 싣는다", () => {
    const { text } = collectorPacket();
    expect(text).toContain("### figma-mcp-read-procedure — 제목 figma-mcp-read-procedure");
    expect(text).toContain("### confluence-page-version-body-via-atlassian-mcp");
  });

  it("code 원천이 없으면 대상 저장소가 지정되지 않음을 막힌 일로 싣는다", () => {
    expect(collectorPacket().text).toContain("대상 저장소가 지정되지 않음");
  });
});

describe("hew packet 명령(자식 프로세스)", () => {
  it("--json 으로 경로를 돌려주고 heka 가 없으면 경고를 낸다", () => {
    const { dir } = makeRun("collected");
    const r = spawnSync(join(HEW_ROOT, "bin", "hew"), ["--json", "packet", "--run", dir, "--role", "technical-manager"], {
      env: { ...process.env, HEW_RUNS_DIR: runs.dir, HEW_HEKA_BIN: join(runs.dir, "nope.js") },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const body = JSON.parse(r.stdout) as { ok: boolean; data: { path: string; n: number }; warnings: { code: string }[] };
    expect(body.ok).toBe(true);
    expect(existsSync(body.data.path)).toBe(true);
    expect(body.warnings[0]?.code).toBe("heka_unreadable");
    expect(loadRun(dir).state).toBe("collected");
  });
});
