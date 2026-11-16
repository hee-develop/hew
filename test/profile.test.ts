import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPacket } from "../src/core/packet.js";
import { HEW_ROOT } from "../src/core/paths.js";
import { planCheck } from "../src/core/plan/checks.js";
import { loadPlanRules } from "../src/core/plan/rules.js";
import { clearProfileCache, humanTitleFormat, loadProfile, profileDir, titlePattern, titlePrefix } from "../src/core/profile.js";
import { loadRun } from "../src/core/run.js";
import { roleConfig } from "../src/core/roles.js";
import { judgeActor } from "../src/core/units/actor.js";
import { computePlan } from "../src/core/collect/plan.js";
import type { Doc } from "./analysis-fixtures.js";
import { makeRun, useTempRunsDir } from "./helpers.js";
import { buildPlan, clone, planSasu, setupAnswersApplied, setupPlanned } from "./plan-fixtures.js";
import { FAKE_HEKA, tempDir } from "./runner-helpers.js";

useTempRunsDir();

const EXAMPLE = join(HEW_ROOT, "profiles", "example");
const OTHER_YAML = `actors:
  operator: ["staff"]
  provider: ["seller"]
  customer: ["buyer", "guest"]
plan:
  sp: { min: 1, max: 3, hours_per_sp: 2 }
  title:
    format: "TASK-{epic}: {summary}"
  pr: { max_tickets: 4, base: main }
  notes: ["제목은 영문으로 쓰지 않는다"]
heka:
  ticket-maker: [other-rule-a, other-rule-b]
  technical-manager: [other-rule-c]
connections:
  atlassian_cloud_id: other.example.net
`;

/** 임시 프로필 폴더를 만든다. */
function makeProfile(yaml: string, domain?: string): string {
  const dir = tempDir("hew-profile-");
  writeFileSync(join(dir, "profile.yaml"), yaml);
  if (domain !== undefined) writeFileSync(join(dir, "domain.md"), domain);
  return dir;
}

const saved = { dir: process.env.HEW_PROFILE_DIR, home: process.env.HOME };
afterEach(() => {
  if (saved.dir === undefined) delete process.env.HEW_PROFILE_DIR;
  else process.env.HEW_PROFILE_DIR = saved.dir;
  if (saved.home === undefined) delete process.env.HOME;
  else process.env.HOME = saved.home;
  clearProfileCache();
});
const useProfile = (dir: string): void => {
  process.env.HEW_PROFILE_DIR = dir;
};
const env = (): NodeJS.ProcessEnv => ({ ...process.env, HEW_HEKA_BIN: FAKE_HEKA });

describe("프로필: 위치 순서", () => {
  it("환경 변수가 있으면 그 폴더", () => {
    expect(profileDir({ HEW_PROFILE_DIR: "/some/where" })).toBe("/some/where");
  });

  it("환경 변수가 없고 홈에 ~/.hew/profile 이 있으면 홈", () => {
    const home = tempDir("hew-home-");
    mkdirSync(join(home, ".hew", "profile"), { recursive: true });
    process.env.HOME = home;
    expect(profileDir({})).toBe(join(home, ".hew", "profile"));
  });

  it("홈에 폴더가 없으면 저장소의 예시", () => {
    process.env.HOME = tempDir("hew-home-");
    expect(profileDir({})).toBe(EXAMPLE);
    expect(profileDir({ HEW_PROFILE_DIR: "" })).toBe(EXAMPLE);
  });

  it("환경 변수가 홈보다 앞선다", () => {
    const home = tempDir("hew-home-");
    mkdirSync(join(home, ".hew", "profile"), { recursive: true });
    process.env.HOME = home;
    expect(profileDir({ HEW_PROFILE_DIR: EXAMPLE })).toBe(EXAMPLE);
  });
});

