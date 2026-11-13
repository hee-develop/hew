#!/usr/bin/env node
/** Claude Code PreToolUse 훅: 읽기·쓰기 범위와 Bash 허용 명령을 지킨다. 판단할 수 없으면 거부한다. */
import { appendFileSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ALLOWED_COMMANDS = new Set([
  "rg", "grep", "ls", "find", "cat", "head", "tail", "wc", "jq", "sort", "uniq", "cut", "tr", "sips", "file", "stat",
  "basename", "dirname", "echo", "true", "test", "[", "git", "pwd", "sed", "paste", "column", "nl", "mkdir",
]);
const GIT_SUBCOMMANDS = new Set(["log", "show", "diff", "status", "ls-files", "grep", "rev-parse", "cat-file", "blame", "branch"]);
const GIT_FORBIDDEN_FLAGS = ["--output", "--ext-diff", "--textconv", "--filters", "--open-files-in-pager", "--exec-path", "--upload-pack"];
const GIT_BRANCH_FLAGS = new Set(["--list", "-l", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--show-current", "--no-color", "--color=never"]);
const FIND_FORBIDDEN = /^-(exec|execdir|delete|ok|okdir|fprint\w*|fls)$/;
const FIND_PATTERN_OPTIONS = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex"]);
const SED_SCRIPT = /^[0-9,$;p\s]+$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// rg·grep 옵션 표: 값을 받는 짧은 옵션 글자, 값이 없는 짧은 옵션 글자, 긴 옵션 이름.
const PATTERN_SPECS = {
  rg: {
    shortValue: new Set("efgtTABCmjMdEr"),
    shortFlag: new Set("iInNlcvwFsSuHhoUqLpPx0"),
    longValue: new Set([
      "--file", "--glob", "--iglob", "--type", "--type-not", "--type-add", "--max-count", "--max-depth", "--maxdepth", "--context",
      "--after-context", "--before-context", "--replace", "--threads", "--max-columns", "--color", "--sort", "--sortr", "--ignore-file",
      "--encoding", "--max-filesize", "--colors", "--path-separator", "--engine",
    ]),
    longFlag: new Set([
      "--ignore-case", "--case-sensitive", "--smart-case", "--line-number", "--no-line-number", "--files-with-matches", "--files-without-match",
      "--count", "--count-matches", "--hidden", "--no-ignore", "--fixed-strings", "--word-regexp", "--line-regexp", "--invert-match",
      "--heading", "--no-heading", "--json", "--only-matching", "--no-filename", "--with-filename", "--follow", "--multiline", "--quiet",
      "--no-messages", "--vimgrep", "--pretty", "--text", "--null", "--stats", "--files", "--type-list", "--column", "--no-config",
    ]),
    noPattern: new Set(["--files", "--type-list"]),
  },
  grep: {
    shortValue: new Set("efmABCdD"),
    shortFlag: new Set("ivnclLrRwxFEGPHhoqsaIzUZbTV0123456789"),
    longValue: new Set([
      "--file", "--max-count", "--after-context", "--before-context", "--context", "--include", "--exclude", "--exclude-dir", "--exclude-from",
      "--directories", "--devices", "--binary-files", "--label",
    ]),
    longFlag: new Set([
      "--ignore-case", "--no-ignore-case", "--invert-match", "--line-number", "--count", "--files-with-matches", "--files-without-match",
      "--recursive", "--dereference-recursive", "--word-regexp", "--line-regexp", "--extended-regexp", "--basic-regexp", "--fixed-strings",
      "--perl-regexp", "--only-matching", "--quiet", "--silent", "--no-messages", "--with-filename", "--no-filename", "--text", "--null",
      "--color", "--colour", "--byte-offset", "--initial-tab", "--null-data",
    ]),
    noPattern: new Set(),
  },
};
const HEW_SUBCOMMANDS = new Set(["submit", "check", "status", "next", "units", "source", "sasu"]);
const HEW_SOURCE_SUBCOMMANDS = new Set(["list", "request"]);
const COLLECTOR_SOURCE_SUBCOMMANDS = new Set(["plan", "calls", "add", "fail", "done", "list", "request"]);
// 수집 프로필에서 값이 글(식별자·사유)이라 경로 검사를 하지 않는 hew source 옵션.
const COLLECTOR_TEXT_FLAGS = /^--(ref|title|reason|version|kind|node|env|base-sha|item|what)(?:=([\s\S]*))?$/;
const DEFAULT_MCP_ALLOW = [
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
const DEFAULT_CURL_HOSTS = ["figma.com", "figma-alpha-api.s3.us-west-2.amazonaws.com", "s3-alpha-sig.figma.com", "amazonaws.com"];
// replay·shadow 에서 executeRead 로 허용하는 연산(지정한 문서·버전·이슈 조회만).
const READ_ONLY_OPERATIONS = new Set(["getConfluenceContentVersion", "listConfluenceContentVersions", "getConfluencePage", "getConfluenceContent", "getJiraIssue"]);
const SEARCH_KEYS = /^(jql|cql|query|searchText)$/i;
const HEW_SASU_SUBCOMMANDS = new Set(["respond"]);
const SIPS_READ_FLAGS = new Set(["-g", "--getProperty", "-1", "--oneLine"]);
const FORBIDDEN_FIRST = new Set(["eval", "exec", "source", ".", "sudo"]);

class Deny extends Error {}
const deny = (reason) => {
  throw new Deny(reason);
};

/** 경로를 심볼릭 링크를 따라가며 물리 경로로 푼다. 없는 부분은 그대로 이어 붙이고, 끊어진 링크는 null. */
export function physicalPath(absolute) {
  const parts = absolute.split("/").filter((part) => part.length > 0);
  let cur = "/";
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      cur = dirname(cur);
      continue;
    }
    const next = join(cur, part);
    let stat;
    try {
      stat = lstatSync(next);
    } catch {
      cur = next;
      continue;
    }
    if (stat.isSymbolicLink()) {
      try {
        cur = realpathSync(next);
      } catch {
        return null;
      }
    } else {
      cur = next;
    }
  }
  return cur;
}

const expandTilde = (p) => {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return null;
};

/** 경로를 cwd 기준으로 풀어 물리 경로로 만든다. 풀 수 없으면 null. */
export function resolvePhysical(p, cwd) {
  let target = p;
  if (target.startsWith("~")) {
    const expanded = expandTilde(target);
    if (expanded === null) return null;
    target = expanded;
  }
  const absolute = target.startsWith("/") ? target : `${cwd}/${target}`;
  return physicalPath(absolute);
}

const within = (path, roots) => roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep));

