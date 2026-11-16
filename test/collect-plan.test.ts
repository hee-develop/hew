import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { loadCollectConfig } from "../src/core/collect/config.js";
import { computePlan, figmaLinks, jiraKeyFromUrl, pageIdFromUrl } from "../src/core/collect/plan.js";
import { HewError } from "../src/core/errors.js";
import { addSource, failSource } from "../src/core/sources.js";
import { loadRun, saveRun } from "../src/core/run.js";
import { HEW_ROOT } from "../src/core/paths.js";
import { FIGMA_KEY, META_JSON, PRD_BODY, confluenceResponse, jiraResponse } from "./collect-fixtures.js";
import { makeRun, useTempRunsDir } from "./helpers.js";
import { writeFixture } from "./source-fixtures.js";

const runs = useTempRunsDir();
const config = loadCollectConfig();

function withPrd(body = PRD_BODY, state: "init" = "init"): string {
  const { dir } = makeRun(state);
  addSource({ runDir: dir, kind: "prd", ref: "123", file: writeFixture(dir, "in/prd.json", confluenceResponse(body)) });
  return dir;
}

function withMeta(dir: string): void {
  addSource({ runDir: dir, kind: "figma_meta", ref: `${FIGMA_KEY}:1-92`, node: "1:92", file: writeFixture(dir, "in/meta.json", META_JSON) });
}

const ids = (dir: string, cfg = config): string[] => computePlan(dir, cfg).items.map((i) => i.id);

describe("수집 계획: 입력", () => {
  it("PRD 입력이고 prd 원천이 없으면 Confluence 페이지 항목이 첫 항목이다(페이지 id 는 URL 에서)", () => {
    const { dir } = makeRun();
    const plan = computePlan(dir, config);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ id: "prd:123", register: { kind: "prd", ref: "123" } });
    expect(plan.items[0]?.register.version).toBeUndefined();
    expect(plan.items[0]?.tool_hint).toContain("getConfluencePage(cloudId=example.atlassian.net, pageId=123, contentFormat=markdown)");
    expect(plan.items[0]?.note).toBeUndefined();
    expect(plan.remaining).toBe(1);
  });

  it("pageId= 쿼리 형식의 주소에서도 페이지 id 를 읽는다", () => {
    expect(pageIdFromUrl("https://x.atlassian.net/wiki/pages/viewpage.action?pageId=1000000001")).toBe("1000000001");
    expect(pageIdFromUrl("https://x.atlassian.net/wiki/spaces/A/pages/55/Title")).toBe("55");
    expect(pageIdFromUrl("https://x.atlassian.net/wiki/display/A/Title")).toBeUndefined();
    const { dir } = makeRun("init", { input: { kind: "prd", url: "https://x.atlassian.net/wiki/pages/viewpage.action?pageId=777" } });
    expect(ids(dir)).toEqual(["prd:777"]);
  });

  it("사례의 PRD 버전이 있으면 version 을 싣고 현재 버전으로 대신하지 않는다고 적는다", () => {
    const { dir } = makeRun("init", { case_info: { prd_version: "22", block: { jira_keys: [], pr_numbers: [], heka_ids: [] } } });
    const item = computePlan(dir, config).items[0];
    expect(item).toMatchObject({ id: "prd:123", register: { kind: "prd", ref: "123", version: "22" }, note: "지정 버전만. 현재 버전으로 대신하지 않는다" });
    expect(item?.tool_hint).toContain("getConfluenceContentVersion");
    expect(item?.tool_hint).toContain("versionNumber: 22");
    expect(item?.tool_hint).toContain("responseFields");
  });

  it("PRD 주소에서 페이지 id 를 알 수 없으면 항목 없이 막힘으로 알린다", () => {
    const { dir } = makeRun("init", { input: { kind: "prd", url: "https://x.atlassian.net/wiki/display/A/Title" } });
    const plan = computePlan(dir, config);
    expect(plan.items).toEqual([]);
    expect(plan.blocked.some((b) => b.includes("페이지 id"))).toBe(true);
  });

  it("티켓 입력이고 ticket 원천이 없으면 Jira 이슈 항목이 첫 항목이다", () => {
    const { dir } = makeRun("init", { input: { kind: "ticket", url: "https://x.atlassian.net/browse/ABC-2" } });
    const plan = computePlan(dir, config);
    expect(plan.items.map((i) => i.id)).toEqual(["ticket:ABC-2"]);
    expect(plan.items[0]?.register).toEqual({ kind: "ticket", ref: "ABC-2" });
    expect(plan.items[0]?.tool_hint).toContain("getJiraIssue");
    expect(jiraKeyFromUrl("https://x.atlassian.net/jira/software/projects/ABC/boards/1?selectedIssue=ABC-9")).toBe("ABC-9");
  });

  it("등록된 티켓 응답에 상위 이슈(parent)가 있으면 상위 이슈 항목(1단계만)이 생긴다", () => {
    const { dir } = makeRun("init", { input: { kind: "ticket", url: "https://x.atlassian.net/browse/ABC-2" } });
    addSource({ runDir: dir, kind: "ticket", ref: "ABC-2", file: writeFixture(dir, "in/t.json", jiraResponse({ key: "ABC-2", description: "본문", parent: "ABC-1" })) });
    expect(ids(dir)).toEqual(["ticket:ABC-1"]);
    addSource({ runDir: dir, kind: "ticket", ref: "ABC-1", file: writeFixture(dir, "in/p.json", jiraResponse({ key: "ABC-1", description: "상위 본문", parent: "ABC-0" })) });
    expect(ids(dir)).toEqual([]);
  });

  it("차단 목록에 든 상위 이슈는 항목으로 두지 않고 막힘으로 알린다", () => {
    const { dir } = makeRun("init", {
      input: { kind: "ticket", url: "https://x.atlassian.net/browse/ABC-2" },
      case_info: { block: { jira_keys: ["ABC-1"], pr_numbers: [], heka_ids: [] } },
    });
    addSource({ runDir: dir, kind: "ticket", ref: "ABC-2", file: writeFixture(dir, "in/t.json", jiraResponse({ key: "ABC-2", parent: "ABC-1" })) });
    const plan = computePlan(dir, config);
    expect(plan.items).toEqual([]);
    expect(plan.blocked.join("\n")).toContain("ABC-1");
  });

  it("code 원천이 없으면 대상 저장소가 지정되지 않음을 blocked 로 알린다", () => {
    const { dir } = makeRun();
    expect(computePlan(dir, config).blocked.join("\n")).toContain("대상 저장소가 지정되지 않음");
    addSource({ runDir: dir, kind: "code", ref: "/repo", baseSha: "abc" });
    expect(computePlan(dir, config).blocked).toEqual([]);
  });
});

