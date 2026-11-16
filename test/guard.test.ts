import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decide, tokenize } from "../hooks/guard.mjs";

let base = "";
let run = "";
let work = "";
let repo = "";
let other = "";
let hew = "";
let env: Record<string, string>;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "hew-guard-"));
  run = join(base, "run");
  work = join(run, "work", "w");
  repo = join(base, "repo");
  other = join(base, "other");
  hew = join(base, "bin", "hew");
  for (const d of [join(run, "sources"), join(run, "doc"), work, join(repo, "src"), other, join(base, "bin")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(run, "sources", "units.json"), "{}");
  writeFileSync(join(repo, "src", "a.ts"), "x");
  writeFileSync(join(other, "secret.txt"), "secret");
  writeFileSync(hew, "#!/bin/sh\n");
  symlinkSync(other, join(run, "link-out"));
  symlinkSync(join(other, "secret.txt"), join(run, "link-bare"));
  symlinkSync(join(other, "nowhere"), join(run, "dangling"));
  symlinkSync(other, join(work, "out-link"));
  env = {
    HEW_GUARD_READ_ROOTS: [run, repo].join(":"),
    HEW_GUARD_WRITE_ROOTS: work,
    HEW_GUARD_RUN_DIR: run,
    HEW_GUARD_HEW_BIN: hew,
  };
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

type Case = [name: string, payload: () => unknown, allow: boolean];

const read = (path: () => string): (() => unknown) => () => ({ tool_name: "Read", tool_input: { file_path: path() }, cwd: run });
const write = (tool: string, path: () => string): (() => unknown) => () => ({ tool_name: tool, tool_input: { file_path: path() }, cwd: run });
const bash = (cmd: () => string, cwd: () => string = () => run): (() => unknown) => () => ({ tool_name: "Bash", tool_input: { command: cmd() }, cwd: cwd() });
const tool = (name: string, input: unknown = {}): (() => unknown) => () => ({ tool_name: name, tool_input: input, cwd: run });

const cases: Case[] = [
  // Read
  ["Read: 읽기 뿌리 안 절대 경로", read(() => join(run, "sources", "units.json")), true],
  ["Read: cwd 기준 상대 경로", read(() => "sources/units.json"), true],
  ["Read: 대상 저장소 안", read(() => join(repo, "src", "a.ts")), true],
  ["Read: 없는 파일은 가장 가까운 부모로 판정", read(() => join(run, "doc", "new.json")), true],
  ["Read: 범위 밖 절대 경로", read(() => "/etc/hosts"), false],
  ["Read: 홈 아래 경로", read(() => "~/.claude/settings.json"), false],
  ["Read: .. 로 나가는 상대 경로", read(() => "../other/secret.txt"), false],
  ["Read: 뿌리 안에서 .. 로 나가는 경로", read(() => join(run, "..", "other", "secret.txt")), false],
  ["Read: 밖을 가리키는 심볼릭 링크 폴더", read(() => join(run, "link-out", "secret.txt")), false],
  ["Read: 밖을 가리키는 심볼릭 링크 파일", read(() => join(run, "link-bare")), false],
  ["Read: 끊어진 심볼릭 링크", read(() => join(run, "dangling")), false],
  ["Read: file_path 없음", tool("Read", {}), false],
  // Write
  ["Write: 작업 폴더 안", write("Write", () => join(work, "analysis.json")), true],
  ["Edit: 작업 폴더 안 새 파일", write("Edit", () => join(work, "sub", "x.json")), true],
  ["Write: 정본 폴더(doc)", write("Write", () => join(run, "doc", "analysis.json")), false],
  ["Write: 대상 저장소", write("Write", () => join(repo, "src", "a.ts")), false],
  ["Write: 작업 폴더에서 .. 로 나감", write("Write", () => join(work, "..", "..", "doc", "x.json")), false],
  ["Write: 작업 폴더 안 링크를 통해 밖으로", write("Write", () => join(work, "out-link", "x.txt")), false],
  ["Write: /tmp", write("Write", () => "/tmp/x"), false],
  ["Edit: 상대 경로는 cwd 기준이라 범위 밖", write("Edit", () => "x.json"), false],
  ["NotebookEdit: notebook_path 없음", tool("NotebookEdit", {}), false],
  // 그 밖의 도구
  ["Agent 거부", tool("Agent", { prompt: "x" }), false],
  ["Task 거부", tool("Task", { prompt: "x" }), false],
  ["WebFetch 거부", tool("WebFetch", { url: "https://example.com" }), false],
  ["WebSearch 거부", tool("WebSearch", { query: "x" }), false],
  ["Skill 거부", tool("Skill", { skill: "x" }), false],
  ["MCP 도구 거부", tool("mcp__figma__get_metadata", {}), false],
  ["Grep 도구 거부", tool("Grep", { pattern: "x", path: "/" }), false],
  ["Glob 도구 거부", tool("Glob", { pattern: "*" }), false],
  ["도구 이름 없음", () => ({ tool_input: {}, cwd: run }), false],
  // Bash 허용
  ["Bash: rg", bash(() => "rg foo sources"), true],
  ["Bash: 따옴표 안 파이프는 나누는 기준이 아님", bash(() => "rg 'a|b' sources"), true],
  ["Bash: 따옴표 안 세미콜론", bash(() => 'grep -c "x;y" sources/units.json'), true],
  ["Bash: 따옴표 안 &&", bash(() => "echo 'a && b'"), true],
  ["Bash: 작은따옴표 안 $HOME 은 글자 그대로", bash(() => "echo '$HOME'"), true],
  ["Bash: 파이프 연결", bash(() => "cat sources/units.json | jq .units | wc -l"), true],
  ["Bash: jq 필터의 파이프", bash(() => "jq '.units | length' sources/units.json"), true],
  ["Bash: ls", bash(() => "ls"), true],
  ["Bash: ls -la doc", bash(() => "ls -la doc"), true],
  ["Bash: head", bash(() => "head -c 10 sources/units.json"), true],
  ["Bash: 입력 리다이렉트(읽기 뿌리 안)", bash(() => "wc -l < sources/units.json"), true],
  ["Bash: 2>/dev/null", bash(() => "cat sources/units.json 2>/dev/null"), true],
  ["Bash: >/dev/null", bash(() => "ls >/dev/null"), true],
  ["Bash: 2>&1", bash(() => "ls nonexist 2>&1"), true],
  ["Bash: test && echo", bash(() => "test -f sources/units.json && echo yes"), true],
  ["Bash: [ ] || echo", bash(() => "[ -d doc ] || echo no"), true],
  ["Bash: 쓰기 뿌리 안으로 리다이렉트(상대)", bash(() => "echo x > work/w/note.txt"), true],
  ["Bash: 쓰기 뿌리 안으로 덧붙이기(절대)", bash(() => `echo x >> ${join(work, "log.txt")}`), true],
  ["Bash: find 이름 검색", bash(() => "find . -name '*.json'"), true],
  ["Bash: find 하위 폴더", bash(() => "find sources -type f"), true],
  ["Bash: git -C 읽기 뿌리 안 log", bash(() => `git -C ${repo} log --oneline`), true],
  ["Bash: git -C show 리비전:경로", bash(() => `git -C ${repo} show HEAD:src/a.ts`), true],
  ["Bash: git diff a..b", bash(() => "git diff main..HEAD --stat"), true],
  ["Bash: git branch 인자 없음", bash(() => "git branch"), true],
  ["Bash: git branch --list", bash(() => "git branch --list 'release/*'"), true],
  ["Bash: git grep", bash(() => `git -C ${repo} grep -n foo -- src`), true],
  ["Bash: hew submit", bash(() => `${hew} --json submit analysis --run ${run} --file ${join(work, "analysis.json")}`), true],
  ["Bash: hew status", bash(() => `${hew} --json status --run ${run}`), true],
  ["Bash: hew --run= 형식", bash(() => `${hew} check --run=${run} 2>&1 | head -20`), true],
  ["Bash: hew source list", bash(() => `${hew} source list --run ${run}`), true],
  ["Bash: hew source request", bash(() => `${hew} source request --run ${run} --note x`), true],
  ["Bash: sips 속성 읽기", bash(() => "sips -g pixelWidth sources/a.png"), true],
  ["Bash: sips --out 쓰기 뿌리 안", bash(() => `sips -Z 500 sources/a.png --out ${join(work, "a.png")}`), true],
  ["Bash: 줄바꿈으로 나눈 허용 명령들", bash(() => "ls\ncat sources/units.json"), true],
  // Bash 거부: 경로·변수
  ["Bash 거부: cat ~/.claude/…", bash(() => "cat ~/.claude/settings.json"), false],
  ["Bash 거부: cat $HOME/x", bash(() => "cat $HOME/x"), false],
  ["Bash 거부: cat ${HOME}/x", bash(() => "cat ${HOME}/x"), false],
  ["Bash 거부: echo $HOME", bash(() => "echo $HOME"), false],
  ['Bash 거부: 큰따옴표 안 "$HOME"', bash(() => 'cat "$HOME/x"'), false],
  ["Bash 거부: rg x /Users", bash(() => "rg x /Users"), false],
  ["Bash 거부: ls ../..", bash(() => "ls ../.."), false],
  ["Bash 거부: ls ~", bash(() => "ls ~"), false],
  ["Bash 거부: ls ~다른사용자", bash(() => "ls ~root"), false],
  ["Bash 거부: find / -name x", bash(() => "find / -name x"), false],
  ["Bash 거부: head -c 10 /etc/hosts", bash(() => "head -c 10 /etc/hosts"), false],
  ["Bash 거부: /Users/../etc/hosts", bash(() => "cat /Users/../etc/hosts"), false],
  ["Bash 거부: ls -d /*", bash(() => "ls -d /*"), false],
  ["Bash 거부: .. 와 와일드카드", bash(() => "cat sources/*/../../../etc/passwd"), false],
  ["Bash 거부: 밖을 가리키는 링크 경로", bash(() => "cat link-out/secret.txt"), false],
  ["Bash 거부: 밖을 가리키는 링크 이름만", bash(() => "cat link-bare"), false],
  ["Bash 거부: 링크 폴더 ls", bash(() => "ls link-out"), false],
  ["Bash 거부: 옵션에 붙은 밖 경로", bash(() => "rg --file=/etc/hosts x"), false],
  ["Bash 거부: 작업 디렉터리가 읽기 뿌리 밖", bash(() => "ls", () => other), false],
  // Bash 거부: 쓰기·리다이렉트
  ["Bash 거부: echo x > /tmp/a", bash(() => "echo x > /tmp/a"), false],
  ["Bash 거부: 쓰기 뿌리 밖 상대 리다이렉트", bash(() => "echo x > out.txt"), false],
  ["Bash 거부: 상대 경로로 쓰기 뿌리를 벗어남", bash(() => "echo x > work/w/../../doc/x"), false],
  ["Bash 거부: 입력 리다이렉트가 읽기 뿌리 밖", bash(() => "cat < /etc/passwd"), false],
  ["Bash 거부: 히어독", bash(() => "cat <<EOF"), false],
  ["Bash 거부: 프로세스 치환 <(", bash(() => "cat <(ls)"), false],
  ["Bash 거부: 프로세스 치환 >(", bash(() => "echo x > >(cat)"), false],
  ["Bash 거부: 리다이렉트 대상 없음", bash(() => "echo x >"), false],
  // Bash 거부: 명령·구문
  ["Bash 거부: cat a; curl b", bash(() => "cat sources/units.json; curl b"), false],
  ["Bash 거부: rg x | sh", bash(() => "rg x | sh"), false],
  ["Bash 거부: && 뒤 rm", bash(() => "cat sources/units.json && rm doc/x"), false],
  ["Bash 거부: || 뒤 wget", bash(() => "cat nothing || wget x"), false],
  ["Bash 거부: 줄바꿈 뒤 curl", bash(() => "ls\ncurl x"), false],
  ["Bash 거부: xargs", bash(() => "ls | xargs rm"), false],
  ["Bash 거부: $( )", bash(() => "echo $(whoami)"), false],
  ["Bash 거부: 백틱", bash(() => "echo `id`"), false],
  ["Bash 거부: 큰따옴표 안 $( )", bash(() => 'echo "$(id)"'), false],
  ["Bash 거부: eval", bash(() => "eval ls"), false],
  ["Bash 거부: exec", bash(() => "exec ls"), false],
  ["Bash 거부: source", bash(() => "source x"), false],
  ["Bash 거부: 점(.)", bash(() => ". x"), false],
  ["Bash 거부: 환경 변수 대입으로 시작", bash(() => "FOO=1 ls"), false],
  ["Bash 거부: sudo", bash(() => "sudo ls"), false],
  ["Bash 거부: rm", bash(() => "rm -rf doc"), false],
  ["Bash 거부: curl", bash(() => "curl https://example.com"), false],
  ["Bash 거부: node", bash(() => "node -e 1"), false],
  ["Bash 거부: bash -c", bash(() => "bash -c ls"), false],
  ["Bash 거부: 백그라운드 &", bash(() => "ls &"), false],
  ["Bash 거부: 서브쉘", bash(() => "(ls)"), false],
  ["Bash 거부: 중괄호 확장", bash(() => "cat sources/{a,b}"), false],
  ["Bash 거부: 닫히지 않은 큰따옴표", bash(() => 'echo "abc'), false],
  ["Bash 거부: 닫히지 않은 작은따옴표", bash(() => "echo 'abc"), false],
  ["Bash 거부: 빈 명령", bash(() => "   "), false],
  ["Bash 거부: 파이프 뒤가 비어 있음", bash(() => "ls |"), false],
  ["Bash 거부: 주석", bash(() => "ls #x"), false],
  ["Bash 거부: 줄 끝 역슬래시", bash(() => "ls \\\nsources"), false],
  // Bash 거부: 명령별 옵션
  ["Bash 거부: find -exec", bash(() => "find . -exec cat x ;"), false],
  ["Bash 거부: find -delete", bash(() => "find . -name x -delete"), false],
  ["Bash 거부: find -execdir", bash(() => "find . -execdir ls ;"), false],
  ["Bash 거부: find -fprint", bash(() => "find . -fprint out.txt"), false],
  ["Bash 거부: find -ok", bash(() => "find . -ok ls ;"), false],
  ["Bash 거부: find -fls", bash(() => "find . -fls out.txt"), false],
  ["Bash 거부: rg --pre", bash(() => "rg --pre cat x"), false],
  ["Bash 거부: sort -o", bash(() => "sort -o doc/x sources/units.json"), false],
  ["Bash 거부: uniq 출력 파일 인자", bash(() => "uniq a b"), false],
  ["Bash 거부: jq env", bash(() => "jq -n 'env'"), false],
  ["Bash 거부: jq include", bash(() => "jq -n 'include \"x\"; 1'"), false],
  ["Bash 거부: sips 원본 수정", bash(() => "sips -Z 100 sources/a.png"), false],
  ["Bash 거부: sips --out 이 쓰기 뿌리 밖", bash(() => "sips -Z 100 sources/a.png --out /tmp/x.png"), false],
  ["Bash 거부: git push", bash(() => "git push"), false],
  ["Bash 거부: git commit", bash(() => "git commit -m x"), false],
  ["Bash 거부: git checkout", bash(() => "git checkout x"), false],
  ["Bash 거부: git -C 밖 경로", bash(() => `git -C ${other} log`), false],
  ["Bash 거부: git -C 상대 경로로 밖", bash(() => "git -C ../other log"), false],
  ["Bash 거부: git -c", bash(() => "git -c core.pager=x log"), false],
  ["Bash 거부: git log --output", bash(() => "git log --output=x"), false],
  ["Bash 거부: git diff --ext-diff", bash(() => "git diff --ext-diff"), false],
  ["Bash 거부: git branch 만들기", bash(() => "git branch newbranch"), false],
  ["Bash 거부: git branch -D", bash(() => "git branch -D foo"), false],
  ["Bash 거부: git 하위 명령 없음", bash(() => "git"), false],
  // Bash 거부: hew
  ["Bash 거부: hew 다른 실행 폴더", bash(() => `${hew} --json status --run ${other}`), false],
  ["Bash 거부: hew --run 없는 값", bash(() => `${hew} status --run`), false],
  ["Bash 거부: hew submit --file 이 쓰기 뿌리 밖", bash(() => `${hew} submit analysis --run ${run} --file ${join(run, "doc", "x.json")}`), false],
  ["Bash 거부: hew packet", bash(() => `${hew} packet --run ${run} --role technical-manager`), false],
  ["Bash 거부: hew run", bash(() => `${hew} run --run ${run}`), false],
  ["Bash 거부: hew source add", bash(() => `${hew} source add --run ${run}`), false],
  ["Bash 거부: hew 하위 명령 없음", bash(() => `${hew} --json`), false],
  ["Bash 거부: 이름만 hew", bash(() => `hew status --run ${run}`), false],
  ["Bash 거부: 경로가 다른 hew", bash(() => `/usr/bin/hew status --run ${run}`), false],
];

describe("범위 훅 판정표", () => {
  it("사례가 40건 이상이다", () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
  });

  for (const [name, payload, allow] of cases) {
    it(`${allow ? "허용" : "거부"} — ${name}`, () => {
      const verdict = decide(payload(), env);
      expect(verdict.decision, verdict.reason).toBe(allow ? "allow" : "deny");
    });
  }

  it("NotebookEdit: 작업 폴더 안은 허용, 밖은 거부", () => {
    const ok = decide({ tool_name: "NotebookEdit", tool_input: { notebook_path: join(work, "n.ipynb") }, cwd: run }, env);
    const bad = decide({ tool_name: "NotebookEdit", tool_input: { notebook_path: join(other, "n.ipynb") }, cwd: run }, env);
    expect([ok.decision, bad.decision]).toEqual(["allow", "deny"]);
  });

  it("뿌리 환경 변수가 없으면 읽기·쓰기가 모두 거부된다", () => {
    expect(decide({ tool_name: "Read", tool_input: { file_path: join(run, "sources", "units.json") }, cwd: run }, {}).decision).toBe("deny");
    expect(decide({ tool_name: "Write", tool_input: { file_path: join(work, "a") }, cwd: run }, {}).decision).toBe("deny");
  });

  it("HEW_GUARD_HEW_BIN 이 없으면 hew 호출이 거부된다", () => {
    const noBin = { ...env, HEW_GUARD_HEW_BIN: "" };
    expect(decide({ tool_name: "Bash", tool_input: { command: `${hew} status --run ${run}` }, cwd: run }, noBin).decision).toBe("deny");
  });

  it("토큰화: 따옴표 안 연산자는 조각을 나누지 않는다", () => {
    const segs = tokenize("rg 'a;b|c' x | head");
    expect(segs.map((s) => s.words)).toEqual([["rg", "a;b|c", "x"], ["head"]]);
  });
});

