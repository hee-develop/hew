import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCase } from "../src/core/case.js";
import { HewError } from "../src/core/errors.js";
import { initRun } from "../src/core/init.js";
import { loadManifest } from "../src/core/manifest.js";
import { loadRun } from "../src/core/run.js";
import { makeGitRepo } from "./git-helpers.js";
import { PRD_URL, useTempRunsDir } from "./helpers.js";

useTempRunsDir();

const NEW_FORMAT = `
id: app-3008
story: APP-3008
known_at: 2026-09-10
prd: { page_id: "1000000001", version: 22 }
figma: { url: "https://www.figma.com/design/x", note: "현재본만" }
repo: { path: "~/Projects/app", base: "0123456789abcdef0123456789abcdef01234567" }
block:
  jira: ["parent = APP-3008", "APP-3094", "APP-3096"]
  prs: [1054, 1081]
  heka_scope: ["ticket/APP-3008"]
  heka_ids: ["note-a", "note-b"]
answers: ./app-3008.answers.yaml
role: dev
`;

const OLD_FORMAT = `
case: app-3008
story_key: APP-3008
prd_url: https://x.atlassian.net/wiki/pages/viewpage.action?pageId=1000000001
prd_version: 22
base_sha: c0ac96e20edff311ea897ff9bcb8cc8b7a4dc4dd
known_at: 2026-09-10
blocked:
  jira_keys:
    - APP-3094
    - QA-5581
  pr_numbers: [1054, 1081]
  branches:
    - epic/APP-3008-x
`;

const tmpFile = (name: string, text: string): string => {
  const file = join(mkdtempSync(join(tmpdir(), "hew-case-")), name);
  writeFileSync(file, text);
  return file;
};

describe("사례 파일 읽기", () => {
  it("명세 §11.1 형식: story·known_at·prd.version·block 을 case_info 로 만든다(JQL 줄은 키가 아니라 건너뛴다)", () => {
    const { info, base } = parseCase(NEW_FORMAT);
    expect(info).toEqual({
      story: "APP-3008",
      known_at: "2026-09-10",
      prd_version: "22",
      block: { jira_keys: ["APP-3094", "APP-3096"], pr_numbers: [1054, 1081], heka_ids: ["note-a", "note-b"] },
    });
    expect(base).toBe("0123456789abcdef0123456789abcdef01234567");
  });

  it("옛 형식: story_key·prd_version·known_at·blocked.jira_keys·pr_numbers(branches 는 쓰지 않는다)", () => {
    const { info, base } = parseCase(OLD_FORMAT);
    expect(info).toEqual({
      story: "APP-3008",
      known_at: "2026-09-10",
      prd_version: "22",
      block: { jira_keys: ["APP-3094", "QA-5581"], pr_numbers: [1054, 1081], heka_ids: [] },
    });
    expect(base).toBe("c0ac96e20edff311ea897ff9bcb8cc8b7a4dc4dd");
  });

  it("알아볼 수 없는 칸은 건너뛰고 칸이 없어도 빈 차단 목록이 된다", () => {
    expect(parseCase("id: x\n").info).toEqual({ block: { jira_keys: [], pr_numbers: [], heka_ids: [] } });
    expect(parseCase("block:\n  prs: ['#12', abc, 13]\n  jira_keys: [APP-1, APP-1, 아무거나]\n").info.block).toEqual({ jira_keys: ["APP-1"], pr_numbers: [12, 13], heka_ids: [] });
  });

  it("매핑이 아닌 파일은 사용법 오류", () => {
    expect(() => parseCase("- a\n- b\n")).toThrow(HewError);
    expect(() => parseCase("a: [")).toThrow(/사례 파일/);
  });
});

