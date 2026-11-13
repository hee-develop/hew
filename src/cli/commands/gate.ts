/** hew gate 명령 등록: 게이트 페이지 생성(build)과 내보낸 답 들여오기(import). */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Command } from "commander";
import { buildGate } from "../../core/gate/build.js";
import { importAnswers } from "../../core/gate/import.js";
import { resolveRunDir } from "../../core/paths.js";
import { runAction } from "./run-action.js";

/** macOS `open` 으로 파일을 브라우저에서 연다. */
function openInBrowser(path: string): void {
  spawn("open", [path], { stdio: "ignore", detached: true }).unref();
}

export function register(program: Command): void {
  const gate = program.command("gate").description("게이트 페이지 명령");
  gate
    .command("build")
    .description("정본에서 gate/page.html 을 만든다(checked·plan_checked 에서는 게시 상태로 옮긴다)")
    .requiredOption("--run <폴더|id>", "실행 폴더 경로 또는 run_id")
    .option("--open", "만든 페이지를 브라우저로 연다(macOS)")
    .action((options: { run: string; open?: boolean }, command: Command) =>
      runAction(command, () => {
        const r = buildGate({ runDir: resolveRunDir(options.run) });
        if (options.open === true) openInBrowser(r.path);
        const move = r.rebuilt ? `상태 ${r.state} 그대로` : `상태 ${r.previous_state} → ${r.state}`;
        return {
          data: { ...r, opened: options.open === true },
          warnings: r.warnings,
          text: `게이트 페이지(${r.phase === "answer" ? "답변" : "승인"})를 만들었습니다: ${r.path} (이미지 ${r.images}개, ${move})`,
        };
      }),
    );
  gate
    .command("import")
    .description("페이지가 내보낸 답 JSON 을 doc/answers.json 에 합친다")
    .requiredOption("--run <폴더|id>", "실행 폴더 경로 또는 run_id")
    .requiredOption("--file <내보낸 JSON>", "페이지의 '답 내보내기'로 받은 파일")
    .action((options: { run: string; file: string }, command: Command) =>
      runAction(command, () => {
        const r = importAnswers({ runDir: resolveRunDir(options.run), file: resolve(options.file) });
        const applied = Object.values(r.applied).reduce((a, b) => a + b, 0);
        const reasons = Object.entries(r.skipped_by_reason).map(([k, v]) => `${k} ${v}`).join(", ");
        const skipped = r.skipped.length > 0 ? `, 건너뜀 ${r.skipped.length}건(${reasons})` : "";
        const move = r.approved ? "승인되었습니다" : r.previous_state === r.state ? `상태 ${r.state} 그대로` : `상태 ${r.previous_state} → ${r.state}`;
        return {
          data: r,
          warnings: r.warnings,
          text: `답을 들여왔습니다: 반영 ${applied}건${skipped}, 열린 항목 ${r.open}건, ${move}`,
        };
      }),
    );
}