describe("범위 훅 프로세스 계약", () => {
  const guard = join(import.meta.dirname, "..", "hooks", "guard.mjs");

  function callGuard(stdin: string, extraEnv: Record<string, string> = {}): { stdout: string; code: number | null } {
    const r = spawnSync(process.execPath, [guard], { input: stdin, encoding: "utf8", env: { ...process.env, ...env, ...extraEnv } });
    return { stdout: r.stdout, code: r.status };
  }

  it("stdin JSON 을 받아 hookSpecificOutput 형태로 판정하고 종료 0", () => {
    const out = callGuard(JSON.stringify({ tool_name: "Read", tool_input: { file_path: join(run, "sources", "units.json") }, cwd: run }));
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: expect.any(String) },
    });
  });

  it("범위 밖은 deny 와 사유를 낸다", () => {
    const out = callGuard(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" }, cwd: run }));
    const body = JSON.parse(out.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(body.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(body.hookSpecificOutput.permissionDecisionReason).toContain("읽기 범위 밖");
  });

  it("JSON 이 아닌 입력은 거부한다", () => {
    const out = callGuard("not json");
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("HEW_GUARD_LOG 에 판정을 한 줄씩 덧붙인다", () => {
    const log = join(base, "guard.jsonl");
    callGuard(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: run }), { HEW_GUARD_LOG: log });
    callGuard(JSON.stringify({ tool_name: "Bash", tool_input: { command: "curl x" }, cwd: run }), { HEW_GUARD_LOG: log });
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { decision: string; tool: string });
    expect(lines.map((l) => l.decision)).toEqual(["allow", "deny"]);
    expect(lines[0]?.tool).toBe("Bash");
  });
});

