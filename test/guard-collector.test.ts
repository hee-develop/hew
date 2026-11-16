import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decide } from "../hooks/guard.mjs";
import { loadCollectConfig } from "../src/core/collect/config.js";

let base = "";
let run = "";
let work = "";
let hew = "";
let env: Record<string, string>;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "hew-guard-collector-"));
  run = join(base, "run");
  work = join(run, "work", "collector-1");
  hew = join(base, "bin", "hew");
  for (const d of [join(run, "sources"), join(work, "shots"), join(base, "bin")]) mkdirSync(d, { recursive: true });
  writeFileSync(hew, "#!/bin/sh\n");
  env = {
    HEW_GUARD_READ_ROOTS: [run].join(":"),
    HEW_GUARD_WRITE_ROOTS: work,
    HEW_GUARD_RUN_DIR: run,
    HEW_GUARD_HEW_BIN: hew,
    HEW_GUARD_PROFILE: "collector",
    HEW_GUARD_MODE: "live",
  };
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const verdict = (payload: unknown, extra: Record<string, string | undefined> = {}): "allow" | "deny" => {
  const merged: Record<string, string | undefined> = { ...env, ...extra };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  return decide(payload, merged).decision;
};

const mcp = (name: string, input: unknown = {}): unknown => ({ tool_name: name, tool_input: input, cwd: run });
const bash = (command: string): unknown => ({ tool_name: "Bash", tool_input: { command }, cwd: run });
const H = (): string => hew;
const curl = (rest: string): unknown => bash(`curl ${rest}`);
const OUT = (): string => join(work, "shots", "12-34.png");
const FIGMA_URL = "https://www.figma.com/api/mcp/asset/abc-123";

const BLOCK = JSON.stringify({ jira_keys: ["APP-3094", "QA-5581"], pr_numbers: [1054] });
const noProfile = { HEW_GUARD_PROFILE: undefined };

type Case = [name: string, payload: () => unknown, allow: boolean, extra?: Record<string, string | undefined>];