const parseRoots = (value) =>
  (value ?? "")
    .split(":")
    .filter((entry) => entry.length > 0 && entry.startsWith("/"))
    .map((entry) => physicalPath(entry))
    .filter((entry) => entry !== null);

/**
 * 세션의 도구 결과 파일(<설정 폴더>/projects/<슬러그>/<세션 id>/tool-results/<파일>)인지 판정하는 함수를 만든다.
 * 슬러그는 실행 폴더 절대 경로에서 영숫자가 아닌 문자를 모두 -로 바꾼 것이다.
 */
function toolResultsMatcher(env) {
  const never = () => false;
  const runDir = env.HEW_GUARD_RUN_DIR;
  if (typeof runDir !== "string" || !runDir.startsWith("/")) return never;
  const configured = env.CLAUDE_CONFIG_DIR;
  const configDir = configured === undefined || configured.length === 0 ? join(homedir(), ".claude") : configured;
  if (!configDir.startsWith("/")) return never;
  const configReal = physicalPath(configDir);
  if (configReal === null) return never;
  const runVariants = new Set([resolve(runDir)]);
  const runReal = physicalPath(runDir);
  if (runReal !== null) runVariants.add(runReal);
  const prefixes = [...runVariants].map((dir) => `${join(configReal, "projects", dir.replace(/[^A-Za-z0-9]/g, "-"))}/`);
  return (real) => {
    if (/[*?[\]]/.test(real)) return false;
    for (const prefix of prefixes) {
      if (!real.startsWith(prefix)) continue;
      const parts = real.slice(prefix.length).split("/");
      if (parts.length === 3 && SESSION_ID.test(parts[0]) && parts[1] === "tool-results" && parts[2].length > 0) return true;
    }
    return false;
  };
}

function checkRead(p, cwd, roots, label, allowToolResults = false) {
  const real = resolvePhysical(p, cwd);
  if (real === null) deny(`${label} 경로를 확인할 수 없습니다: ${p}`);
  if (within(real, roots.read)) return;
  if (allowToolResults && roots.isToolResult !== undefined && roots.isToolResult(real)) return;
  deny(`${label} 읽기 범위 밖입니다: ${p}`);
}

function checkWrite(p, cwd, roots, label) {
  const real = resolvePhysical(p, cwd);
  if (real === null) deny(`${label} 경로를 확인할 수 없습니다: ${p}`);
  if (!within(real, roots.write)) deny(`${label} 쓰기 범위 밖입니다: ${p}`);
}