describe("cd 와 pwd", () => {
  const bash = (command: string) => decide({ tool_name: "Bash", tool_input: { command }, cwd: run }, env).decision;

  it("맨 앞의 cd 는 읽기 범위 안이면 허용하고 뒤 조각의 상대 경로를 그 자리 기준으로 푼다", () => {
    expect(bash(`cd ${join(run, "sources")} && cat units.json`)).toBe("allow");
    expect(bash(`cd ${repo} && rg x src`)).toBe("allow");
    expect(bash("pwd")).toBe("allow");
  });

  it("범위 밖으로 가는 cd, 맨 앞이 아닌 cd, 인자가 여럿인 cd 는 거부한다", () => {
    expect(bash(`cd ${other} && cat secret.txt`)).toBe("deny");
    expect(bash(`cat sources/units.json && cd ${repo}`)).toBe("deny");
    expect(bash(`cd ${repo} ${run}`)).toBe("deny");
    expect(bash("cd .. && ls")).toBe("deny");
    expect(bash(`cd ${join(run, "link-out")} && cat secret.txt`)).toBe("deny");
  });

  it("cd 뒤에는 .. 가 든 인자를 받지 않는다", () => {
    expect(bash(`cd ${join(run, "sources")} && cat ../doc/x.json`)).toBe("deny");
    expect(bash(`cd ${repo} && cat ../other/secret.txt`)).toBe("deny");
  });

  it("cd 뒤에도 범위 밖 절대 경로와 허용되지 않는 명령은 거부한다", () => {
    expect(bash(`cd ${repo} && cat ${join(other, "secret.txt")}`)).toBe("deny");
    expect(bash(`cd ${repo} && curl http://example.com`)).toBe("deny");
  });
});
