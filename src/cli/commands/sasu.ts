/** hew sasu 명령 등록: 사수 작업 단위와 묶음을 만들고, 지적에 대한 테크니컬 매니저의 답변을 받는다. */
import { resolve } from "node:path";
import type { Command } from "commander";
import { producedByFromEnv } from "../../core/envelope.js";
import { usageError } from "../../core/errors.js";
import { resolveRunDir } from "../../core/paths.js";
import { createPlan } from "../../core/sasu/plan.js";
import { respondToFindings } from "../../core/sasu/respond.js";
import { runAction } from "./run-action.js";

export function register(program: Command): void {
  const sasu = program.command("sasu").description("매니저 사수 명령");
  sasu
    .command("plan")
    .description("사수 작업 단위를 만들고 묶음 파일로 나눈다(다시 돌릴 단위가 없으면 회차를 바로 완료 처리한다)")
    .requiredOption("--run <폴더|id>", "실행 폴더 경로 또는 run_id")
    .requiredOption("--for <대상>", "analysis|plan")
    .action((options: { run: string; for: string }, command: Command) =>
      runAction(command, () => {
        if (options.for !== "analysis" && options.for !== "plan") throw usageError(`--for 는 analysis|plan 중 하나여야 합니다: ${options.for}`);
        const result = createPlan(resolveRunDir(options.run), options.for, new Date(), producedByFromEnv());
        const { plan } = result;
        const reused = plan.units.filter((u) => u.reuse === true).length;
        const head = `${result.created ? "사수 계획을 만들었습니다" : "이미 만들어 둔 사수 계획입니다"}: 회차 ${plan.round}, 단위 ${plan.units.length}개(재사용 ${reused}개), 묶음 ${plan.batches.length}개`;
        const tail = result.completed !== null ? `. 다시 돌릴 단위가 없어 회차를 완료했습니다: 상태 ${result.completed.previous_state} → ${result.completed.state}` : "";
        return {
          data: { created: result.created, plan, completed: result.completed },
          text: `${head}${tail}`,
        };
      }),
    );
  sasu
    .command("respond")
    .description("사수의 차단 지적마다 테크니컬 매니저의 답변(fixed|rejected|asked)을 저장한다(상태는 바꾸지 않는다)")
    .requiredOption("--run <폴더|id>", "실행 폴더 경로 또는 run_id")
    .requiredOption("--for <대상>", "analysis|plan")
    .requiredOption("--file <경로>", "답변 JSON 파일({ responses: [...] })")
    .action((options: { run: string; for: string; file: string }, command: Command) =>
      runAction(command, () => {
        if (options.for !== "analysis" && options.for !== "plan") throw usageError(`--for 는 analysis|plan 중 하나여야 합니다: ${options.for}`);
        const r = respondToFindings({ runDir: resolveRunDir(options.run), target: options.for, file: resolve(options.file) });
        return {
          data: { for: options.for, round: r.round, path: r.path, saved: r.saved, total: r.total },
          text: `회차 ${r.round} 지적에 대한 답변 ${r.saved}건을 저장했습니다(전체 ${r.total}건): ${r.path}`,
        };
      }),
    );
}
