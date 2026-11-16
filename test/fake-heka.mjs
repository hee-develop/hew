// 테스트용 가짜 heka 명령줄 도구. FAKE_HEKA_MODE: ok | fail | long | badjson, FAKE_HEKA_LATE: 늦게 기록된 id 목록(쉼표)
const [cmd, id] = process.argv.slice(2);
const mode = process.env.FAKE_HEKA_MODE ?? "ok";
if (cmd !== "expand") process.exit(2);
if (mode === "fail") process.exit(1);
if (mode === "badjson") {
  process.stdout.write(`없음: ${id}\n`);
  process.exit(0);
}
const late = (process.env.FAKE_HEKA_LATE ?? "").split(",").filter(Boolean);
process.stdout.write(
  JSON.stringify({
    id,
    title: `제목 ${id}`,
    body: mode === "long" ? "가".repeat(3000) : `본문 ${id}`,
    recorded_at: late.includes(id) ? "2026-10-20T00:00:00.000Z" : "2026-09-01T00:00:00.000Z",
  }),
);
