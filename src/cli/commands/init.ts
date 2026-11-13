/** hew init 명령 등록. */
import type { Command } from "commander";
import { initRun } from "../../core/init.js";
import { runAction } from "./run-action.js";

export function register(program: Command): void {
  program
    .command("init")
    .description("실행 폴더와 run.json 을 만든다")
    .option("--prd <url>", "PRD(Confluence) URL")
    .option("--ticket <url>", "Jira 티켓 URL")
    .option("--mode <mode>", "live|replay|shadow", "live")
    .option("--case <파일>", "replay 사례 파일 경로")
    .option("--repo <경로>", "대상 저장소 경로")
    .option("--base <브랜치>", "대상 저장소 base 브랜치")
    .option("--run-id <id>", "run_id 직접 지정")
    .option("--figma <url...>", "시안 URL(node-id 포함). PRD 본문에 링크가 없을 때 직접 지정")
    .action((options: Record<string, string | undefined> & { figma?: string[] }, command: Command) =>
      runAction(command, () => {
        const result = initRun({
          prd: options.prd,
          ticket: options.ticket,
          mode: options.mode,
          case: options.case,
          repo: options.repo,
          base: options.base,
          runId: options.runId,
          figma: options.figma,
        });
        return {
          warnings: result.warnings,
          data: { run_id: result.run_id, dir: result.dir, state: result.run.state, mode: result.run.mode },
          text: `실행 폴더를 만들었습니다: ${result.dir} (run_id: ${result.run_id}, 상태: ${result.run.state})`,
        };
      }),
    );
}
