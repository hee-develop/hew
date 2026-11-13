import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bodyFromResponse, markdownFromSource, metaFromResponse } from "../src/core/units/extract.js";
import { HewError } from "../src/core/errors.js";
import { loadManifest } from "../src/core/manifest.js";
import { HEW_ROOT, runPaths } from "../src/core/paths.js";
import { loadRun } from "../src/core/run.js";
import { addSource, doneSources, failSource, listCalls } from "../src/core/sources.js";
import { buildUnits } from "../src/core/units/index.js";
import { FIGMA_KEY, META_JSON, PRD_BODY, confluenceResponse, jiraResponse, seedCalls } from "./collect-fixtures.js";
import { makeRun, useTempRunsDir } from "./helpers.js";
import { writeFixture } from "./source-fixtures.js";

const runs = useTempRunsDir();

const codeOf = (fn: () => unknown): number | null => {
  try {
    fn();
  } catch (e) {
    return e instanceof HewError ? e.exitCode : -1;
  }
  return null;
};

const cli = (args: string[]) => spawnSync(join(HEW_ROOT, "bin", "hew"), ["--json", ...args], { env: { ...process.env, HEW_RUNS_DIR: runs.dir }, encoding: "utf8" });

describe("source add --from-call", () => {
  it("받아 적은 payload 를 바이트 그대로 원천 파일로 복사하고 meta 에 호출 정보를 남긴다", () => {
    const { dir } = makeRun();
    const text = confluenceResponse("## 제목\n\n- 항목\r\n");
    seedCalls(dir, [{ tool: "mcp__claude_ai_Atlassian__getConfluencePage", tool_use_id: "toolu_abc", payload: text }]);
    const { source } = addSource({ runDir: dir, kind: "prd", ref: "123", version: "22", fromCall: 1 });
    expect(source.path).toMatch(/\.json$/);
    expect(readFileSync(join(dir, source.path as string))).toEqual(Buffer.from(text, "utf8"));
    expect(source.meta).toEqual({ call: 1, tool: "mcp__claude_ai_Atlassian__getConfluencePage", tool_use_id: "toolu_abc" });
    expect(source.version).toBe("22");
    expect(loadManifest(dir).sources[0]?.meta.call).toBe(1);
  });

  it("확장자는 payload 가 JSON 으로 읽히면 .json, 아니면 .md", () => {
    const { dir } = makeRun();
    seedCalls(dir, [
      { tool: "mcp__a__x", payload: '{"a":1}' },
      { tool: "mcp__a__x", payload: "## 그냥 글\n\n- 항목" },
      { tool: "mcp__a__x", payload: "[1, 2" },
    ]);
    const exts = [1, 2, 3].map((n) => addSource({ runDir: dir, kind: "related", ref: `p${n}`, fromCall: n }).source.path?.split(".").pop());
    expect(exts).toEqual(["json", "md", "md"]);
  });

  it("--file 과 --from-call 을 함께 주거나 둘 다 없으면 사용법 오류(종료 2)", () => {
    const { dir } = makeRun();
    seedCalls(dir, [{ tool: "mcp__a__x", payload: "x" }]);
    const file = writeFixture(dir, "in/a.md", "x");
    expect(codeOf(() => addSource({ runDir: dir, kind: "prd", ref: "1", file, fromCall: 1 }))).toBe(2);
    expect(codeOf(() => addSource({ runDir: dir, kind: "prd", ref: "1" }))).toBe(2);
  });

  it("없는 호출 번호나 수집 작업 폴더가 없으면 사용법 오류(종료 2)", () => {
    const { dir } = makeRun();
    expect(codeOf(() => addSource({ runDir: dir, kind: "prd", ref: "1", fromCall: 1 }))).toBe(2);
    seedCalls(dir, [{ tool: "mcp__a__x", payload: "x" }]);
    expect(codeOf(() => addSource({ runDir: dir, kind: "prd", ref: "1", fromCall: 9 }))).toBe(2);
  });

  it("code 에는 --from-call 을 쓸 수 없다", () => {
    const { dir } = makeRun();
    seedCalls(dir, [{ tool: "mcp__a__x", payload: "x" }]);
    expect(codeOf(() => addSource({ runDir: dir, kind: "code", ref: "/r", baseSha: "a", fromCall: 1 }))).toBe(2);
  });

  it("가장 최근 수집 작업 폴더의 호출을 쓴다", () => {
    const { dir } = makeRun();
    seedCalls(dir, [{ tool: "mcp__a__x", payload: "옛것" }], 1);
    seedCalls(dir, [{ tool: "mcp__a__x", payload: "새것" }], 2);
    const { source } = addSource({ runDir: dir, kind: "related", ref: "r", fromCall: 1 });
    expect(readFileSync(join(dir, source.path as string), "utf8")).toBe("새것");
  });

  it("큰 Figma 결과 payload 로 figma_meta 를 등록한다", () => {
    const { dir } = makeRun();
    seedCalls(dir, [{ tool: "mcp__claude_ai_Figma__get_metadata", payload: META_JSON, from_file: true }]);
    const { source } = addSource({ runDir: dir, kind: "figma_meta", ref: `${FIGMA_KEY}:1-92`, node: "1:92", fromCall: 1 });
    expect(source.path).toMatch(/\.json$/);
    const units = buildUnits(dir);
    expect(units.inventory?.files[0]?.file_key).toBe(FIGMA_KEY);
    expect(units.units.units.filter((u) => u.kind === "figma_screen").length).toBeGreaterThan(0);
  });
});