/** 명령 문자열을 조각(단어 목록과 리다이렉트)으로 나눈다. 따옴표·연산자·치환을 검사해 허용되지 않는 구문은 거부한다. */
export function tokenize(command) {
  const segments = [];
  let seg = { words: [], redirs: [] };
  let cur = "";
  let has = false;
  let quotedAny = false;
  let pending = null;
  let prevSep = null;

  const pushWord = () => {
    if (!has) return;
    if (pending !== null) {
      seg.redirs.push({ op: pending, target: cur });
      pending = null;
    } else {
      seg.words.push(cur);
    }
    cur = "";
    has = false;
    quotedAny = false;
  };
  const endSegment = (sep) => {
    pushWord();
    if (pending !== null) deny("리다이렉트 대상이 없습니다");
    const empty = seg.words.length === 0 && seg.redirs.length === 0;
    if (empty) {
      if (sep === "|" || sep === "&&" || sep === "||" || sep === ";") deny(`연산자 ${sep} 앞에 명령이 없습니다`);
      if (prevSep === "|" || prevSep === "&&" || prevSep === "||") deny(`연산자 ${prevSep} 뒤에 명령이 없습니다`);
    } else {
      segments.push(seg);
    }
    seg = { words: [], redirs: [] };
    prevSep = sep === "\n" && empty ? prevSep : sep;
  };
  const startRedirect = (op) => {
    if (has && !quotedAny && /^\d+$/.test(cur)) {
      cur = "";
      has = false;
    } else {
      pushWord();
    }
    pending = op;
  };

  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    const code = c.charCodeAt(0);
    if (code < 0x20 && c !== "\n" && c !== "\t") deny("제어 문자가 있습니다");
    if (c === " " || c === "\t") {
      pushWord();
    } else if (c === "\n") {
      endSegment("\n");
    } else if (c === "\\") {
      const n = command[i + 1];
      if (n === undefined || n === "\n") deny("줄 끝 역슬래시는 허용되지 않습니다");
      cur += n;
      has = true;
      quotedAny = true;
      i += 1;
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) deny("작은따옴표가 닫히지 않았습니다");
      cur += command.slice(i + 1, end);
      has = true;
      quotedAny = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < command.length) {
        const d = command[j];
        if (d === '"') {
          closed = true;
          break;
        }
        if (d === "\\") {
          const n = command[j + 1];
          if (n === undefined) break;
          if ('"\\$`'.includes(n)) cur += n;
          else if (n === "\n") deny("줄 끝 역슬래시는 허용되지 않습니다");
          else cur += `\\${n}`;
          j += 2;
          continue;
        }
        if (d === "`") deny("백틱 치환은 허용되지 않습니다");
        if (d === "$") {
          const n = command[j + 1];
          if (n !== undefined && n !== '"' && !/\s/.test(n)) deny("변수·치환 참조는 허용되지 않습니다");
        }
        cur += d;
        j += 1;
      }
      if (!closed) deny("큰따옴표가 닫히지 않았습니다");
      has = true;
      quotedAny = true;
      i = j;
    } else if (c === "|") {
      if (command[i + 1] === "&") deny("|& 는 허용되지 않습니다");
      if (command[i + 1] === "|") {
        i += 1;
        endSegment("||");
      } else endSegment("|");
    } else if (c === "&") {
      if (command[i + 1] === "&") {
        i += 1;
        endSegment("&&");
      } else if (command[i + 1] === ">") {
        i += 1;
        let op = "&>";
        if (command[i + 1] === ">") {
          i += 1;
          op = "&>>";
        }
        startRedirect(op);
      } else deny("백그라운드 실행(&)은 허용되지 않습니다");
    } else if (c === ";") {
      if (command[i + 1] === ";") deny(";; 는 허용되지 않습니다");
      endSegment(";");
    } else if (c === "(" || c === ")" || c === "{" || c === "}") {
      deny(`쉘 구문 ${c} 는 허용되지 않습니다`);
    } else if (c === "`") {
      deny("백틱 치환은 허용되지 않습니다");
    } else if (c === "$") {
      const n = command[i + 1];
      if (n !== undefined && !/\s/.test(n)) deny("변수·치환 참조는 허용되지 않습니다");
      cur += c;
      has = true;
    } else if (c === "<") {
      const n = command[i + 1];
      if (n === "(" || n === "<" || n === "&" || n === ">") deny("허용되지 않는 입력 리다이렉트입니다");
      startRedirect("<");
    } else if (c === ">") {
      const n = command[i + 1];
      if (n === "(") deny(">( 는 허용되지 않습니다");
      let op = ">";
      if (n === ">") {
        i += 1;
        op = ">>";
      } else if (n === "|") {
        i += 1;
      } else if (n === "&") {
        const m = /^&(\d+|-)/.exec(command.slice(i + 1));
        if (m === null) deny("허용되지 않는 >& 리다이렉트입니다");
        if (has && !quotedAny && /^\d+$/.test(cur)) {
          cur = "";
          has = false;
        } else pushWord();
        i += m[0].length;
        continue;
      }
      startRedirect(op);
    } else if (c === "#" && !has) {
      deny("주석(#)은 허용되지 않습니다");
    } else {
      cur += c;
      has = true;
    }
  }
  endSegment("end");
  if (segments.length === 0) deny("명령이 비어 있습니다");
  return segments;
}

const isPathLike = (word) => word.startsWith("/") || word.startsWith("~") || word.includes("/") || word === "..";

