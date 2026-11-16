#!/usr/bin/env node
/** Claude Code PreToolUse 훅: 읽기·쓰기 범위와 Bash 허용 명령을 지킨다. 판단할 수 없으면 거부한다. */
import { appendFileSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ALLOWED_COMMANDS = new Set([
  "rg", "grep", "ls", "find", "cat", "head", "tail", "wc", "jq", "sort", "uniq", "cut", "tr", "sips", "file", "stat",
  "basename", "dirname", "echo", "true", "test", "[", "git", "pwd",
]);
const GIT_SUBCOMMANDS = new Set(["log", "show", "diff", "status", "ls-files", "grep", "rev-parse", "cat-file", "blame", "branch"]);
const GIT_FORBIDDEN_FLAGS = ["--output", "--ext-diff", "--textconv", "--filters", "--open-files-in-pager", "--exec-path", "--upload-pack"];
const GIT_BRANCH_FLAGS = new Set(["--list", "-l", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--show-current", "--no-color", "--color=never"]);
const FIND_FORBIDDEN = /^-(exec|execdir|delete|ok|okdir|fprint\w*|fls)$/;
const HEW_SUBCOMMANDS = new Set(["submit", "check", "status", "next", "units", "source"]);
const HEW_SOURCE_SUBCOMMANDS = new Set(["list", "request"]);
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

function checkRead(p, cwd, roots, label) {
  const real = resolvePhysical(p, cwd);
  if (real === null) deny(`${label} 경로를 확인할 수 없습니다: ${p}`);
  if (!within(real, roots.read)) deny(`${label} 읽기 범위 밖입니다: ${p}`);
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
      checkRead(candidate, base, roots, "인자의");
    } else if (!candidate.startsWith("-")) {
      const absolute = `${base}/${candidate}`;
      let stat = null;
      try {
        stat = lstatSync(absolute);
      } catch {
        stat = null;
      }
      if (stat !== null && stat.isSymbolicLink()) checkRead(candidate, base, roots, "인자의 링크");
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
  if (sub === "source" && !HEW_SOURCE_SUBCOMMANDS.has(args[index + 1] ?? "")) deny(`hew source 는 list·request 만 허용됩니다`);
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i];
    let flag = null;
    let value = null;
    const m = /^(--run|--file)(?:=(.*))?$/.exec(word);
    if (m !== null) {
      flag = m[1];
      value = m[2] !== undefined ? m[2] : args[i + 1];
      if (m[2] === undefined) i += 1;
      if (value === undefined) deny(`${flag} 값이 없습니다`);
    }
    if (flag === "--run") {
      if (ctx.runDir === undefined || !sameRealPath(value, ctx.runDir, ctx.cwd)) deny(`--run 은 이 실행 폴더여야 합니다: ${value}`);
    } else if (flag === "--file") {
      checkWrite(value, ctx.cwd, ctx.roots, "--file 의");
    } else {
      checkArg(word, ctx.cwd, ctx.roots);
    }
  }
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
    if (bad.length > 0) deny(`sips 는 --out 없이 원본을 바꿀 수 없습니다: ${bad.join(" ")}`);
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
  for (const word of args) checkArg(word, ctx.cwd, ctx.roots);
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
  if (!ALLOWED_COMMANDS.has(first)) deny(`허용되지 않는 명령입니다: ${first}`);
  if (first === "git") return checkGit(args, ctx);
  if (first === "sips") return checkSips(args, ctx);
  return checkSimple(first, args, ctx);
}

function checkBash(input, cwd, roots, env) {
  const command = input.command;
  if (typeof command !== "string" || command.trim().length === 0) deny("Bash 명령이 비어 있습니다");
  const realCwd = physicalPath(cwd);
  if (realCwd === null || !within(realCwd, roots.read)) deny(`작업 디렉터리가 읽기 범위 밖입니다: ${cwd}`);
  let ctx = { cwd: realCwd, roots, hewBin: env.HEW_GUARD_HEW_BIN, runDir: env.HEW_GUARD_RUN_DIR };
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

/** 훅 입력과 환경 변수로 판정을 낸다. { decision: "allow"|"deny", reason } */
export function decide(payload, env = process.env) {
  try {
    const roots = { read: parseRoots(env.HEW_GUARD_READ_ROOTS), write: parseRoots(env.HEW_GUARD_WRITE_ROOTS) };
    const tool = payload?.tool_name;
    const input = payload?.tool_input ?? {};
    const cwd = typeof payload?.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : process.cwd();
    if (tool === "Read") {
      if (typeof input.file_path !== "string") deny("Read 에 file_path 가 없습니다");
      checkRead(input.file_path, cwd, roots, "Read 대상의");
    } else if (tool === "Write" || tool === "Edit") {
      if (typeof input.file_path !== "string") deny(`${tool} 에 file_path 가 없습니다`);
      checkWrite(input.file_path, cwd, roots, `${tool} 대상의`);
    } else if (tool === "NotebookEdit") {
      if (typeof input.notebook_path !== "string") deny("NotebookEdit 에 notebook_path 가 없습니다");
      checkWrite(input.notebook_path, cwd, roots, "NotebookEdit 대상의");
    } else if (tool === "Bash") {
      checkBash(input, cwd, roots, env);
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