describe("프로필: 읽기와 스키마 오류", () => {
  it("예시 프로필을 읽는다", () => {
    const p = loadProfile(EXAMPLE);
    expect(p.actors.provider).toEqual(["판매자"]);
    expect(p.plan.pr).toEqual({ max_tickets: 6, base: "develop" });
    expect(p.domain).toContain("신규 판매자");
  });

  it("같은 폴더는 한 번만 읽는다(캐시), 비우면 다시 읽는다", () => {
    const dir = makeProfile(OTHER_YAML);
    const a = loadProfile(dir);
    expect(loadProfile(dir)).toBe(a);
    clearProfileCache();
    expect(loadProfile(dir)).not.toBe(a);
  });

  it("profile.yaml 이 없으면 내부 오류가 파일 경로를 알린다", () => {
    const dir = tempDir("hew-profile-");
    expect(() => loadProfile(dir)).toThrow(`프로필 파일이 없습니다: ${join(dir, "profile.yaml")}`);
  });

  it("틀린 키를 경로로 알린다", () => {
    const bad = OTHER_YAML.replace("max_tickets: 4", "max_tickets: 0");
    expect(() => loadProfile(makeProfile(bad))).toThrow(/profile\.yaml 형식이 올바르지 않습니다: .*profile\.yaml 의 plan\.pr\.max_tickets/);
  });

  it("{epic} 이 {summary} 보다 뒤에 있으면 거부한다", () => {
    const bad = OTHER_YAML.replace("TASK-{epic}: {summary}", "{summary} / {epic}");
    expect(() => loadProfile(makeProfile(bad))).toThrow(/plan\.title\.format .*앞에/);
  });

  it("{summary} 가 없으면 거부한다", () => {
    const bad = OTHER_YAML.replace("TASK-{epic}: {summary}", "{epic}");
    expect(() => loadProfile(makeProfile(bad))).toThrow(/plan\.title\.format/);
  });

  it("알 수 없는 키와 틀린 정규식 조각을 거부한다", () => {
    expect(() => loadProfile(makeProfile(`${OTHER_YAML}extra: 1\n`))).toThrow(/extra|Unrecognized/);
    expect(() => loadProfile(makeProfile(OTHER_YAML.replace('["seller"]', '["(seller"]')))).toThrow(/actors\.provider\.0/);
  });
});

describe("프로필: 제목 형식에서 만든 값", () => {
  it("예시 형식은 기존 정규식과 같다", () => {
    expect(titlePattern("[MO] {epic} / {summary}")).toBe("^\\[MO\\] .+ / .+$");
  });

  it("일감명 접두와 사람이 읽는 표기", () => {
    expect(titlePrefix("[MO] {epic} / {summary}", "배너")).toBe("[MO] 배너 / ");
    expect(titlePrefix("TASK-{epic}: {summary}", "배너")).toBe("TASK-배너: ");
    expect(humanTitleFormat("TASK-{epic}: {summary}")).toBe("TASK-{일감명}: {작업 요약}");
  });

  it("정규식 특수문자는 이스케이프된다", () => {
    const re = new RegExp(titlePattern("(a.b) {epic}+{summary}"));
    expect(re.test("(a.b) x+y")).toBe(true);
    expect(re.test("(aXb) x+y")).toBe(false);
  });
});

