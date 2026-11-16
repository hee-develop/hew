// 테스트용 가짜 claude. FAKE_CLAUDE_MODE: submit | noop | fail_once | timeout | sasu_ok | sasu_issue_first | tm_respond | collect | by_role
// collect 는 패킷의 수집 계획대로 hew source add(--from-call 또는 --file)·fail·done 을 부른다. FAKE_CLAUDE_CALLS(JSON: { <kind>: <호출 번호> })에 없는 kind 는 두 번 실패로 남긴다.
// tm_respond 는 반송 패킷 표의 모든 지적 id 에 response(기본 rejected)로 답한 뒤 doc 을 제출한다.
// by_role 은 FAKE_CLAUDE_PLAN(JSON: { <역할>: [{ mode, doc?, action?, response? }, ...] })에서 그 역할의 몇 번째 호출인지에 따라 동작을 고른다.
import { execSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.FAKE_CLAUDE_MODE ?? "submit";
const logDir = process.env.FAKE_CLAUDE_LOG;
const argv = process.argv.slice(2);
const role = (argv[argv.indexOf("--agent") + 1] ?? "").replace(/^hew:/, "");

let call = 1;
if (logDir) {
  mkdirSync(logDir, { recursive: true });
  call = readdirSync(logDir).filter((n) => n.startsWith("call-")).length + 1;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("HEW_")));
  writeFileSync(join(logDir, `call-${call}.json`), JSON.stringify({ argv, role, cwd: process.cwd(), env }, null, 2));
}

const result = (extra = {}) =>
  JSON.stringify({ type: "result", total_cost_usd: 0.0123, num_turns: 3, session_id: `sess-${call}`, is_error: false, duration_ms: 1234, result: "완료", ...extra });

function readPacket() {
  const prompt = argv[argv.indexOf("-p") + 1] ?? "";
  const packetPath = prompt.split("를 읽고")[0];
  const packet = readFileSync(packetPath, "utf8");
  const command = /```sh\n(.+)\n```/.exec(packet)?.[1];
  if (!command) throw new Error("패킷에 제출 명령이 없습니다");
  const file = /--file (\S+)/.exec(command)?.[1];
  if (!file) throw new Error("제출 파일이 없습니다");
  return { packet, command, file };
}

function submitFromPacket(doc) {
  const { command, file } = readPacket();
  if (!doc) throw new Error("제출할 문서(FAKE_CLAUDE_DOC)가 없습니다");
  mkdirSync(join(file, ".."), { recursive: true });
  copyFileSync(doc, file);
  execSync(command, { stdio: "ignore" });
}

/** 패킷의 지적 표에 있는 모든 id 에 답변을 내고(hew sasu respond), 이어서 doc 을 제출한다. */
function respondThenSubmit(response, doc) {
  const { packet } = readPacket();
  const command = /`([^`]*sasu respond[^`]*--file[^`]*)`/.exec(packet)?.[1];
  if (!command) throw new Error("패킷에 답변 명령이 없습니다");
  const file = /--file (\S+)/.exec(command)?.[1];
  if (!file) throw new Error("답변 파일이 없습니다");
  const ids = [...packet.matchAll(/^\| (F-\d+(?:, F-\d+)*) \|/gm)].flatMap((m) => m[1].split(", "));
  const responses = ids.map((finding) => ({ finding, response, reason: "가짜 테크니컬 매니저가 낸 이유" }));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ responses }));
  execSync(command, { stdio: "ignore" });
  submitFromPacket(doc);
}

/** 수집 패킷의 계획을 따라 항목을 등록한다. 계획이 빌 때까지(최대 10바퀴) 되풀이하고 done 을 부른다. */
function collectFromPacket() {
  const prompt = argv[argv.indexOf("-p") + 1] ?? "";
  const packet = readFileSync(prompt.split("를 읽고")[0], "utf8");
  const found = /`(\S+) --json source plan --run (\S+)`/.exec(packet);
  const workDir = /작업 폴더\(여기에만 쓸 수 있다\): `([^`]+)`/.exec(packet)?.[1];
  if (!found || !workDir) throw new Error("패킷에 수집 명령이나 작업 폴더가 없습니다");
  const [, hew, runDir] = found;
  const calls = JSON.parse(process.env.FAKE_CLAUDE_CALLS ?? "{}");
  const hewJson = (...args) => {
    const r = spawnSync(hew, ["--json", ...args], { encoding: "utf8" });
    return { status: r.status, body: r.stdout.trim() === "" ? null : JSON.parse(r.stdout) };
  };
  for (let round = 0; round < 10; round += 1) {
    const items = (hewJson("source", "plan", "--run", runDir).body?.data.items ?? []).filter((i) => i.skip !== true);
    if (items.length === 0) break;
    for (const item of items) {
      const r = item.register;
      const args = ["source", "add", "--run", runDir, "--kind", r.kind, "--ref", r.ref];
      if (r.version) args.push("--version", r.version);
      if (r.node) args.push("--node", r.node);
      if (r.kind === "figma_shot") {
        const file = join(workDir, "shots", `${r.node.replace(":", "-")}.png`);
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, ...Buffer.from(r.node)]));
        args.push("--file", file);
      } else if (calls[r.kind] !== undefined) {
        args.push("--from-call", String(calls[r.kind]));
      } else {
        for (let i = 0; i < 2; i += 1) hewJson("source", "fail", "--run", runDir, "--item", item.id, "--reason", "가짜 수집이 가져오지 못함");
        continue;
      }
      hewJson(...args);
    }
  }
  hewJson("source", "done", "--run", runDir);
}

