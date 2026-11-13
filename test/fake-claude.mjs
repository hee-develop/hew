// 테스트용 가짜 claude. FAKE_CLAUDE_MODE: submit | noop | fail_once | timeout
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.FAKE_CLAUDE_MODE ?? "submit";
const logDir = process.env.FAKE_CLAUDE_LOG;
const argv = process.argv.slice(2);

let call = 1;
if (logDir) {
  mkdirSync(logDir, { recursive: true });
  call = readdirSync(logDir).filter((n) => n.startsWith("call-")).length + 1;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("HEW_")));
  writeFileSync(join(logDir, `call-${call}.json`), JSON.stringify({ argv, cwd: process.cwd(), env }, null, 2));
}

const result = (extra = {}) =>
  JSON.stringify({ type: "result", total_cost_usd: 0.0123, num_turns: 3, session_id: `sess-${call}`, is_error: false, duration_ms: 1234, result: "완료", ...extra });

function submitFromPacket() {
  const prompt = argv[argv.indexOf("-p") + 1] ?? "";
  const packetPath = prompt.split("를 읽고")[0];
  const packet = readFileSync(packetPath, "utf8");
  const command = /```sh\n(.+)\n```/.exec(packet)?.[1];
  if (!command) throw new Error("패킷에 제출 명령이 없습니다");
  const file = /--file (\S+)/.exec(command)?.[1];
  if (!file || !process.env.FAKE_CLAUDE_DOC) throw new Error("제출 파일 또는 FAKE_CLAUDE_DOC 가 없습니다");
  mkdirSync(join(file, ".."), { recursive: true });
  copyFileSync(process.env.FAKE_CLAUDE_DOC, file);
  execSync(command, { stdio: "ignore" });
}

if (mode === "timeout") {
  await new Promise((r) => setTimeout(r, 60_000));
} else if (mode === "noop") {
  process.stdout.write(result());
} else if (mode === "fail_once" && call === 1) {
  process.stderr.write("첫 시도 실패\n");
  process.exit(1);
} else {
  submitFromPacket();
  process.stdout.write(result());
}