describe("프로필: 코드가 따라 바뀐다", () => {
  it("judgeActor 가 프로필의 주체 낱말을 쓴다", () => {
    expect(judgeActor("판매자가 구매자에게")).toBe("provider");
    expect(judgeActor("Seller 가 buyer 에게")).toBeUndefined();
    useProfile(makeProfile(OTHER_YAML));
    expect(judgeActor("Seller 가 buyer 에게")).toBe("provider");
    expect(judgeActor("guest 가 staff 에게")).toBe("customer");
    expect(judgeActor("판매자")).toBeUndefined();
  });

  it("분해 규칙이 프로필의 plan 에서 온다", () => {
    useProfile(makeProfile(OTHER_YAML));
    const rules = loadPlanRules();
    expect(rules.sp).toEqual({ min: 1, max: 3, hours_per_sp: 2 });
    expect(rules.pr).toEqual({ max_tickets: 4, base: "main" });
    expect(rules.title_pattern).toBe("^TASK-.+: .+$");
    expect(rules.body_forbidden.length).toBeGreaterThanOrEqual(6);
  });

  it("제목·base 검사가 프로필을 따른다", () => {
    const { dir } = setupAnswersApplied();
    const run = (doc: Doc) => planCheck(doc, { kind: "plan", for: null, run: loadRun(dir), runDir: dir });
    const codes = (doc: Doc): string[] => run(doc).filter((i) => i.severity === "reject").map((i) => i.code);
    expect(codes(clone(buildPlan()))).toEqual([]);

    useProfile(makeProfile(OTHER_YAML));
    const first = clone(buildPlan());
    const issues = run(first);
    const titleIssue = issues.find((i) => i.code === "title_format");
    expect(titleIssue?.message).toContain("TASK-{일감명}: {작업 요약}");
    expect(issues.some((i) => i.code === "plan_ref_missing" && i.message.includes("base PR 묶음 'develop'"))).toBe(true);

    const fixed = clone(buildPlan());
    for (const t of fixed.tickets) t.title = `TASK-${fixed.epic_name}: 요약`;
    for (const p of fixed.prs) if (p.base === "develop") p.base = "main";
    expect(codes(fixed)).toEqual([]);

    fixed.tickets[0].title = "TASK-다른 일감: 요약";
    expect(run(fixed).find((i) => i.code === "title_format")?.message).toContain("epic_name");
  });

  it("heka id 가 프로필에서 온다", () => {
    expect(roleConfig("ticket-maker").heka).toHaveLength(6);
    useProfile(makeProfile(OTHER_YAML));
    expect(roleConfig("ticket-maker").heka).toEqual(["other-rule-a", "other-rule-b"]);
    expect(roleConfig("technical-manager").heka).toEqual(["other-rule-c"]);
    expect(roleConfig("collector").heka).toEqual([]);
  });

  it("cloud id 가 수집 도구 힌트와 collector 패킷에 실린다", () => {
    useProfile(makeProfile(OTHER_YAML));
    const { dir } = makeRun("init");
    expect(computePlan(dir).items.map((i) => i.tool_hint).join("\n")).toContain("cloudId=other.example.net");
    const text = readFileSync(buildPacket({ runDir: dir, role: "collector", env: env() }).path, "utf8");
    expect(text).toContain("cloudId: `other.example.net`");
    expect(text).not.toContain("## 도메인 안내");
  });
});

