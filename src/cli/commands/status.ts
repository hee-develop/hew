/** hew status 명령 등록. */
import type { Command } from "commander";
import { resolveRunDir } from "../../core/paths.js";
import { loadRun } from "../../core/run.js";
import { runAction } from "./run-action.js";

export function register(program: Command): void {
  program
    .command("status")
    .description("상태, revision, 열린 항목 수, 반송 회차, 제출 기록을 보여 준다")
    .requiredOption("--run <폴더|id>", "실행 폴더 경로 또는 run_id")
    .action((options: { run: string }, command: Command) =>
      runAction(command, () => {
        const dir = resolveRunDir(options.run);
        const run = loadRun(dir);
        const submitted = Object.entries(run.submissions)
          .map(([key, rec]) => `${key} ${rec.attempt}회(${rec.at})`)
          .join(", ");
        const text = [
          `run_id: ${run.run_id} (${run.mode})`,
          `상태: ${run.state}`,
          `revision: ${run.revision}`,
          `열린 항목: ${run.open}건`,
          `반송 회차: 분석 ${run.rework.analysis}, 분해안 ${run.rework.plan}`,
          `제출 기록: ${submitted.length > 0 ? submitted : "없음"}`,
        ].join("\n");
        return {
          data: {
            run_id: run.run_id,
            dir,
            mode: run.mode,
            state: run.state,
            revision: run.revision,
            open: run.open,
            rework: run.rework,
            progress: run.progress,
            submissions: run.submissions,
          },
          text,
        };
      }),
    );
}
