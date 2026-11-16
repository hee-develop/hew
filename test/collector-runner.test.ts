import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HewError } from "../src/core/errors.js";
import { readEvents } from "../src/core/events.js";
import { initRun } from "../src/core/init.js";
import { loadManifest } from "../src/core/manifest.js";
import { HEW_ROOT, runPaths } from "../src/core/paths.js";
import { loadRun } from "../src/core/run.js";
import { runLoop } from "../src/core/runner.js";
import { META_JSON, PRD_BODY, confluenceResponse, seedCalls } from "./collect-fixtures.js";
import { PRD_URL, useTempRunsDir } from "./helpers.js";
import { makeFakeClaude, readCalls, tempDir } from "./runner-helpers.js";
import { makeGitRepo } from "./git-helpers.js";

const runs = useTempRunsDir();
const fakeClaude = makeFakeClaude();

function fakeEnv(mode: string, extra: Record<string, string> = {}): { env: NodeJS.ProcessEnv; log: string } {
  const log = tempDir("hew-fake-log-");
  return {
    log,
    env: { ...process.env, HEW_RUNS_DIR: runs.dir, HEW_CLAUDE_BIN: fakeClaude, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log, ...extra },
  };
}

const CALLS = JSON.stringify({ prd: 1, figma_meta: 2, related: 3 });

/** init 한 실행에 수집 작업 폴더를 미리 만들고 받아 적은 호출(PRD, 메타데이터, 관련 문서)을 심는다. */
function setup(runId: string, init: Partial<Parameters<typeof initRun>[0]> = {}): string {
  const repo = makeGitRepo();
  const { dir } = initRun({ prd: PRD_URL, repo: repo.dir, runId, ...init });
  seedCalls(dir, [
    { tool: "mcp__claude_ai_Atlassian__getConfluencePage", payload: confluenceResponse(PRD_BODY, { version: { number: 22 } }) },
    { tool: "mcp__claude_ai_Figma__get_metadata", payload: META_JSON, from_file: true },
    { tool: "mcp__claude_ai_Atlassian__getConfluencePage", payload: confluenceResponse("- 관련 문서 본문\n", { title: "관련" }) },
  ]);
  return dir;
}