/** 인자 하나의 경로 검사. 경로로 보이면 읽기 범위, 이미 있는 심볼릭 링크 이름이면 그 링크의 도착지를 본다. */
function checkArg(word, base, roots) {
  const candidates = [];
  if (word.startsWith("-")) {
    const eq = word.indexOf("=");
    if (eq >= 0) candidates.push(word.slice(eq + 1));
    const attached = /^-[^-/=~]*([/~].*)$/.exec(word);
    if (attached !== null) candidates.push(attached[1]);
  } else {
    candidates.push(word);
  }
  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    if (isPathLike(candidate)) {
      if (/[*?[]/.test(candidate) && candidate.split("/").includes("..")) deny(`'..' 와 와일드카드를 함께 쓴 경로는 허용되지 않습니다: ${candidate}`);
      checkRead(candidate, base, roots, "인자의", true);
    } else if (!candidate.startsWith("-")) {
      const absolute = `${base}/${candidate}`;
      let stat = null;
      try {
        stat = lstatSync(absolute);
      } catch {
        stat = null;
      }
      if (stat !== null && stat.isSymbolicLink()) checkRead(candidate, base, roots, "인자의 링크", true);
    }
  }
}

const sameRealPath = (a, b, cwd) => {
  const pa = resolvePhysical(a, cwd);
  const pb = resolvePhysical(b, cwd);
  return pa !== null && pb !== null && pa === pb;
};

function isHewCommand(first, ctx) {
  const bin = ctx.hewBin;
  if (bin === undefined || bin.length === 0) return false;
  if (first === bin) return true;
  return basename(first) === "hew" && first.includes("/") && sameRealPath(first, bin, ctx.cwd);
}

function checkHew(args, ctx) {
  let index = 0;
  while (args[index] === "--json") index += 1;
  const sub = args[index];
  if (sub === undefined || !HEW_SUBCOMMANDS.has(sub)) deny(`hew 하위 명령이 허용되지 않습니다: ${sub ?? "(없음)"}`);
  const sourceSubs = ctx.collector ? COLLECTOR_SOURCE_SUBCOMMANDS : HEW_SOURCE_SUBCOMMANDS;
  if (sub === "source" && !sourceSubs.has(args[index + 1] ?? "")) deny(`hew source 는 ${[...sourceSubs].join("·")} 만 허용됩니다`);
  if (sub === "sasu" && !HEW_SASU_SUBCOMMANDS.has(args[index + 1] ?? "")) deny(`hew sasu 는 respond 만 허용됩니다`);
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i];
    let flag = null;
    let value = null;
    const m = /^(--run|--file|--from-call)(?:=(.*))?$/.exec(word);
    if (m !== null) {
      flag = m[1];
      value = m[2] !== undefined ? m[2] : args[i + 1];
      if (m[2] === undefined) i += 1;
      if (value === undefined) deny(`${flag} 값이 없습니다`);
    }
    if (flag === "--from-call") {
      if (!(ctx.collector && sub === "source")) deny("--from-call 은 수집 프로필의 hew source 에서만 허용됩니다");
      if (!/^\d+$/.test(value)) deny(`--from-call 은 숫자여야 합니다: ${value}`);
    } else if (flag === "--run") {
      if (ctx.runDir === undefined || !sameRealPath(value, ctx.runDir, ctx.cwd)) deny(`--run 은 이 실행 폴더여야 합니다: ${value}`);
    } else if (flag === "--file") {
      checkWrite(value, ctx.cwd, ctx.roots, "--file 의");
    } else if (ctx.collector && sub === "source" && COLLECTOR_TEXT_FLAGS.test(word)) {
      if (COLLECTOR_TEXT_FLAGS.exec(word)[2] === undefined) {
        if (args[i + 1] === undefined) deny(`${word} 값이 없습니다`);
        i += 1;
      }
    } else {
      checkArg(word, ctx.cwd, ctx.roots);
    }
  }
}

/** 호스트가 허용 접미사 중 하나와 같거나 그 하위 도메인인지. */
function hostAllowed(host, suffixes) {
  const h = host.toLowerCase();
  return suffixes.some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}

/** curl 은 `curl [-s -S -L -f] [--max-time <초>] -o <쓰기 뿌리 안 경로> https://<허용 호스트>/…` 꼴만 받는다. */
function checkCurl(args, ctx) {
  let out = null;
  let url = null;
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i];
    if (word === "-o") {
      if (out !== null) deny("curl -o 는 한 번만 쓸 수 있습니다");
      out = args[i + 1];
      if (out === undefined) deny("curl -o 대상이 없습니다");
      i += 1;
    } else if (word === "--max-time") {
      const seconds = args[i + 1];
      if (seconds === undefined || !/^\d{1,3}$/.test(seconds)) deny("curl --max-time 은 초(숫자)여야 합니다");
      i += 1;
    } else if (/^-[sSLf]+$/.test(word)) {
      // 조용히·오류 표시·리다이렉트 따라가기·실패 시 종료
    } else if (word.startsWith("-")) {
      deny(`curl 옵션이 허용되지 않습니다: ${word}`);
    } else {
      if (url !== null) deny("curl 주소는 하나만 줄 수 있습니다");
      url = word;
    }
  }
  if (out === null) deny("curl 에는 -o <경로> 가 필요합니다");
  if (url === null) deny("curl 에 주소가 없습니다");
  if (out.startsWith("-")) deny(`curl -o 대상이 올바르지 않습니다: ${out}`);
  checkWrite(out, ctx.cwd, ctx.roots, "curl -o 의");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    deny(`curl 주소를 읽을 수 없습니다: ${url}`);
  }
  if (!url.startsWith("https://") || parsed.protocol !== "https:") deny(`curl 주소는 https:// 로 시작해야 합니다: ${url}`);
  if (parsed.username !== "" || parsed.password !== "") deny("curl 주소에 사용자 정보를 넣을 수 없습니다");
  if (parsed.port !== "") deny("curl 주소에 포트를 지정할 수 없습니다");
  if (!hostAllowed(parsed.hostname, ctx.curlHosts ?? DEFAULT_CURL_HOSTS)) deny(`curl 호스트가 허용 목록에 없습니다: ${parsed.hostname}`);
}