const KIND_BY_CODE = { W2: "unsupported", W3: "missing", W4: "false_confirmed", W5: "ai_only_behavior", W6: "operator_row", W7: "visual_unlisted", W8: "bad_pairing", W9: "already_answered", T1: "ticket_missing_context" };

function firstLeaf(value) {
  if (typeof value === "string") return value.trim().length >= 2 ? value : null;
  if (Array.isArray(value)) for (const v of value) { const r = firstLeaf(v); if (r) return r; }
  else if (value && typeof value === "object") for (const v of Object.values(value)) { const r = firstLeaf(v); if (r) return r; }
  return null;
}

/** 묶음 파일을 읽어 모든 단위에 ok 를 내고, issueFirst 면 1번 묶음의 첫 단위에는 근거 있는 issue 를 낸다. */
function submitSasu(issueFirst, action) {
  const { packet, command, file } = readPacket();
  const batchPath = /`([^`]*batch-\d+\.json)`/.exec(packet)?.[1];
  if (!batchPath) throw new Error("패킷에 묶음 파일 경로가 없습니다");
  const batch = JSON.parse(readFileSync(batchPath, "utf8"));
  const findings = batch.units.map((u, i) => {
    const id = `F-${i + 1}`;
    if (!(issueFirst && i === 0 && batch.batch === 1)) return { id, work: u.id, verdict: "ok" };
    const quote = batch.code === "W7" ? null : firstLeaf(u.inputs);
    return {
      id,
      work: u.id,
      verdict: "issue",
      kind: KIND_BY_CODE[batch.code],
      claim: "가짜 사수가 낸 지적",
      evidence: batch.code === "W7" ? { image: u.inputs.as_is } : { quote },
      action: action ?? "fix",
    };
  });
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ findings }));
  execSync(command, { stdio: "ignore" });
}

function pickBehavior() {
  if (mode !== "by_role") return { mode, doc: process.env.FAKE_CLAUDE_DOC };
  const plan = JSON.parse(process.env.FAKE_CLAUDE_PLAN ?? "{}");
  const list = plan[role] ?? [];
  const index = logDir ? readdirSync(logDir).filter((n) => n.startsWith("call-")).map((n) => JSON.parse(readFileSync(join(logDir, n), "utf8"))).filter((c) => c.role === role).length - 1 : 0;
  return list[Math.min(index, list.length - 1)] ?? { mode: "noop" };
}

const behavior = pickBehavior();
if (behavior.mode === "timeout") {
  await new Promise((r) => setTimeout(r, 60_000));
} else if (behavior.mode === "noop") {
  process.stdout.write(result());
} else if (behavior.mode === "fail_once" && call === 1) {
  process.stderr.write("첫 시도 실패\n");
  process.exit(1);
} else {
  if (behavior.mode === "sasu_ok") submitSasu(false);
  else if (behavior.mode === "sasu_issue_first") submitSasu(true, behavior.action);
  else if (behavior.mode === "collect") collectFromPacket();
  else if (behavior.mode === "tm_respond") respondThenSubmit(behavior.response ?? "rejected", behavior.doc);
  else submitFromPacket(behavior.doc);
  process.stdout.write(result());
}
