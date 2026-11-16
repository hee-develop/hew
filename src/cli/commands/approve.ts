/** hew approve 명령 등록: revision 이 같을 때만 승인으로 잠근다. */
import type { Command } from "commander";
import { approveRun } from "../../core/gate/approve.js";
import { resolveRunDir } from "../../core/paths.js";
import { runAction } from "./run-action.js";

export function register(program: Command): void {
  program
    .command("approve")
    .description("gate_plan_review 에서 revision 이 현재 값과 같고 열린 항목이 없으면 승인으로 잠근다")
    .requiredOption("--run <폴더|id>", "실행 폴더 경로 또는 run_id")
    .requiredOption("--revision <해시>", "승인할 revision(전체 또는 앞 12자 이상)")
    .action((options: { run: string; revision: string }, command: Command) =>
      runAction(command, () => {
        const r = approveRun({ runDir: resolveRunDir(options.run), revision: options.revision, source: "cli" });
        return { data: r, text: `승인했습니다: revision ${r.revision.slice(0, 12)}, 상태 ${r.previous_state} → ${r.state}` };
      }),
    );
}