describe("프로필: 패킷의 도메인 안내·팀 규칙", () => {
  const packet = (dir: string, role: "technical-manager" | "qa-designer" | "ticket-maker"): string => readFileSync(buildPacket({ runDir: dir, role, env: env() }).path, "utf8");

  it("ticket-maker: 팀 규칙이 따를 규칙 앞에 있고 도메인 안내는 없다", () => {
    const { dir } = setupAnswersApplied();
    const text = packet(dir, "ticket-maker");
    const team = text.indexOf("## 팀 규칙");
    const domain = text.indexOf("## 도메인 안내");
    const rules = text.indexOf("## 따를 규칙");
    expect(team).toBeGreaterThan(0);
    expect(team).toBeLessThan(rules);
    expect(domain).toBe(-1);
    expect(text).toContain("제목 형식: `[MO] {일감명} / {작업 요약}`");
    expect(text).toContain("SP 범위: 2~4SP (1SP = 1시간, 티켓 하나 2~4시간)");
    expect(text).toContain("PR 묶음 하나의 티켓 상한: 6개");
    expect(text).toContain("기본 base 브랜치: `develop`");
    expect(text).toContain("- 스쿼드 접두어는 붙이지 않는다");
  });

  it("technical-manager 와 qa-designer: 도메인 안내만 있고 팀 규칙은 없다", () => {
    const { dir } = setupAnswersApplied();
    for (const role of ["technical-manager", "qa-designer"] as const) {
      const text = packet(dir, role);
      expect(text).toContain("## 도메인 안내");
      expect(text).not.toContain("## 팀 규칙");
      expect(text.indexOf("## 도메인 안내")).toBeLessThan(text.indexOf("## 따를 규칙"));
      expect(text).toContain(loadProfile(EXAMPLE).domain as string);
    }
  });

  it("ticket-sasu 는 팀 규칙만 있고 도메인 안내는 없다", () => {
    const { dir } = setupPlanned();
    planSasu(dir);
    const text = readFileSync(buildPacket({ runDir: dir, role: "ticket-sasu", env: env() }).path, "utf8");
    expect(text.indexOf("## 팀 규칙")).toBeGreaterThan(0);
    expect(text.indexOf("## 팀 규칙")).toBeLessThan(text.indexOf("## 따를 규칙"));
    expect(text).not.toContain("## 도메인 안내");
  });

  it("다른 프로필의 값이 패킷에 실리고 domain.md 가 없으면 도메인 안내를 뺀다", () => {
    useProfile(makeProfile(OTHER_YAML));
    const { dir } = setupAnswersApplied();
    const text = packet(dir, "ticket-maker");
    expect(text).toContain("제목 형식: `TASK-{일감명}: {작업 요약}`");
    expect(text).toContain("SP 범위: 1~3SP (1SP = 2시간, 티켓 하나 2~6시간)");
    expect(text).toContain("PR 묶음 하나의 티켓 상한: 4개");
    expect(text).toContain("기본 base 브랜치: `main`");
    expect(text).toContain("- 제목은 영문으로 쓰지 않는다");
    expect(text).not.toContain("## 도메인 안내");
    expect(text).toContain("other-rule-a");
  });

  it("domain.md 가 비어 있어도 절을 뺀다", () => {
    useProfile(makeProfile(OTHER_YAML, "  \n\n"));
    const { dir } = setupAnswersApplied();
    expect(packet(dir, "technical-manager")).not.toContain("## 도메인 안내");
  });

  it("domain.md 내용은 그대로 실린다", () => {
    useProfile(makeProfile(OTHER_YAML, "- 주체: seller 는 파는 쪽\n"));
    const { dir } = setupAnswersApplied();
    expect(packet(dir, "technical-manager")).toContain("## 도메인 안내\n\n- 주체: seller 는 파는 쪽\n");
  });
});

describe("프로필: CLI 자식 프로세스", () => {
  it("HEW_PROFILE_DIR 을 주면 CLI 가 만든 패킷의 값이 바뀐다", () => {
    const { dir } = setupAnswersApplied();
    const profile = makeProfile(OTHER_YAML, "- 주체: seller 는 파는 쪽\n");
    const run = (profileDir: string): string => {
      const r = spawnSync(join(HEW_ROOT, "bin", "hew"), ["--json", "packet", "--role", "ticket-maker", "--run", dir], {
        env: { ...process.env, HEW_PROFILE_DIR: profileDir, HEW_HEKA_BIN: FAKE_HEKA },
        encoding: "utf8",
      });
      expect(r.status, r.stderr + r.stdout).toBe(0);
      const path = (JSON.parse(r.stdout) as { data: { path: string } }).data.path;
      return readFileSync(path, "utf8");
    };
    const example = run(EXAMPLE);
    expect(example).toContain("제목 형식: `[MO] {일감명} / {작업 요약}`");
    const other = run(profile);
    expect(other).toContain("제목 형식: `TASK-{일감명}: {작업 요약}`");
    // 도메인 안내는 테크니컬 매니저·QA 설계 패킷에만 실린다
    expect(other).not.toContain("seller 는 파는 쪽");
  });

  it("프로필이 깨지면 CLI 가 어느 파일의 어느 키인지 알리고 실패한다", () => {
    const { dir } = setupAnswersApplied();
    const bad = makeProfile(OTHER_YAML.replace("base: main", "base: 3"));
    const r = spawnSync(join(HEW_ROOT, "bin", "hew"), ["packet", "--role", "ticket-maker", "--run", dir], {
      env: { ...process.env, HEW_PROFILE_DIR: bad, HEW_HEKA_BIN: FAKE_HEKA },
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("plan.pr.base");
  });
});