describe("수집 계획: PRD 등록 뒤", () => {
  it("본문의 Figma 링크는 (파일, 노드)마다 메타데이터 항목이 되고 ref 는 <파일 키>:<a>-<b>", () => {
    const dir = withPrd();
    const plan = computePlan(dir, config);
    const meta = plan.items.find((i) => i.register.kind === "figma_meta");
    expect(meta).toMatchObject({ id: `figma_meta:${FIGMA_KEY}:1-92`, register: { kind: "figma_meta", ref: `${FIGMA_KEY}:1-92`, node: "1:92" } });
    expect(meta?.tool_hint).toContain("get_metadata");
    expect(plan.items.find((i) => i.register.kind === "prd")).toBeUndefined();
  });

  it("같은 사이트의 다른 Confluence 페이지 링크가 관련 문서 항목이 되고 PRD 자신·다른 사이트는 뺀다", () => {
    const dir = withPrd();
    const related = computePlan(dir, config).items.filter((i) => i.register.kind === "related");
    expect(related.map((i) => i.register.ref)).toEqual(["456", "789"]);
  });

  it("관련 문서는 상한까지만 싣고 note 에 뺀 수를 적는다", () => {
    const dir = withPrd();
    const plan = computePlan(dir, { ...config, max_related: 1 });
    const related = plan.items.filter((i) => i.register.kind === "related");
    expect(related.map((i) => i.register.ref)).toEqual(["456"]);
    expect(related[0]?.note).toContain("1개를 뺐습니다");
    expect(plan.notes.join("\n")).toContain("관련 문서 2개 중");
  });

  it("이미 등록된 관련 문서는 다시 싣지 않는다", () => {
    const dir = withPrd();
    addSource({ runDir: dir, kind: "related", ref: "456", file: writeFixture(dir, "in/r.json", confluenceResponse("- 관련")) });
    expect(computePlan(dir, config).items.filter((i) => i.register.kind === "related").map((i) => i.register.ref)).toEqual(["789"]);
  });

  it("노드 지정 없는 Figma 링크는 skip 항목이고 가져올 항목 수에 들지 않는다", () => {
    const dir = withPrd(`https://www.figma.com/design/${FIGMA_KEY}/x\n`);
    const plan = computePlan(dir, config);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ skip: true, note: "노드 지정 없음", register: { kind: "figma_meta", ref: FIGMA_KEY } });
    expect(plan.remaining).toBe(0);
  });

  it("같은 파일에 노드 링크가 있으면 노드 없는 링크는 따로 싣지 않는다", () => {
    const links = figmaLinks(`https://www.figma.com/design/${FIGMA_KEY}/x\nhttps://www.figma.com/file/${FIGMA_KEY}/x?node-id=1%3A92 (https://www.figma.com/design/${FIGMA_KEY}/x?node-id=1-92)`);
    expect(links).toEqual([{ key: FIGMA_KEY }, { key: FIGMA_KEY, node: "1:92" }]);
    const dir = withPrd(`https://www.figma.com/design/${FIGMA_KEY}/x\nhttps://www.figma.com/design/${FIGMA_KEY}/x?node-id=1-92\n`);
    expect(computePlan(dir, config).items.filter((i) => i.register.kind === "figma_meta").map((i) => i.id)).toEqual([`figma_meta:${FIGMA_KEY}:1-92`]);
  });

  it("티켓 본문의 Figma 링크도 메타데이터 항목이 된다", () => {
    const { dir } = makeRun("init", { input: { kind: "ticket", url: "https://x.atlassian.net/browse/ABC-2" } });
    addSource({ runDir: dir, kind: "ticket", ref: "ABC-2", file: writeFixture(dir, "in/t.json", jiraResponse({ key: "ABC-2", description: `디자인 https://www.figma.com/board/${FIGMA_KEY}/b?node-id=7-8` })) });
    expect(ids(dir)).toEqual([`figma_meta:${FIGMA_KEY}:7-8`]);
  });
});

