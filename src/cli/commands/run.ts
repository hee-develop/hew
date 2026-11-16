/** hew run 명령 등록: 사람 차례가 올 때까지 다음 역할을 띄우는 일을 되풀이한다. */
import type { Command } from "commander";
import { resolveRunDir } from "../../core/paths.js";
import { runLoop } from "../../core/runner.js";
import { usageError } from "../../core/errors.js";
import { runActionAsync } from "./run-action.js";

export function register(program: Command): void {
  program
    .command("run")
    .description("다음 역할을 띄우는 일을 사람 차례가 올 때까지 되풀이한다")
    .requiredOption("--run <폴더|id>", "실행 폴더 경로 또는 run_id")
    .option("--until <상태>", "이 상태에 닿으면 멈춘다")
    .option("--max-steps <n>", "띄우는 횟수 상한(기본 10)")
    .option("--dry", "띄우지 않고 띄울 명령만 출력한다")
    .action((options: { run: string; until?: string; maxSteps?: string; dry?: boolean }, command: Command) =>
      runActionAsync(command, async () => {
        let maxSteps: number | undefined;
        if (options.maxSteps !== undefined) {
          maxSteps = Number(options.maxSteps);
          if (!Number.isInteger(maxSteps)) throw usageError(`--max-steps 는 정수여야 합니다: ${options.maxSteps}`);
        }
        const timeoutEnv = process.env.HEW_RUN_TIMEOUT_MS;
        const result = await runLoop({
          runDir: resolveRunDir(options.run),
          until: options.until,
          maxSteps,
          dry: options.dry === true,
          timeoutMs: timeoutEnv !== undefined && timeoutEnv.length > 0 ? Number(timeoutEnv) : undefined,
        });
        const lines = [`${result.message} (상태 ${result.state}, 띄운 횟수 ${result.launches})`];
        if (result.dry !== null) {
          lines.push(JSON.stringify({ bin: result.dry.bin, args: result.dry.args, env: result.dry.env, cwd: result.dry.cwd }, null, 2));
        }
        return { data: result, text: lines.join("\n") };
      }),
    );
}