const cases: Case[] = [
  // ToolSearch
  ["ToolSearch: 수집 프로필에서 허용", () => mcp("ToolSearch", { query: "select:mcp__claude_ai_Figma__get_metadata" }), true],
  ["ToolSearch: 프로필이 없으면 거부", () => mcp("ToolSearch", { query: "x" }), false, noProfile],
  ["ToolSearch: 다른 프로필 값이면 거부", () => mcp("ToolSearch", { query: "x" }), false, { HEW_GUARD_PROFILE: "other" }],

  // MCP 허용 목록(기본)
  ["MCP: Confluence 쓰기 도구는 목록에 없어 거부", () => mcp("mcp__claude_ai_Atlassian__createConfluencePage", { title: "x" }), false],
  ["MCP: Rovo 서버의 같은 이름 도구는 목록에 없어 거부", () => mcp("mcp__claude_ai_Atlassian_Rovo__getConfluencePage", { pageId: "1" }), false],
  ["MCP: JQL 검색 도구는 거부", () => mcp("mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql", { jql: "project = X" }), false],
  ["MCP: Jira 쓰기 도구는 거부", () => mcp("mcp__claude_ai_Atlassian__editJiraIssue", { issueIdOrKey: "A-1" }), false],
  ["MCP: Slack 도구는 거부", () => mcp("mcp__claude_ai_Slack__slack_send_message", { text: "x" }), false],
  ["MCP: heka 도구는 거부", () => mcp("mcp__heka__heka_search", { q: "x" }), false],
  ["MCP: Figma get_design_context 는 목록에 없어 거부", () => mcp("mcp__claude_ai_Figma__get_design_context", { nodeId: "1:2" }), false],
  ["MCP: 이름 끝에 더 붙으면 전체 일치가 아니라 거부", () => mcp("mcp__claude_ai_Figma__get_metadata_extra"), false],
  ["MCP: 이름 앞에 더 붙으면 거부", () => mcp("xmcp__figma__whoami"), false],
  ["MCP: 접두사만 같은 도구는 거부", () => mcp("mcp__claude_ai_Atlassian__getConfluencePageDescendants", { pageId: "1" }), false],
  ["MCP: 수집 프로필이 아니면 허용 목록의 도구도 거부", () => mcp("mcp__claude_ai_Atlassian__getConfluencePage", { pageId: "1" }), false, noProfile],
  ["MCP: 수집 프로필이 아니면 Figma 읽기 도구도 거부", () => mcp("mcp__claude_ai_Figma__get_metadata", { nodeId: "1:2" }), false, noProfile],

  // MCP 허용 목록(환경 변수)
  ["MCP 목록 환경 변수: 정규식 항목에 전체 일치하면 허용", () => mcp("mcp__figma__get_design_context"), true, { HEW_GUARD_MCP_ALLOW: "mcp__figma__.*" }],
  ["MCP 목록 환경 변수: 목록에 없으면 기본 목록의 도구도 거부", () => mcp("mcp__claude_ai_Atlassian__getConfluencePage"), false, { HEW_GUARD_MCP_ALLOW: "mcp__figma__.*" }],
  ["MCP 목록 환경 변수: 쉼표로 여러 항목", () => mcp("mcp__a__two"), true, { HEW_GUARD_MCP_ALLOW: "mcp__a__one, mcp__a__two" }],
  ["MCP 목록 환경 변수: 잘못된 정규식은 건너뛴다", () => mcp("mcp__a__one"), true, { HEW_GUARD_MCP_ALLOW: "([, mcp__a__one" }],
  ["MCP 목록 환경 변수: 부분 일치는 거부", () => mcp("mcp__a__one_more"), false, { HEW_GUARD_MCP_ALLOW: "mcp__a__one" }],

  // 차단 목록
  ["차단: 입력에 차단된 Jira 키가 있으면 거부", () => mcp("mcp__claude_ai_Atlassian__getJiraIssue", { issueIdOrKey: "APP-3094" }), false, { HEW_GUARD_BLOCK: BLOCK }],
  ["차단: 다른 키는 허용", () => mcp("mcp__claude_ai_Atlassian__getJiraIssue", { issueIdOrKey: "APP-3008" }), true, { HEW_GUARD_BLOCK: BLOCK }],
  ["차단: 숫자가 더 이어지는 키(APP-30940)는 단어 경계가 아니라 허용", () => mcp("mcp__claude_ai_Atlassian__getJiraIssue", { issueIdOrKey: "APP-30940" }), true, { HEW_GUARD_BLOCK: BLOCK }],
  ["차단: 앞에 글자가 붙은 키(XAPP-3094)는 허용", () => mcp("mcp__claude_ai_Atlassian__getJiraIssue", { issueIdOrKey: "XAPP-3094" }), true, { HEW_GUARD_BLOCK: BLOCK }],
  ["차단: 문장 속의 키도 거부", () => mcp("mcp__claude_ai_Atlassian__getJiraIssue", { issueIdOrKey: "key = APP-3094 order by created" }), false, { HEW_GUARD_BLOCK: BLOCK }],
  ["차단: 중첩 입력 안의 키도 거부", () => mcp("mcp__claude_ai_Atlassian__executeRead", { name: "x", inputs: { list: [{ k: "QA-5581" }] } }), false, { HEW_GUARD_BLOCK: BLOCK }],
  ["차단: 줄바꿈 바로 뒤의 키도 거부", () => mcp("mcp__claude_ai_Atlassian__getJiraIssue", { issueIdOrKey: "첫줄\nAPP-3094" }), false, { HEW_GUARD_BLOCK: BLOCK }],
  ["차단: 소문자 키도 거부", () => mcp("mcp__claude_ai_Atlassian__getJiraIssue", { issueIdOrKey: "app-3094" }), false, { HEW_GUARD_BLOCK: BLOCK }],
  ["차단: 키 이름(속성 이름)에 있어도 거부", () => mcp("mcp__claude_ai_Atlassian__executeRead", { name: "x", inputs: { "APP-3094": 1 } }), false, { HEW_GUARD_BLOCK: BLOCK }],
  ["차단: Figma 도구 입력에도 적용", () => mcp("mcp__claude_ai_Figma__get_metadata", { nodeId: "1:2", note: "APP-3094" }), false, { HEW_GUARD_BLOCK: BLOCK }],
  ["차단: 목록이 비어 있으면 허용", () => mcp("mcp__claude_ai_Atlassian__getJiraIssue", { issueIdOrKey: "APP-3094" }), true, { HEW_GUARD_BLOCK: JSON.stringify({ jira_keys: [], pr_numbers: [] }) }],
  ["차단: 환경 변수가 없으면 허용", () => mcp("mcp__claude_ai_Atlassian__getJiraIssue", { issueIdOrKey: "APP-3094" }), true],
  ["차단: 환경 변수를 읽을 수 없으면 거부", () => mcp("mcp__claude_ai_Atlassian__getJiraIssue", { issueIdOrKey: "APP-1" }), false, { HEW_GUARD_BLOCK: "{깨짐" }],

  // replay·shadow 의 검색 금지
  ["replay: executeRead 의 getConfluenceContentVersion 은 허용", () => mcp("mcp__claude_ai_Atlassian__executeRead", { name: "getConfluenceContentVersion", cloudId: "c", inputs: { contentId: "1", versionNumber: 22, content_format: "markdown" } }), true, { HEW_GUARD_MODE: "replay" }],
  ["replay: executeRead 의 listConfluenceContentVersions 은 허용", () => mcp("mcp__claude_ai_Atlassian__executeRead", { name: "listConfluenceContentVersions", inputs: { contentId: "1" } }), true, { HEW_GUARD_MODE: "replay" }],
  ["replay: executeRead 의 getConfluencePage 는 허용", () => mcp("mcp__claude_ai_Atlassian__executeRead", { name: "getConfluencePage", inputs: { pageId: "1" } }), true, { HEW_GUARD_MODE: "replay" }],
  ["replay: executeRead 의 CQL 검색 연산은 거부", () => mcp("mcp__claude_ai_Atlassian__executeRead", { name: "searchConfluenceUsingCql", inputs: { cql: "text ~ x" } }), false, { HEW_GUARD_MODE: "replay" }],
  ["replay: 허용 연산이어도 입력에 jql 이 있으면 거부", () => mcp("mcp__claude_ai_Atlassian__executeRead", { name: "getJiraIssue", inputs: { jql: "parent = X" } }), false, { HEW_GUARD_MODE: "replay" }],
  ["replay: 입력 깊은 곳의 cql 도 거부", () => mcp("mcp__plugin_atlassian_atlassian__executeRead", { name: "getConfluencePage", inputs: { extra: [{ CQL: "x" }] } }), false, { HEW_GUARD_MODE: "replay" }],
  ["replay: 연산 이름이 없으면 거부", () => mcp("mcp__claude_ai_Atlassian__executeRead", { inputs: {} }), false, { HEW_GUARD_MODE: "replay" }],
  ["shadow: 검색 연산은 거부", () => mcp("mcp__claude_ai_Atlassian__executeRead", { name: "searchJiraIssuesUsingJql", inputs: { jql: "x" } }), false, { HEW_GUARD_MODE: "shadow" }],
  ["shadow: 지정 버전 조회는 허용", () => mcp("mcp__claude_ai_Atlassian__executeRead", { name: "getConfluenceContentVersion", inputs: { contentId: "1" } }), true, { HEW_GUARD_MODE: "shadow" }],
  ["live: executeRead 는 연산 이름을 따지지 않는다", () => mcp("mcp__claude_ai_Atlassian__executeRead", { name: "searchConfluenceUsingCql", inputs: { cql: "x" } }), true, { HEW_GUARD_MODE: "live" }],
  ["replay: executeRead 가 아닌 읽기 도구(getConfluencePage)는 허용", () => mcp("mcp__claude_ai_Atlassian__getConfluencePage", { pageId: "1", contentFormat: "markdown" }), true, { HEW_GUARD_MODE: "replay" }],
  ["replay: discover 는 허용", () => mcp("mcp__claude_ai_Atlassian__discover", { goal: "페이지 버전 조회" }), true, { HEW_GUARD_MODE: "replay" }],

  // curl 허용 형식
  ["curl: 고정 형식(-sS -L -o 경로 주소)", () => curl(`-sS -L -o ${OUT()} "${FIGMA_URL}"`), true],
  ["curl: -f 와 --max-time 을 함께", () => curl(`-sS -L -f --max-time 60 -o ${OUT()} "${FIGMA_URL}"`), true],
  ["curl: 짧은 옵션 묶음(-sSLf)", () => curl(`-sSLf -o ${OUT()} "${FIGMA_URL}"`), true],
  ["curl: 상대 경로 출력(작업 폴더 안)", () => bash(`cd ${work} && curl -sS -L -o shots/a.png "${FIGMA_URL}"`), true],
  ["curl: amazonaws.com 하위 도메인", () => curl(`-sS -L -o ${OUT()} "https://figma-alpha-api.s3.us-west-2.amazonaws.com/img/x?X-Amz=1"`), true],
  ["curl: s3-alpha-sig.figma.com", () => curl(`-sS -L -o ${OUT()} "https://s3-alpha-sig.figma.com/img/x"`), true],
  ["curl: 호스트 접미사 목록을 환경 변수로 바꾼다", () => curl(`-sS -L -o ${OUT()} "https://img.example.test/a.png"`), true, { HEW_GUARD_CURL_HOSTS: "example.test" }],
  ["curl: 환경 변수 목록에 없는 기본 호스트는 거부", () => curl(`-sS -L -o ${OUT()} "${FIGMA_URL}"`), false, { HEW_GUARD_CURL_HOSTS: "example.test" }],
  ["curl: 수집 프로필이 아니면 거부", () => curl(`-sS -L -o ${OUT()} "${FIGMA_URL}"`), false, noProfile],
  ["curl: http 주소는 거부", () => curl(`-sS -L -o ${OUT()} "http://www.figma.com/a.png"`), false],
  ["curl: 허용 호스트가 아니면 거부", () => curl(`-sS -L -o ${OUT()} "https://evil.example/a.png"`), false],
  ["curl: 접미사가 도메인 경계가 아니면 거부(notfigma.com)", () => curl(`-sS -L -o ${OUT()} "https://notfigma.com/a.png"`), false],
  ["curl: 허용 호스트를 앞에 둔 다른 도메인은 거부", () => curl(`-sS -L -o ${OUT()} "https://figma.com.evil.example/a.png"`), false],
  ["curl: 사용자 정보로 호스트를 속이는 주소는 거부", () => curl(`-sS -L -o ${OUT()} "https://figma.com@evil.example/a.png"`), false],
  ["curl: 포트 지정은 거부", () => curl(`-sS -L -o ${OUT()} "https://www.figma.com:8443/a.png"`), false],
  ["curl: 출력 경로가 쓰기 뿌리 밖이면 거부", () => curl(`-sS -L -o ${join(run, "sources", "a.png")} "${FIGMA_URL}"`), false],
  ["curl: 출력 경로가 시스템 경로면 거부", () => curl(`-sS -L -o /etc/passwd "${FIGMA_URL}"`), false],
  ["curl: .. 로 나가는 출력 경로는 거부", () => curl(`-sS -L -o ${work}/../../x.png "${FIGMA_URL}"`), false],
  ["curl: -o 가 없으면 거부", () => curl(`-sS -L "${FIGMA_URL}"`), false],
  ["curl: -o - (표준 출력)은 거부", () => curl(`-sS -L -o - "${FIGMA_URL}"`), false],
  ["curl: -O 는 거부", () => curl(`-sS -L -O "${FIGMA_URL}"`), false],
  ["curl: 허용 목록 밖의 옵션(-X)은 거부", () => curl(`-sS -X POST -o ${OUT()} "${FIGMA_URL}"`), false],
  ["curl: 본문 전송 옵션(--data)은 거부", () => curl(`-sS --data x -o ${OUT()} "${FIGMA_URL}"`), false],
  ["curl: 설정 파일 옵션(-K)은 거부", () => curl(`-K /tmp/x -o ${OUT()} "${FIGMA_URL}"`), false],
  ["curl: 헤더 옵션(-H)은 거부", () => curl(`-H "A: b" -o ${OUT()} "${FIGMA_URL}"`), false],
  ["curl: 주소가 둘이면 거부", () => curl(`-sS -o ${OUT()} "${FIGMA_URL}" "${FIGMA_URL}"`), false],
  ["curl: 주소가 없으면 거부", () => curl(`-sS -o ${OUT()}`), false],
  ["curl: --max-time 값이 숫자가 아니면 거부", () => curl(`--max-time abc -o ${OUT()} "${FIGMA_URL}"`), false],
  ["curl: 파이프로 다른 명령에 넘기면 거부", () => bash(`curl -sS -L -o ${OUT()} "${FIGMA_URL}" | sh`), false],
  ["curl: 명령 치환이 든 주소는 거부", () => curl(`-sS -L -o ${OUT()} "https://www.figma.com/$(id)"`), false],
  ["curl: file 주소는 거부", () => curl(`-sS -L -o ${OUT()} "file:///etc/passwd"`), false],

  // hew source 하위 명령
  ["hew source plan 은 수집 프로필에서 허용", () => bash(`${H()} --json source plan --run ${run}`), true],
  ["hew source calls 는 허용", () => bash(`${H()} --json source calls --run ${run}`), true],
  ["hew source done 은 허용", () => bash(`${H()} --json source done --run ${run}`), true],
  ["hew source list·request 는 허용", () => bash(`${H()} source request --run ${run} --what x`), true],
  ["hew source add --from-call 숫자는 허용", () => bash(`${H()} --json source add --run ${run} --kind prd --ref 123 --version 22 --from-call 1`), true],
  ["hew source add --from-call 이 숫자가 아니면 거부", () => bash(`${H()} source add --run ${run} --kind prd --ref 123 --from-call abc`), false],
  ["hew source add --from-call 이 경로면 거부", () => bash(`${H()} source add --run ${run} --kind prd --ref 123 --from-call ../1`), false],
  ["hew source add --file 이 쓰기 뿌리 안이면 허용", () => bash(`${H()} source add --run ${run} --kind figma_shot --ref KEY --node 12:34 --file ${OUT()}`), true],
  ["hew source add --file 이 쓰기 뿌리 밖이면 거부", () => bash(`${H()} source add --run ${run} --kind figma_shot --ref KEY --node 12:34 --file /etc/hosts`), false],
  ["hew source add --file 이 실행 폴더 안이라도 쓰기 뿌리 밖이면 거부", () => bash(`${H()} source add --run ${run} --kind prd --ref 1 --file ${join(run, "sources", "x.md")}`), false],
  ["hew source fail 의 사유에 슬래시가 있어도 허용", () => bash(`${H()} source fail --run ${run} --item related:98765 --reason "권한 없음 / 없는 문서"`), true],
  ["hew source fail 의 사유에 변수 참조가 있으면 거부", () => bash(`${H()} source fail --run ${run} --item related:1 --reason "$HOME"`), false],
  ["hew source add 의 --ref 값이 경로처럼 보여도 글로 본다", () => bash(`${H()} source add --run ${run} --kind related --ref KEY:12-34 --from-call 2`), true],
  ["hew source 의 모르는 하위 명령은 거부", () => bash(`${H()} source units --run ${run}`), false],
  ["hew source 의 --run 이 다른 폴더면 거부", () => bash(`${H()} source plan --run ${base}`), false],
  ["수집 프로필이 아니면 hew source plan 은 거부", () => bash(`${H()} source plan --run ${run}`), false, noProfile],
  ["수집 프로필이 아니면 hew source add 는 거부", () => bash(`${H()} source add --run ${run} --kind prd --ref 1 --from-call 1`), false, noProfile],
  ["수집 프로필이 아니면 hew source done 은 거부", () => bash(`${H()} source done --run ${run}`), false, noProfile],
  ["수집 프로필이 아니면 hew source list 만 허용(기존 규칙)", () => bash(`${H()} source list --run ${run}`), true, noProfile],
  ["hew source fail 은 수집 프로필이 아니면 거부", () => bash(`${H()} source fail --run ${run} --item a --reason b`), false, noProfile],

  // 그 밖의 규칙은 기존과 같다
  ["Read: 읽기 뿌리 안은 허용", () => ({ tool_name: "Read", tool_input: { file_path: join(run, "sources") }, cwd: run }), true],
  ["Read: 읽기 뿌리 밖은 거부", () => ({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" }, cwd: run }), false],
  ["Write: 쓰기 뿌리 밖은 거부", () => ({ tool_name: "Write", tool_input: { file_path: join(run, "x.md") }, cwd: run }), false],
  ["WebFetch 는 수집 프로필에서도 거부", () => ({ tool_name: "WebFetch", tool_input: { url: "https://www.figma.com" }, cwd: run }), false],
  ["Task 는 수집 프로필에서도 거부", () => ({ tool_name: "Task", tool_input: {}, cwd: run }), false],
  ["Bash: wget 은 수집 프로필에서도 거부", () => bash(`wget -O ${OUT()} "${FIGMA_URL}"`), false],
  ["Bash: 읽기 명령은 허용", () => bash(`ls ${run}`), true],
];

describe("수집 프로필 판정표", () => {
  it("케이스가 40건 이상이다", () => expect(cases.length).toBeGreaterThanOrEqual(40));
  for (const [name, payload, allow, extra] of cases) {
    it(name, () => {
      expect(verdict(payload(), extra)).toBe(allow ? "allow" : "deny");
    });
  }
});

describe("수집 프로필: 기본 MCP 허용 목록", () => {
  const defaults = [
    "mcp__claude_ai_Atlassian__getConfluencePage",
    "mcp__claude_ai_Atlassian__getJiraIssue",
    "mcp__claude_ai_Atlassian__executeRead",
    "mcp__claude_ai_Atlassian__discover",
    "mcp__claude_ai_Atlassian__getAccessibleAtlassianResources",
    "mcp__claude_ai_Figma__get_metadata",
    "mcp__claude_ai_Figma__get_screenshot",
    "mcp__claude_ai_Figma__whoami",
    "mcp__plugin_atlassian_atlassian__getConfluencePage",
    "mcp__plugin_atlassian_atlassian__getJiraIssue",
    "mcp__plugin_atlassian_atlassian__executeRead",
    "mcp__plugin_atlassian_atlassian__discover",
    "mcp__plugin_atlassian_atlassian__getAccessibleAtlassianResources",
    "mcp__figma__get_metadata",
    "mcp__figma__get_screenshot",
    "mcp__figma__whoami",
    "mcp__figma-desktop__get_metadata",
    "mcp__figma-desktop__get_screenshot",
    "mcp__figma-desktop__whoami",
  ];

  it.each(defaults)("%s 는 허용", (name) => {
    expect(verdict(mcp(name, { pageId: "1" }))).toBe("allow");
    expect(verdict(mcp(name, { pageId: "1" }), noProfile)).toBe("deny");
  });

  it("rules/collect.yaml 의 mcp_allow 와 같다(실행기가 이 목록을 환경 변수로 넘긴다)", () => {
    expect(loadCollectConfig().mcp_allow).toEqual(defaults);
  });

  it("rules/collect.yaml 의 목록을 환경 변수로 넘겨도 같은 판정이다", () => {
    const list = loadCollectConfig().mcp_allow.join(",");
    expect(verdict(mcp("mcp__figma__get_metadata"), { HEW_GUARD_MCP_ALLOW: list })).toBe("allow");
    expect(verdict(mcp("mcp__figma__get_design_context"), { HEW_GUARD_MCP_ALLOW: list })).toBe("deny");
  });
});