function checkGit(args, ctx) {
  let base = ctx.cwd;
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    if (args[i] === "-C") {
      const path = args[i + 1];
      if (path === undefined) deny("git -C 경로가 없습니다");
      checkRead(path, ctx.cwd, ctx.roots, "git -C 의");
      base = resolvePhysical(path, ctx.cwd) ?? ctx.cwd;
      i += 2;
    } else if (args[i] === "--no-pager") {
      i += 1;
    } else {
      deny(`git 전역 옵션이 허용되지 않습니다: ${args[i]}`);
    }
  }
  const sub = args[i];
  if (sub === undefined || !GIT_SUBCOMMANDS.has(sub)) deny(`git 하위 명령이 허용되지 않습니다: ${sub ?? "(없음)"}`);
  const rest = args.slice(i + 1);
  for (const word of rest) {
    for (const forbidden of GIT_FORBIDDEN_FLAGS) {
      if (word === forbidden || word.startsWith(`${forbidden}=`)) deny(`git 옵션이 허용되지 않습니다: ${word}`);
    }
    if (sub === "grep" && (word === "-O" || word.startsWith("-O"))) deny("git grep -O 는 허용되지 않습니다");
  }
  if (sub === "branch") {
    const hasList = rest.includes("--list") || rest.includes("-l");
    for (const word of rest) {
      if (word.startsWith("-")) {
        if (!GIT_BRANCH_FLAGS.has(word) && !word.startsWith("--sort=")) deny(`git branch 옵션이 허용되지 않습니다: ${word}`);
      } else if (!hasList) {
        deny("git branch 는 인자 없이 또는 --list 와 함께만 허용됩니다");
      }
    }
  }
  for (const word of rest) checkArg(word, base, ctx.roots);
}

/** sips 인자 중 입력 파일로 볼 단어를 모은다. 경로 모양이거나 작업 디렉터리에 실제로 있는 이름만 파일로 본다. */
function sipsInputFiles(args, ctx) {
  const files = [];
  for (const word of args) {
    if (word.startsWith("-") || /^\d+(\.\d+)?$/.test(word)) continue;
    if (isPathLike(word)) {
      files.push(word);
      continue;
    }
    try {
      lstatSync(`${ctx.cwd}/${word}`);
      files.push(word);
    } catch {
      // 파일이 아닌 옵션 값(png, horizontal 등)
    }
  }
  return files;
}

function checkSips(args, ctx) {
  let out = null;
  const flags = [];
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i];
    if (word === "--out" || word === "-o") {
      out = args[i + 1];
      if (out === undefined) deny("sips --out 대상이 없습니다");
      i += 1;
    } else if (word.startsWith("--out=")) {
      out = word.slice(6);
    } else if (word.startsWith("-")) {
      flags.push(word);
    }
  }
  if (out === null) {
    const bad = flags.filter((f) => !SIPS_READ_FLAGS.has(f));
    if (bad.length > 0) {
      // --out 없이 바꾸려면 입력 파일이 모두 쓰기 뿌리 안이어야 한다.
      const files = sipsInputFiles(args, ctx);
      if (files.length === 0) deny(`sips 는 --out 없이 원본을 바꿀 수 없습니다: ${bad.join(" ")}`);
      for (const file of files) checkWrite(file, ctx.cwd, ctx.roots, "sips 제자리 변경 대상의");
    }
  } else {
    checkWrite(out, ctx.cwd, ctx.roots, "sips --out 의");
  }
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i];
    if (word === "--out" || word === "-o") {
      i += 1;
      continue;
    }
    if (word.startsWith("--out=")) continue;
    checkArg(word, ctx.cwd, ctx.roots);
  }
}

/** mkdir 은 -p 만 받고, 모든 경로가 쓰기 뿌리 안이어야 한다. */
function checkMkdir(args, ctx) {
  const paths = [];
  for (const word of args) {
    if (word === "-p") continue;
    if (word.startsWith("-")) deny(`mkdir 옵션이 허용되지 않습니다: ${word}`);
    paths.push(word);
  }
  if (paths.length === 0) deny("mkdir 에 경로가 없습니다");
  for (const path of paths) checkWrite(path, ctx.cwd, ctx.roots, "mkdir 대상의");
}