describe("실행기: init 에서 collector 를 띄워 collected 까지", () => {
  it("가짜 수집이 계획대로 등록하고 done 을 불러 collected 가 된다", async () => {
    const dir = setup("c1");
    const { env, log } = fakeEnv("collect", { FAKE_CLAUDE_CALLS: CALLS });
    const result = await runLoop({ runDir: dir, until: "collected", env });
    expect(result).toMatchObject({ outcome: "until_reached", state: "collected", launches: 1 });
    const manifest = loadManifest(dir).sources;
    const count = (kind: string): number => manifest.filter((s) => s.kind === kind).length;
    expect(count("code")).toBe(1);
    expect(count("prd")).toBe(1);
    expect(count("figma_meta")).toBe(1);
    expect(count("figma_shot")).toBe(3);
    expect(count("related")).toBe(2);
    expect(manifest.find((s) => s.kind === "prd")).toMatchObject({ version: "22", title: "합성 PRD", meta: { call: 1 } });
    expect(manifest.find((s) => s.kind === "figma_meta")?.meta).toMatchObject({ call: 2, node: "1:92" });
    expect(loadRun(dir).state).toBe("collected");
    expect(readEvents(runPaths(dir).events).some((e) => e.type === "sources_done")).toBe(true);
    expect(readCalls(log)).toHaveLength(1);
    const costs = readFileSync(runPaths(dir).costs, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(costs[0]).toMatchObject({ role: "collector", purpose: "first", model: "claude-sonnet-5-5", effort: "medium", attempt: 1 });
    expect(existsSync(runPaths(dir).units)).toBe(true);
  });

  it("인자: 사용자 설정을 막는 플래그가 없고 --allowedTools 에 ToolSearch 와 MCP 읽기 도구가 있다", async () => {
    const dir = setup("c2");
    const { env, log } = fakeEnv("collect", { FAKE_CLAUDE_CALLS: CALLS });
    await runLoop({ runDir: dir, until: "collected", env });
    const argv = readCalls(log)[0]?.argv ?? [];
    for (const flag of ["--setting-sources", "--strict-mcp-config", "--mcp-config"]) expect(argv).not.toContain(flag);
    const flag = (name: string): string | undefined => argv[argv.indexOf(name) + 1];
    expect(flag("--agent")).toBe("hew:collector");
    expect(flag("--permission-mode")).toBe("dontAsk");
    expect(flag("--model")).toBe("claude-sonnet-5-5");
    expect(flag("--effort")).toBe("medium");
    const allowed = (flag("--allowedTools") ?? "").split(",");
    expect(allowed).toContain("ToolSearch");
    expect(allowed).toContain("mcp__claude_ai_Atlassian__getConfluencePage");
    expect(allowed).toContain("mcp__claude_ai_Figma__get_screenshot");
    expect(allowed.some((n) => /createConfluencePage|slack/.test(n))).toBe(false);
    expect(flag("--settings")).toBe(join(runPaths(dir).work, "collector-1", "settings.json"));
  });

  it("설정 파일에 PreToolUse(guard, ToolSearch 포함) 와 PostToolUse(record, mcp__.*) 가 함께 들어간다", async () => {
    const dir = setup("c3");
    const { env } = fakeEnv("collect", { FAKE_CLAUDE_CALLS: CALLS });
    await runLoop({ runDir: dir, until: "collected", env });
    const settings = JSON.parse(readFileSync(join(runPaths(dir).work, "collector-1", "settings.json"), "utf8")) as any;
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher.split("|")).toContain("ToolSearch");
    expect(settings.hooks.PreToolUse[0].matcher.split("|")).toContain("mcp__.*");
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain(join(HEW_ROOT, "hooks", "guard.mjs"));
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolUse[0].matcher).toBe("mcp__.*");
    expect(settings.hooks.PostToolUse[0].hooks[0]).toMatchObject({ type: "command" });
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain(join(HEW_ROOT, "hooks", "record.mjs"));
  });

  it("환경 변수: 받아 적을 폴더, 수집 프로필, 모드, 차단 목록, MCP 허용 목록, curl 호스트와 읽기·쓰기 뿌리", async () => {
    const dir = setup("c4");
    const { env, log } = fakeEnv("collect", { FAKE_CLAUDE_CALLS: CALLS });
    await runLoop({ runDir: dir, until: "collected", env });
    const e = readCalls(log)[0]?.env ?? {};
    const work = join(runPaths(dir).work, "collector-1");
    expect(e.HEW_RECORD_DIR).toBe(join(work, "calls"));
    expect(e.HEW_GUARD_PROFILE).toBe("collector");
    expect(e.HEW_GUARD_MODE).toBe("live");
    expect(JSON.parse(e.HEW_GUARD_BLOCK ?? "{}")).toEqual({ jira_keys: [], pr_numbers: [] });
    expect((e.HEW_GUARD_MCP_ALLOW ?? "").split(",")).toContain("mcp__figma__get_metadata");
    expect(e.HEW_GUARD_CURL_HOSTS).toBe("figma.com,figma-alpha-api.s3.us-west-2.amazonaws.com,s3-alpha-sig.figma.com,amazonaws.com");
    expect(e.HEW_GUARD_READ_ROOTS).toBe([dir, join(HEW_ROOT, "refs")].join(":"));
    expect(e.HEW_GUARD_WRITE_ROOTS).toBe(work);
    expect(e.HEW_GUARD_RUN_DIR).toBe(dir);
  });

  it("replay: 모드와 사례의 차단 목록이 환경 변수로 간다", async () => {
    const caseFile = join(tempDir("hew-case-"), "case.yaml");
    writeFileSync(caseFile, "story: APP-1\nprd: { version: 5 }\nblock:\n  jira: [APP-3094]\n  prs: [1054]\n");
    const dir = setup("c5", { mode: "replay", case: caseFile });
    const { env, log } = fakeEnv("collect", { FAKE_CLAUDE_CALLS: CALLS });
    await runLoop({ runDir: dir, until: "collected", env });
    const e = readCalls(log)[0]?.env ?? {};
    expect(e.HEW_GUARD_MODE).toBe("replay");
    expect(JSON.parse(e.HEW_GUARD_BLOCK ?? "{}")).toEqual({ jira_keys: ["APP-3094"], pr_numbers: [1054] });
    expect(loadManifest(dir).sources.find((s) => s.kind === "prd")?.version).toBe("5");
  });

  it("패킷에 수집 계획 표와 명령, 읽기 도구, 차단 목록이 실린다", async () => {
    const dir = setup("c6");
    const { env } = fakeEnv("collect", { FAKE_CLAUDE_CALLS: CALLS });
    await runLoop({ runDir: dir, until: "collected", env });
    const packet = readFileSync(join(runPaths(dir).packets, "collector-1.md"), "utf8");
    expect(packet).toContain("| prd:123 |");
    expect(packet).toContain("source add --run");
    expect(packet).toContain("--from-call <번호>");
    expect(packet).toContain("getConfluenceContentVersion");
    expect(packet).toContain("example.atlassian.net");
    expect(packet).toContain("curl -sS -L -f --max-time 60 -o");
    expect(existsSync(join(runPaths(dir).work, "collector-1", "shots"))).toBe(true);
  });

  it("가짜가 못 가져온 선택 항목은 두 번 실패로 남기고 경고와 함께 collected 가 된다", async () => {
    const dir = setup("c7");
    const { env } = fakeEnv("collect", { FAKE_CLAUDE_CALLS: JSON.stringify({ prd: 1, figma_meta: 2 }) });
    const result = await runLoop({ runDir: dir, until: "collected", env });
    expect(result.state).toBe("collected");
    expect(loadRun(dir).collect_warnings?.map((w) => w.item)).toEqual(["related:456", "related:789"]);
    expect(readFileSync(runPaths(dir).failures, "utf8").trim().split("\n")).toHaveLength(4);
  });

  it("아무것도 등록하지 않으면 3회 시도 뒤 종료 5 이고 상태는 init", async () => {
    const dir = setup("c8");
    const { env, log } = fakeEnv("noop");
    const error = await runLoop({ runDir: dir, env }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HewError);
    expect((error as HewError).exitCode).toBe(5);
    expect(readCalls(log)).toHaveLength(3);
    expect(loadRun(dir).state).toBe("init");
    expect(readdirSync(runPaths(dir).packets).sort()).toEqual(["collector-1.md", "collector-2.md", "collector-3.md"]);
  });

  it("--dry 는 collector 를 띄울 명령과 환경 변수를 돌려준다", async () => {
    const dir = setup("c9");
    const { env, log } = fakeEnv("collect");
    const result = await runLoop({ runDir: dir, dry: true, env });
    expect(result.outcome).toBe("dry");
    expect(result.dry?.args).toContain("hew:collector");
    expect(result.dry?.env.HEW_GUARD_PROFILE).toBe("collector");
    expect(existsSync(log) ? readdirSync(log) : []).toEqual([]);
  });
});

