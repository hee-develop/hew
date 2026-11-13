/** hew packet 명령 등록: 역할 패킷을 만들고 경로를 돌려준다. */
import type { Command } from "commander";
import { buildPacket } from "../../core/packet.js";
import { resolveRunDir } from "../../core/paths.js";
import { runAction } from "./run-action.js";

export function register(program: Command): void {
  program
    .command("packet")
    .description("역할 패킷(packets/<역할>-<n>.md)을 만들고 경로를 알려 준다")
    .requiredOption("--run <폴더|id>", "실행 폴더 경로 또는 run_id")
    .requiredOption("--role <역할>", "technical-manager|qa-designer|ticket-maker|manager-sasu|ticket-sasu|collector")
    .option("--purpose <목적>", "first|rework|apply_answers(생략하면 상태에서 정함)")
    .action((options: { run: string; role: string; purpose?: string }, command: Command) =>
      runAction(command, () => {
        const result = buildPacket({ runDir: resolveRunDir(options.run), role: options.role, purpose: options.purpose });
        return {
          data: { path: result.path, n: result.n, work_dir: result.workDir, role: result.role, purpose: result.purpose },
          warnings: result.warnings,
          text: result.path,
        };
      }),
    );
}