/** sed 는 -n 과 줄 번호·범위·p 로만 된 스크립트만 받는다. 경로 검사에서 뺄 스크립트 위치를 돌려준다. */
function checkSed(args) {
  const skip = new Set();
  const scripts = [];
  const positional = [];
  let hasN = false;
  let viaE = false;
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i];
    if (word === "-" || !word.startsWith("-")) {
      positional.push(i);
      continue;
    }
    if (!/^-[nEe]+$/.test(word) || word.slice(1, -1).includes("e")) deny(`sed 옵션이 허용되지 않습니다: ${word}`);
    if (word.includes("n")) hasN = true;
    if (word.endsWith("e")) {
      if (i + 1 >= args.length) deny("sed -e 스크립트가 없습니다");
      viaE = true;
      scripts.push(i + 1);
      skip.add(i + 1);
      i += 1;
    }
  }
  if (!hasN) deny("sed 는 -n 과 함께만 허용됩니다");
  if (!viaE) {
    if (positional.length === 0) deny("sed 스크립트가 없습니다");
    scripts.push(positional[0]);
    skip.add(positional[0]);
  }
  for (const index of scripts) {
    if (!SED_SCRIPT.test(args[index])) deny(`sed 스크립트가 허용되지 않습니다: ${args[index]}`);
  }
  return skip;
}

/** rg·grep 인자에서 검색 패턴인 단어의 위치를 모은다. 앞선 옵션을 모두 알아볼 수 있을 때만 첫 비옵션 인자를 패턴으로 본다. */
function patternIndexes(args, spec) {
  const found = new Set();
  let sure = true;
  let havePatternOption = false;
  let noPattern = false;
  let afterDashes = false;
  let firstPositional = -1;
  let sureAtFirst = false;
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i];
    if (afterDashes || !word.startsWith("-") || word === "-") {
      if (firstPositional < 0) {
        firstPositional = i;
        sureAtFirst = sure;
      }
      continue;
    }
    if (word === "--") {
      afterDashes = true;
      continue;
    }
    if (word.startsWith("--")) {
      const eq = word.indexOf("=");
      const name = eq >= 0 ? word.slice(0, eq) : word;
      if (name === "--regexp") {
        havePatternOption = true;
        if (eq >= 0) {
          if (sure) found.add(i);
        } else if (i + 1 < args.length) {
          if (sure) found.add(i + 1);
          i += 1;
        }
        continue;
      }
      if (name === "--file") havePatternOption = true;
      if (spec.noPattern.has(name)) noPattern = true;
      if (eq >= 0) continue;
      if (spec.longValue.has(name)) {
        i += 1;
        continue;
      }
      if (!spec.longFlag.has(name)) sure = false;
      continue;
    }
    for (let k = 1; k < word.length; k += 1) {
      const letter = word[k];
      if (spec.shortValue.has(letter)) {
        const attached = k + 1 < word.length;
        if (letter === "e") {
          havePatternOption = true;
          if (attached) {
            if (sure) found.add(i);
          } else if (i + 1 < args.length && sure) {
            found.add(i + 1);
          }
        } else if (letter === "f") {
          havePatternOption = true;
        }
        if (!attached) i += 1;
        break;
      }
      if (!spec.shortFlag.has(letter)) {
        sure = false;
        break;
      }
    }
  }
  if (!havePatternOption && !noPattern && firstPositional >= 0 && sureAtFirst) found.add(firstPositional);
  return found;
}

/** 명령별로 경로 검사에서 뺄 인자 위치(패턴·구분자 등)를 돌려준다. */
function nonPathIndexes(first, args) {
  const skip = new Set();
  if (first === "tr") {
    args.forEach((_, i) => skip.add(i));
  } else if (first === "cut") {
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "-d") {
        if (i + 1 < args.length) skip.add(i + 1);
        i += 1;
      } else if (/^-d.+$/.test(args[i])) {
        skip.add(i);
      }
    }
  } else if (first === "find") {
    for (let i = 0; i < args.length; i += 1) {
      if (FIND_PATTERN_OPTIONS.has(args[i]) && i + 1 < args.length) {
        skip.add(i + 1);
        i += 1;
      }
    }
  } else if (first === "sed") {
    return checkSed(args);
  } else if (first === "rg" || first === "grep") {
    return patternIndexes(args, PATTERN_SPECS[first]);
  }
  return skip;
}