describe("init --case", () => {
  it("replay 는 사례 정보를 run.json 의 case_info 에 싣고 known_at 은 run.known_at 에도 넣는다", () => {
    const { dir } = initRun({ prd: PRD_URL, mode: "replay", case: tmpFile("c.yaml", NEW_FORMAT), runId: "r1" });
    const run = loadRun(dir);
    expect(run.known_at).toBe("2026-09-10");
    expect(run.case_info).toMatchObject({ story: "APP-3008", prd_version: "22", block: { jira_keys: ["APP-3094", "APP-3096"], pr_numbers: [1054, 1081], heka_ids: ["note-a", "note-b"] } });
  });

  it("옛 형식 사례 파일도 읽는다", () => {
    const { dir } = initRun({ prd: PRD_URL, mode: "replay", case: tmpFile("old.yaml", OLD_FORMAT), runId: "r2" });
    expect(loadRun(dir).case_info?.block.jira_keys).toEqual(["APP-3094", "QA-5581"]);
    expect(loadRun(dir).known_at).toBe("2026-09-10");
  });

  it("사례 파일이 없거나 깨졌으면 종료 2 이고 실행 폴더를 만들지 않는다", () => {
    for (const bad of [join(tmpdir(), "hew-없는-사례.yaml"), tmpFile("bad.yaml", "a: [")]) {
      let code = -1;
      try {
        initRun({ prd: PRD_URL, mode: "replay", case: bad, runId: "r3" });
      } catch (e) {
        code = e instanceof HewError ? e.exitCode : -1;
      }
      expect(code).toBe(2);
    }
    expect(() => loadRun(join(process.env.HEW_RUNS_DIR as string, "r3"))).toThrow();
  });

  it("사례 없이 만든 live 실행에는 case_info·known_at 이 없다", () => {
    const { dir } = initRun({ prd: PRD_URL, runId: "r4" });
    const run = loadRun(dir);
    expect(run.case_info).toBeUndefined();
    expect(run.known_at).toBeUndefined();
  });
});

describe("init --repo: code 원천 자동 등록", () => {
  it("base 가 없으면 HEAD 의 SHA 로 code 원천을 등록한다", () => {
    const repo = makeGitRepo();
    const result = initRun({ prd: PRD_URL, repo: repo.dir, runId: "g1" });
    expect(result.warnings).toEqual([]);
    const code = loadManifest(result.dir).sources.find((s) => s.kind === "code");
    expect(code).toMatchObject({ id: "S-1", ref: repo.dir, meta: { base_sha: repo.head } });
    expect(repo.head).toMatch(/^[0-9a-f]{40}$/);
    expect(loadRun(result.dir).repo).toEqual({ path: repo.dir, base: null });
  });

  it("--base 가 있으면 그 브랜치의 SHA 를 쓴다", () => {
    const repo = makeGitRepo();
    const result = initRun({ prd: PRD_URL, repo: repo.dir, base: "develop", runId: "g2" });
    expect(loadManifest(result.dir).sources[0]?.meta.base_sha).toBe(repo.develop);
    expect(repo.develop).not.toBe(repo.head);
  });

  it("사례가 base 를 정했고 --base 가 없으면 사례의 값을 쓴다", () => {
    const repo = makeGitRepo();
    const result = initRun({ prd: PRD_URL, mode: "replay", repo: repo.dir, case: tmpFile("c.yaml", `repo:\n  base: ${repo.develop}\n`), runId: "g3" });
    expect(loadManifest(result.dir).sources[0]?.meta.base_sha).toBe(repo.develop);
  });

  it("git 이 실패하면 경고만 내고 등록하지 않으며 실행은 만들어진다", () => {
    const missing = initRun({ prd: PRD_URL, repo: join(tmpdir(), "hew-없는-저장소"), runId: "g4" });
    expect(missing.warnings).toHaveLength(1);
    expect(missing.warnings[0]).toMatchObject({ code: "code_source_skipped", severity: "warn" });
    expect(loadManifest(missing.dir).sources).toEqual([]);
    const repo = makeGitRepo();
    const badBase = initRun({ prd: PRD_URL, repo: repo.dir, base: "no-such-branch", runId: "g5" });
    expect(badBase.warnings[0]?.message).toContain("no-such-branch");
    expect(loadManifest(badBase.dir).sources).toEqual([]);
    expect(loadRun(badBase.dir).state).toBe("init");
  });

  it("--repo 가 없으면 code 원천을 등록하지 않는다", () => {
    expect(loadManifest(initRun({ prd: PRD_URL, runId: "g6" }).dir).sources).toEqual([]);
  });
});
