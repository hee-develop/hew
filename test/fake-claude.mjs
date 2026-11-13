// 테스트용 가짜 claude. FAKE_CLAUDE_MODE: submit | noop | fail_once | timeout | sasu_ok | sasu_issue_first | by_role
// by_role 은 FAKE_CLAUDE_PLAN(JSON: { <역할>: [{ mode, doc?, action? }, ...] })에서 그 역할의 몇 번째 호출인지에 따라 동작을 고른다.
import { execSync } from "node:child_process";
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

const KIND_BY_CODE = { W2: "unsupported", W3: "missing", W4: "false_confirmed", W5: "ai_only_behavior", W6: "operator_row", W7: "visual_unlisted", W8: "bad_pairing", W9: "already_answered" };

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
  else submitFromPacket(behavior.doc);
  process.stdout.write(result());
}