describe("Confluence·Jira 응답 JSON 에서 본문·제목·버전 추출", () => {
  it("Confluence 응답은 content.nodes[0].body 를 Markdown 으로 꺼내 표 행이 table_row 단위가 된다", () => {
    const { dir } = makeRun();
    addSource({ runDir: dir, kind: "prd", ref: "123", file: writeFixture(dir, "in/prd.json", confluenceResponse(PRD_BODY)) });
    const units = buildUnits(dir).units.units;
    const rows = units.filter((u) => u.kind === "table_row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.columns?.["User Journey"]).toBe("판매자가 홈에서 배너를 본다");
    expect((rows[0]?.locator as { section: string[] }).section).toEqual(["Requirements"]);
  });

  it("제목은 manifest 의 title 이 비어 있을 때만 채우고 버전은 응답에 있을 때만 채운다", () => {
    const { dir } = makeRun();
    const a = addSource({ runDir: dir, kind: "prd", ref: "1", file: writeFixture(dir, "in/a.json", confluenceResponse("- 가", { version: { number: 22 } })) });
    expect(a.source).toMatchObject({ title: "합성 PRD", version: "22" });
    const b = addSource({ runDir: dir, kind: "prd", ref: "2", title: "내가 정한 제목", version: "5", file: writeFixture(dir, "in/b.json", confluenceResponse("- 가", { version: 9 })) });
    expect(b.source).toMatchObject({ title: "내가 정한 제목", version: "5" });
    const c = addSource({ runDir: dir, kind: "prd", ref: "3", file: writeFixture(dir, "in/c.json", confluenceResponse("- 가")) });
    expect(c.source.title).toBe("합성 PRD");
    expect(c.source.version).toBeUndefined();
  });

  it("응답에서 채운 버전도 같은 원천 식별에 쓰여 다시 등록하면 같은 id 로 바뀐다", () => {
    const { dir } = makeRun();
    const a = addSource({ runDir: dir, kind: "prd", ref: "1", file: writeFixture(dir, "in/a.json", confluenceResponse("- 가", { version: { number: 4 } })) });
    const b = addSource({ runDir: dir, kind: "prd", ref: "1", file: writeFixture(dir, "in/a.json", confluenceResponse("- 가", { version: { number: 4 } })) });
    expect(b.source.id).toBe(a.source.id);
    expect(b.unchanged).toBe(true);
  });

  it("Confluence 응답의 모양이 달라도(nodes 만, results, 본문 객체) 본문을 찾는다", () => {
    expect(bodyFromResponse({ nodes: [{ id: "1", body: "A" }] })).toBe("A");
    expect(bodyFromResponse({ results: [{ id: "1", body: { value: "B" } }] })).toBe("B");
    expect(bodyFromResponse({ id: "1", title: "t", body: "C" })).toBe("C");
    expect(bodyFromResponse(JSON.stringify({ content: JSON.stringify({ nodes: [{ id: "1", body: "D" }] }) }))).toBe("D");
    expect(metaFromResponse({ nodes: [{ id: "1", title: "T", body: "x", versionNumber: 3 }] })).toEqual({ title: "T", version: "3" });
  });

  it("Jira 응답은 fields.description 과 fields.summary 에서 본문을 만든다", () => {
    const text = jiraResponse({ key: "ABC-1", summary: "요약 제목", description: "- 첫째\n- 둘째" });
    expect(bodyFromResponse(JSON.parse(text))).toBe("# 요약 제목\n\n- 첫째\n- 둘째");
    expect(metaFromResponse(JSON.parse(text))).toEqual({ title: "요약 제목" });
  });

  it("Jira 본문은 fields.description → renderedFields.description → 최상위 description 순으로 찾는다", () => {
    expect(bodyFromResponse({ fields: { summary: "s", description: "" }, renderedFields: { description: "렌더" } })).toBe("# s\n\n렌더");
    expect(bodyFromResponse({ description: "최상위" })).toBe("최상위");
    expect(bodyFromResponse({ fields: { description: "필드" }, renderedFields: { description: "렌더" }, description: "최상위" })).toBe("필드");
  });

  it("Jira 의 문서 형식(ADF) 본문은 글자만 모은다", () => {
    const adf = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "가나" }] }, { type: "paragraph", content: [{ type: "text", text: "다라" }] }] };
    expect(bodyFromResponse({ fields: { description: adf } })).toBe("가나\n다라");
  });

  it("알 수 없는 JSON 이나 비어 있는 응답은 빈 문자열이고 JSON 이 아닌 파일은 그대로다", () => {
    expect(bodyFromResponse({ x: 1 })).toBe("");
    expect(markdownFromSource("그대로 # 글", "a.md")).toBe("그대로 # 글");
    expect(markdownFromSource("{깨짐", "a.json")).toBe("{깨짐");
  });

  it("Jira 티켓 원천 등록 때 제목은 채우고 버전은 채우지 않는다", () => {
    const { dir } = makeRun();
    const { source } = addSource({ runDir: dir, kind: "ticket", ref: "ABC-1", file: writeFixture(dir, "in/t.json", jiraResponse({ key: "ABC-1", summary: "티켓 제목", description: "- 본문" })) });
    expect(source.title).toBe("티켓 제목");
    expect(source.version).toBeUndefined();
    const units = buildUnits(dir).units.units;
    expect(units.map((u) => u.text)).toContain("본문");
  });
});