describe("수집 계획: figma_meta 등록 뒤 캡처 대상", () => {
  it("앱 프레임과 라벨 붙은 접두사 없는 프레임만 대상이고 웹·모웹·설명 카드·라벨 없는 프레임·웹처럼 보이는 이름은 뺀다", () => {
    const dir = withPrd();
    withMeta(dir);
    const shots = computePlan(dir, config).items.filter((i) => i.register.kind === "figma_shot");
    expect(shots.map((i) => i.register.node)).toEqual(["4:1", "4:2", "4:3"]);
    expect(shots[0]).toMatchObject({ id: `figma_shot:${FIGMA_KEY}:4-1`, register: { kind: "figma_shot", ref: FIGMA_KEY, node: "4:1", title: "앱/홈" } });
    expect(shots[0]?.tool_hint).toContain("get_screenshot");
    expect(shots[0]?.tool_hint).toContain("curl");
  });

  it("메타데이터가 등록되면 그 노드의 메타데이터 항목은 사라진다", () => {
    const dir = withPrd();
    withMeta(dir);
    expect(computePlan(dir, config).items.some((i) => i.register.kind === "figma_meta")).toBe(false);
  });

  it("이미 등록된 스크린샷 노드는 빠진다", () => {
    const dir = withPrd();
    withMeta(dir);
    addSource({ runDir: dir, kind: "figma_shot", ref: FIGMA_KEY, node: "4:1", file: writeFixture(dir, "in/s.png", "png") });
    expect(computePlan(dir, config).items.filter((i) => i.register.kind === "figma_shot").map((i) => i.register.node)).toEqual(["4:2", "4:3"]);
  });

  it("상한을 넘으면 앱 프레임 우선으로 자르고 note 에 남긴 수를 적는다", () => {
    const dir = withPrd();
    withMeta(dir);
    const plan = computePlan(dir, { ...config, max_shots: 2 });
    const shots = plan.items.filter((i) => i.register.kind === "figma_shot");
    expect(shots.map((i) => i.register.node)).toEqual(["4:1", "4:2"]);
    expect(shots[0]?.note).toContain("3개 중 상한(2)까지만");
    expect(shots[0]?.note).toContain("1개를 뺐습니다");
    expect(plan.notes.join("\n")).toContain("스크린샷 대상 3개");
  });

  it("상한은 이미 등록된 것까지 포함한 전체 대상에 적용돼 등록할수록 늘어나지 않는다", () => {
    const dir = withPrd();
    withMeta(dir);
    addSource({ runDir: dir, kind: "figma_shot", ref: FIGMA_KEY, node: "4:1", file: writeFixture(dir, "in/s.png", "png") });
    expect(computePlan(dir, { ...config, max_shots: 2 }).items.filter((i) => i.register.kind === "figma_shot").map((i) => i.register.node)).toEqual(["4:2"]);
  });

  it("파일 키를 알 수 없는 메타데이터는 막힘으로 알린다", () => {
    const { dir } = makeRun();
    addSource({ runDir: dir, kind: "figma_meta", ref: "1:92", node: "1:92", file: writeFixture(dir, "in/meta.json", META_JSON) });
    const plan = computePlan(dir, config);
    expect(plan.items.some((i) => i.register.kind === "figma_shot")).toBe(false);
    expect(plan.blocked.join("\n")).toContain("파일 키");
  });
});