function checkSimple(first, args, ctx) {
  if (first === "find") {
    for (const word of args) if (FIND_FORBIDDEN.test(word)) deny(`find 옵션이 허용되지 않습니다: ${word}`);
  }
  if (first === "rg") {
    for (const word of args) {
      if (/^--(pre|pre-glob|hostname-bin)(=|$)/.test(word) || word === "-z" || word === "--search-zip") deny(`rg 옵션이 허용되지 않습니다: ${word}`);
    }
  }
  if (first === "sort") {
    for (const word of args) {
      if (word === "--output" || word.startsWith("--output=") || word.startsWith("--compress-program") || /^-[A-Za-z]*o/.test(word)) {
        deny(`sort 옵션이 허용되지 않습니다: ${word}`);
      }
    }
  }
  if (first === "uniq" && args.filter((w) => !w.startsWith("-")).length > 1) deny("uniq 는 출력 파일 인자를 받을 수 없습니다");
  if (first === "file" && args.some((w) => w === "-C" || w === "--compile")) deny("file -C 는 허용되지 않습니다");
  if (first === "jq" && args.some((w) => /(^|[^A-Za-z0-9_])(env|ENV|input_filename)([^A-Za-z0-9_]|$)/.test(w) && !w.startsWith("/"))) {
    deny("jq 에서 환경 변수·입력 파일명 접근은 허용되지 않습니다");
  }
  if (first === "jq" && args.some((w) => /(^|[^A-Za-z0-9_])(import|include)([^A-Za-z0-9_]|$)/.test(w))) deny("jq 모듈 불러오기는 허용되지 않습니다");
  const skip = nonPathIndexes(first, args);
  args.forEach((word, i) => {
    if (!skip.has(i)) checkArg(word, ctx.cwd, ctx.roots);
  });
}

function checkSegment(seg, ctx) {
  if (seg.words.length === 0) deny("명령 없이 리다이렉트만 있습니다");
  const first = seg.words[0];
  const args = seg.words.slice(1);
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) deny("환경 변수 대입으로 시작하는 조각은 허용되지 않습니다");
  if (FORBIDDEN_FIRST.has(first)) deny(`명령이 허용되지 않습니다: ${first}`);
  for (const redir of seg.redirs) {
    if (redir.op === "<") {
      checkRead(redir.target, ctx.cwd, ctx.roots, "입력 리다이렉트 대상의");
    } else if (redir.target !== "/dev/null") {
      checkWrite(redir.target, ctx.cwd, ctx.roots, "출력 리다이렉트 대상의");
    }
  }
  if (isHewCommand(first, ctx)) return checkHew(args, ctx);
  if (first === "curl" && ctx.collector) return checkCurl(args, ctx);
  if (!ALLOWED_COMMANDS.has(first)) deny(`허용되지 않는 명령입니다: ${first}`);
  if (first === "git") return checkGit(args, ctx);
  if (first === "sips") return checkSips(args, ctx);
  if (first === "mkdir") return checkMkdir(args, ctx);
  return checkSimple(first, args, ctx);
}

function checkBash(input, cwd, roots, env) {
  const command = input.command;
  if (typeof command !== "string" || command.trim().length === 0) deny("Bash 명령이 비어 있습니다");
  const realCwd = physicalPath(cwd);
  if (realCwd === null || !within(realCwd, roots.read)) deny(`작업 디렉터리가 읽기 범위 밖입니다: ${cwd}`);
  const curlHosts = splitList(env.HEW_GUARD_CURL_HOSTS);
  let ctx = {
    cwd: realCwd,
    roots,
    hewBin: env.HEW_GUARD_HEW_BIN,
    runDir: env.HEW_GUARD_RUN_DIR,
    collector: isCollector(env),
    curlHosts: curlHosts.length > 0 ? curlHosts : undefined,
  };
  let movedByCd = false;
  tokenize(command).forEach((seg, index) => {
    if (seg.words[0] === "cd") {
      // cd 는 맨 앞 조각에서 읽기 범위 안의 경로 하나로만 받고, 뒤 조각의 상대 경로는 그 자리 기준으로 푼다.
      if (index !== 0) deny("cd 는 명령의 맨 앞에서만 쓸 수 있습니다");
      if (seg.words.length !== 2 || seg.redirs.length > 0) deny("cd 에는 경로 하나만 줄 수 있습니다");
      checkRead(seg.words[1], ctx.cwd, roots, "cd 대상의");
      const target = physicalPath(resolve(ctx.cwd, seg.words[1]));
      if (target === null || !within(target, roots.read)) deny(`cd 대상이 읽기 범위 밖입니다: ${seg.words[1]}`);
      ctx = { ...ctx, cwd: target };
      movedByCd = true;
      return;
    }
    if (movedByCd && seg.words.some((word) => word.includes(".."))) deny("cd 뒤에는 .. 가 든 인자를 쓸 수 없습니다");
    checkSegment(seg, ctx);
  });
}

const isCollector = (env) => env.HEW_GUARD_PROFILE === "collector";

const splitList = (value) =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

/** 값 안의 모든 글(키 이름과 문자열 값)을 줄바꿈으로 이어 붙인다. */
function leafText(value, depth = 0) {
  if (depth > 12) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => leafText(v, depth + 1)).join("\n");
  if (value !== null && typeof value === "object") {
    return Object.entries(value).map(([k, v]) => `${k}\n${leafText(v, depth + 1)}`).join("\n");
  }
  return value === undefined || value === null ? "" : String(value);
}