describe("source calls", () => {
  it("번호, 도구, 입력 요약, 크기, 이미 등록됐는지를 낸다", () => {
    const { dir } = makeRun();
    seedCalls(dir, [
      { tool: "mcp__a__getConfluencePage", input: { cloudId: "c", pageId: "123" }, payload: confluenceResponse("- 가") },
      { tool: "mcp__a__getJiraIssue", input: { issueIdOrKey: "ABC-1" }, payload: "다른 것" },
    ]);
    addSource({ runDir: dir, kind: "prd", ref: "123", fromCall: 1 });
    const { calls } = listCalls(dir);
    expect(calls.map((c) => [c.n, c.tool, c.registered])).toEqual([[1, "mcp__a__getConfluencePage", "S-1"], [2, "mcp__a__getJiraIssue", null]]);
    expect(calls[0]?.input).toContain("pageId");
    expect(calls[1]?.bytes).toBe(Buffer.byteLength("다른 것"));
  });

  it("명령은 표를 출력하고 수집 작업 폴더가 없으면 종료 2", () => {
    const { dir } = makeRun();
    expect(cli(["source", "calls", "--run", dir]).status).toBe(2);
    seedCalls(dir, [{ tool: "mcp__a__x", payload: "x" }]);
    const r = cli(["source", "calls", "--run", dir]);
    expect(r.status).toBe(0);
    expect((JSON.parse(r.stdout) as { data: { calls: unknown[] } }).data.calls).toHaveLength(1);
  });

  it("--from-call 이 숫자가 아니면 종료 2", () => {
    const { dir } = makeRun();
    expect(cli(["source", "add", "--run", dir, "--kind", "related", "--ref", "r", "--from-call", "abc"]).status).toBe(2);
  });
});