describe("hew run --until collected (자식 프로세스)", () => {
  it("hew init --repo → 가짜 claude 가 수집 → 종료 0, 상태 collected", () => {
    const repo = makeGitRepo();
    const { env } = fakeEnv("collect", { FAKE_CLAUDE_CALLS: CALLS });
    const hew = (args: string[]) => spawnSync(join(HEW_ROOT, "bin", "hew"), ["--json", ...args], { env, encoding: "utf8" });
    const init = hew(["init", "--prd", PRD_URL, "--repo", repo.dir, "--run-id", "cli-1"]);
    expect(init.status).toBe(0);
    const dir = join(runs.dir, "cli-1");
    seedCalls(dir, [
      { tool: "mcp__claude_ai_Atlassian__getConfluencePage", payload: confluenceResponse(PRD_BODY) },
      { tool: "mcp__claude_ai_Figma__get_metadata", payload: META_JSON },
      { tool: "mcp__claude_ai_Atlassian__getConfluencePage", payload: confluenceResponse("- 관련\n") },
    ]);
    const r = hew(["run", "--run", dir, "--until", "collected"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, data: { outcome: "until_reached", state: "collected" } });
    expect(JSON.parse(hew(["status", "--run", dir]).stdout).data.state).toBe("collected");
  }, 60000);
});