function hasSearchKey(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((v) => hasSearchKey(v, depth + 1));
  return Object.entries(value).some(([k, v]) => SEARCH_KEYS.test(k) || hasSearchKey(v, depth + 1));
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 수집 프로필의 MCP 도구 판정: 허용 목록(이름 전체 일치), 차단된 Jira 키, replay·shadow 의 검색 금지. */
function checkMcp(tool, input, env) {
  const patterns = splitList(env.HEW_GUARD_MCP_ALLOW);
  const entries = patterns.length > 0 ? patterns : DEFAULT_MCP_ALLOW;
  const allowed = entries.some((entry) => {
    try {
      return new RegExp(`^(?:${entry})$`).test(tool);
    } catch {
      return false;
    }
  });
  if (!allowed) deny(`허용 목록에 없는 MCP 도구입니다: ${tool}`);

  const rawBlock = env.HEW_GUARD_BLOCK;
  if (rawBlock !== undefined && rawBlock.length > 0) {
    let block;
    try {
      block = JSON.parse(rawBlock);
    } catch {
      deny("HEW_GUARD_BLOCK 을 읽을 수 없어 거부합니다");
    }
    const keys = Array.isArray(block?.jira_keys) ? block.jira_keys.filter((k) => typeof k === "string" && k.length > 0) : [];
    const texts = [JSON.stringify(input ?? {}), leafText(input)];
    for (const key of keys) {
      const re = new RegExp(`\\b${escapeRegExp(key)}\\b`, "i");
      if (texts.some((text) => re.test(text))) deny(`차단된 Jira 키가 입력에 있습니다: ${key}`);
    }
  }

  const mode = env.HEW_GUARD_MODE;
  if ((mode === "replay" || mode === "shadow") && /__executeRead$/.test(tool)) {
    const name = input?.name;
    if (typeof name !== "string" || !READ_ONLY_OPERATIONS.has(name)) deny(`${mode} 에서 executeRead 는 지정한 문서·버전 조회만 허용됩니다: ${String(name)}`);
    if (hasSearchKey(input)) deny(`${mode} 에서 검색(jql·cql 등)은 허용되지 않습니다`);
  }
}

/** 훅 입력과 환경 변수로 판정을 낸다. { decision: "allow"|"deny", reason } */
export function decide(payload, env = process.env) {
  try {
    const roots = { read: parseRoots(env.HEW_GUARD_READ_ROOTS), write: parseRoots(env.HEW_GUARD_WRITE_ROOTS), isToolResult: toolResultsMatcher(env) };
    const tool = payload?.tool_name;
    const input = payload?.tool_input ?? {};
    const cwd = typeof payload?.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : process.cwd();
    if (tool === "Read") {
      if (typeof input.file_path !== "string") deny("Read 에 file_path 가 없습니다");
      checkRead(input.file_path, cwd, roots, "Read 대상의", true);
    } else if (tool === "Write" || tool === "Edit") {
      if (typeof input.file_path !== "string") deny(`${tool} 에 file_path 가 없습니다`);
      checkWrite(input.file_path, cwd, roots, `${tool} 대상의`);
    } else if (tool === "NotebookEdit") {
      if (typeof input.notebook_path !== "string") deny("NotebookEdit 에 notebook_path 가 없습니다");
      checkWrite(input.notebook_path, cwd, roots, "NotebookEdit 대상의");
    } else if (tool === "Bash") {
      checkBash(input, cwd, roots, env);
    } else if (isCollector(env) && tool === "ToolSearch") {
      // 지연 도구의 이름을 찾는 일이라 입력은 보지 않는다
    } else if (isCollector(env) && typeof tool === "string" && tool.startsWith("mcp__")) {
      checkMcp(tool, input, env);
    } else {
      deny(`허용되지 않는 도구입니다: ${String(tool)}`);
    }
    return { decision: "allow", reason: "범위 안" };
  } catch (error) {
    if (error instanceof Deny) return { decision: "deny", reason: error.message };
    return { decision: "deny", reason: `판단할 수 없어 거부합니다: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function readStdin() {
  return new Promise((done) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => done(""));
  });
}

async function main() {
  const text = await readStdin();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  const verdict = payload === null ? { decision: "deny", reason: "훅 입력을 읽을 수 없습니다" } : decide(payload, process.env);
  const logPath = process.env.HEW_GUARD_LOG;
  if (logPath) {
    try {
      appendFileSync(
        logPath,
        `${JSON.stringify({ ts: new Date().toISOString(), tool: payload?.tool_name ?? null, input: payload?.tool_input ?? null, decision: verdict.decision, reason: verdict.reason })}\n`,
        "utf8",
      );
    } catch {
      // 로그를 못 써도 판정은 낸다
    }
  }
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: verdict.decision, permissionDecisionReason: verdict.reason } })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