describe("source done: 필수·계획·경고", () => {
  function ready(): string {
    const { dir } = makeRun();
    addSource({ runDir: dir, kind: "prd", ref: "123", file: writeFixture(dir, "in/prd.json", confluenceResponse("- 본문\n")) });
    addSource({ runDir: dir, kind: "code", ref: "/repo", baseSha: "abc" });
    return dir;
  }

  it("필수 원천이 없으면 종료 3 이고 상태는 init 그대로", () => {
    const { dir } = makeRun();
    expect(codeOf(() => doneSources(dir))).toBe(3);
    expect(loadRun(dir).state).toBe("init");
  });

  it("필수가 다 있고 계획이 비면 통과한다", () => {
    const dir = ready();
    const r = doneSources(dir);
    expect(r).toMatchObject({ state: "collected", warnings: [] });
    expect(loadRun(dir).collect_warnings).toBeUndefined();
  });

  it("계획에 가져올 항목이 남아 있으면 종료 3 과 남은 항목 목록", () => {
    const dir = ready();
    addSource({ runDir: dir, kind: "prd", ref: "123", file: writeFixture(dir, "in/prd2.json", confluenceResponse(PRD_BODY)) });
    try {
      doneSources(dir);
      expect.unreachable();
    } catch (e) {
      const refs = (e as HewError).issues.map((i) => i.ref);
      expect(refs).toContain("related:456");
      expect(refs).toContain("related:789");
    }
    expect(loadRun(dir).state).toBe("init");
  });

  it("Figma 링크가 있는데 figma_meta 가 없고 시도한 기록도 없으면 종료 3(figma_meta)", () => {
    const dir = ready();
    addSource({ runDir: dir, kind: "prd", ref: "123", file: writeFixture(dir, "in/prd2.json", confluenceResponse(`https://www.figma.com/design/${FIGMA_KEY}/x?node-id=1-92\n`)) });
    try {
      doneSources(dir);
      expect.unreachable();
    } catch (e) {
      expect((e as HewError).issues.map((i) => i.ref)).toEqual(["figma_meta"]);
    }
  });

  it("figma_meta 가 한 번 실패하면 아직 계획에 남아 종료 3, 두 번 실패하면 경고로 통과하고 run.json 의 collect_warnings 에 남는다", () => {
    const dir = ready();
    addSource({ runDir: dir, kind: "prd", ref: "123", file: writeFixture(dir, "in/prd2.json", confluenceResponse(`https://www.figma.com/design/${FIGMA_KEY}/x?node-id=1-92\n`)) });
    const item = `figma_meta:${FIGMA_KEY}:1-92`;
    failSource({ runDir: dir, item, reason: "호출 한도" });
    expect(codeOf(() => doneSources(dir))).toBe(3);
    failSource({ runDir: dir, item, reason: "호출 한도" });
    const r = doneSources(dir);
    expect(r.state).toBe("collected");
    expect(r.warnings).toHaveLength(1);
    const run = loadRun(dir);
    expect(run.collect_warnings).toEqual([{ code: "item_failed", item, message: expect.stringContaining("2회 실패") }]);
    expect(readFileSync(runPaths(dir).manifest, "utf8")).not.toContain("collect_warnings");
    expect(readFileSync(runPaths(dir).manifest, "utf8")).not.toContain("호출 한도");
  });

  it("스크린샷 일부와 관련 문서의 실패는 경고로 통과시킨다", () => {
    const dir = ready();
    addSource({ runDir: dir, kind: "prd", ref: "123", file: writeFixture(dir, "in/prd2.json", confluenceResponse(PRD_BODY)) });
    addSource({ runDir: dir, kind: "figma_meta", ref: `${FIGMA_KEY}:1-92`, node: "1:92", file: writeFixture(dir, "in/meta.json", META_JSON) });
    for (const id of ["related:456", "related:789", `figma_shot:${FIGMA_KEY}:4-2`]) for (let i = 0; i < 2; i += 1) failSource({ runDir: dir, item: id, reason: "실패" });
    expect(codeOf(() => doneSources(dir))).toBe(3);
    addSource({ runDir: dir, kind: "figma_shot", ref: FIGMA_KEY, node: "4:1", file: writeFixture(dir, "in/s1.png", "a") });
    addSource({ runDir: dir, kind: "figma_shot", ref: FIGMA_KEY, node: "4:3", file: writeFixture(dir, "in/s3.png", "b") });
    const r = doneSources(dir);
    expect(r.state).toBe("collected");
    expect(loadRun(dir).collect_warnings?.map((w) => w.item)).toEqual([`figma_shot:${FIGMA_KEY}:4-2`, "related:456", "related:789"]);
  });

  it("노드 지정 없는 Figma 링크만 있으면 건너뛰고 경고로 통과한다", () => {
    const dir = ready();
    addSource({ runDir: dir, kind: "prd", ref: "123", file: writeFixture(dir, "in/prd2.json", confluenceResponse(`https://www.figma.com/design/${FIGMA_KEY}/x\n`)) });
    const r = doneSources(dir);
    expect(r.state).toBe("collected");
    expect(r.warnings).toEqual([expect.objectContaining({ code: "item_skipped", message: expect.stringContaining("노드 지정 없음") })]);
  });

  it("필수인 PRD 가 두 번 실패해도 통과하지 않는다", () => {
    const { dir } = makeRun();
    addSource({ runDir: dir, kind: "code", ref: "/repo", baseSha: "abc" });
    for (let i = 0; i < 2; i += 1) failSource({ runDir: dir, item: "prd:123", reason: "없는 문서" });
    try {
      doneSources(dir);
      expect.unreachable();
    } catch (e) {
      expect((e as HewError).issues.map((i) => i.ref)).toEqual(["prd"]);
    }
  });

  it("상위 이슈 항목이 남아 있으면 종료 3", () => {
    const { dir } = makeRun("init", { input: { kind: "ticket", url: "https://x.atlassian.net/browse/ABC-2" } });
    addSource({ runDir: dir, kind: "code", ref: "/repo", baseSha: "abc" });
    addSource({ runDir: dir, kind: "ticket", ref: "ABC-2", file: writeFixture(dir, "in/t.json", jiraResponse({ key: "ABC-2", parent: "ABC-1" })) });
    try {
      doneSources(dir);
      expect.unreachable();
    } catch (e) {
      expect((e as HewError).issues.map((i) => i.ref)).toEqual(["ticket:ABC-1"]);
    }
  });

  it("done 을 다시 부르면 경고 목록을 새로 계산해 바꾼다", () => {
    const dir = ready();
    addSource({ runDir: dir, kind: "prd", ref: "123", file: writeFixture(dir, "in/prd2.json", confluenceResponse(`https://www.figma.com/design/${FIGMA_KEY}/x\n`)) });
    doneSources(dir);
    expect(loadRun(dir).collect_warnings).toHaveLength(1);
    addSource({ runDir: dir, kind: "prd", ref: "123", file: writeFixture(dir, "in/prd3.json", confluenceResponse("- 없음\n")) });
    doneSources(dir);
    expect(loadRun(dir).collect_warnings).toBeUndefined();
  });
});

describe("hew source fail·add·done 명령", () => {
  it("fail 은 사유를 failures.jsonl 에 덧붙인다", () => {
    const { dir } = makeRun();
    const r = cli(["source", "fail", "--run", dir, "--item", "prd:123", "--reason", "권한 없음 / 없는 문서"]);
    expect(r.status).toBe(0);
    const lines = readFileSync(runPaths(dir).failures, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, string>);
    expect(lines).toEqual([expect.objectContaining({ item: "prd:123", reason: "권한 없음 / 없는 문서" })]);
    expect(cli(["source", "fail", "--run", dir, "--item", "nope:1", "--reason", "x"]).status).toBe(2);
    expect(existsSync(runPaths(dir).failures)).toBe(true);
  });

  it("done 은 계획이 남았으면 종료 3 이고 errors 에 항목이 있다", () => {
    const { dir } = makeRun();
    const r = cli(["source", "done", "--run", dir]);
    expect(r.status).toBe(3);
    expect((JSON.parse(r.stdout) as { errors: { code: string }[] }).errors.some((e) => e.code === "source_missing")).toBe(true);
  });
});