describe("수집 계획: 실패 기록", () => {
  it("한 번 실패한 항목은 계획에 남고 두 번 실패하면 failed 목록으로 간다", () => {
    const dir = withPrd();
    const item = `related:456`;
    failSource({ runDir: dir, item, reason: "권한 없음" });
    let plan = computePlan(dir, config);
    expect(plan.items.some((i) => i.id === item)).toBe(true);
    expect(plan.failed).toEqual([]);
    const second = failSource({ runDir: dir, item, reason: "없는 문서" });
    expect(second).toMatchObject({ attempts: 2, dropped: true });
    plan = computePlan(dir, config);
    expect(plan.items.some((i) => i.id === item)).toBe(false);
    expect(plan.failed).toEqual([{ id: item, what: "관련 Confluence 문서 456", attempts: 2, reasons: ["권한 없음", "없는 문서"] }]);
  });

  it("실패로 빠진 관련 문서 자리는 상한 안에서 채워지지 않는다", () => {
    const dir = withPrd();
    failSource({ runDir: dir, item: "related:456", reason: "a" });
    failSource({ runDir: dir, item: "related:456", reason: "b" });
    expect(computePlan(dir, { ...config, max_related: 1 }).items.filter((i) => i.register.kind === "related")).toEqual([]);
  });

  it("계획에 없는 항목 id 는 사용법 오류(종료 2)", () => {
    const dir = withPrd();
    let code = -1;
    try {
      failSource({ runDir: dir, item: "related:000", reason: "x" });
    } catch (e) {
      code = e instanceof HewError ? e.exitCode : -1;
    }
    expect(code).toBe(2);
  });

  it("계산은 결정적이고 아무것도 바꾸지 않는다", () => {
    const dir = withPrd();
    const before = JSON.stringify(loadRun(dir));
    expect(computePlan(dir, config)).toEqual(computePlan(dir, config));
    expect(JSON.stringify(loadRun(dir))).toBe(before);
  });

  it("run.json 의 사례 정보가 바뀌면 계획이 따라 바뀐다", () => {
    const { dir, run } = makeRun();
    saveRun(dir, { ...run, case_info: { prd_version: "7", block: { jira_keys: [], pr_numbers: [], heka_ids: [] } } });
    expect(computePlan(dir, config).items[0]?.register.version).toBe("7");
  });
});

describe("hew source plan 명령", () => {
  it("--json 으로 계획을 한 줄로 낸다", () => {
    const { dir } = makeRun();
    const r = spawnSync(`${HEW_ROOT}/bin/hew`, ["--json", "source", "plan", "--run", dir], { env: { ...process.env, HEW_RUNS_DIR: runs.dir }, encoding: "utf8" });
    expect(r.status).toBe(0);
    const body = JSON.parse(r.stdout) as { ok: boolean; data: { items: { id: string }[]; remaining: number; blocked: string[] } };
    expect(body.ok).toBe(true);
    expect(body.data.items.map((i) => i.id)).toEqual(["prd:123"]);
    expect(body.data.remaining).toBe(1);
    expect(body.data.blocked.length).toBe(1);
  });
});
