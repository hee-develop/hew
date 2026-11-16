/** hew submit 명령 등록. */
import { resolve } from "node:path";
import type { Command } from "commander";
import { producedByFromEnv } from "../../core/envelope.js";
import { usageError } from "../../core/errors.js";
import { submitFindingsBatch } from "../../core/findings/submit.js";
import { resolveRunDir } from "../../core/paths.js";
import { SUBMIT_KINDS, submitArtifact, type SubmitKind } from "../../core/submit.js";
import { runAction } from "./run-action.js";

export function register(program: Command): void {
  program
    .command("submit <kind>")
    .description("산출물(analysis|scenarios|plan|findings)을 검증하고 정본에 쓴다")
    .requiredOption("--run <폴더|id>", "실행 폴더 경로 또는 run_id")
    .requiredOption("--file <경로>", "제출할 items JSON 파일")
    .option("--for <대상>", "findings 의 대상: analysis|plan")
    .option("--batch <k>", "분석용 findings 의 묶음 번호")
    .option("--withdraw <id,…>", "철회할 항목 id(analysis·scenarios 에서 처리)")
    .action((kind: string, options: { run: string; file: string; for?: string; batch?: string; withdraw?: string }, command: Command) =>
      runAction(command, () => {
        if (!(SUBMIT_KINDS as readonly string[]).includes(kind)) {
          throw usageError(`제출 종류는 ${SUBMIT_KINDS.join("|")} 중 하나여야 합니다: ${kind}`);
        }
        if (options.for !== undefined && options.for !== "analysis" && options.for !== "plan") {
          throw usageError(`--for 는 analysis|plan 중 하나여야 합니다: ${options.for}`);
        }
        if (options.batch !== undefined && !(kind === "findings" && options.for === "analysis")) {
          throw usageError("--batch 는 findings --for analysis 제출에만 쓸 수 있습니다");
        }
        if (kind === "findings" && options.for === "analysis") {
          const batch = Number(options.batch);
          if (options.batch === undefined || !Number.isInteger(batch) || batch < 1) {
            throw usageError("분석용 findings 제출에는 --batch <1 이상의 정수> 가 필요합니다");
          }
          const r = submitFindingsBatch({ runDir: resolveRunDir(options.run), batch, file: resolve(options.file), producedBy: producedByFromEnv() });
          const tail = r.completed !== null ? `, 회차 ${r.round} 완료: 상태 ${r.previous_state} → ${r.state}` : "";
          return {
            data: {
              kind: "findings",
              for: "analysis",
              round: r.round,
              batch: r.batch,
              path: r.path,
              units: r.units,
              issues: r.issues,
              blocking: r.blocking,
              previous_state: r.previous_state,
              state: r.state,
              completed: r.completed,
            },
            warnings: r.warnings,
            text: `findings(analysis) 회차 ${r.round} 묶음 ${r.batch} 제출이 통과했습니다: 단위 ${r.units}개, issue ${r.issues}건, 차단 ${r.blocking}건${tail}`,
          };
        }
        const result = submitArtifact({
          runDir: resolveRunDir(options.run),
          kind: kind as SubmitKind,
          file: resolve(options.file),
          for: options.for,
          withdraw: options.withdraw?.split(",").map((s) => s.trim()).filter(Boolean),
          producedBy: producedByFromEnv(),
        });
        const label = result.for ? `${result.kind}(${result.for})` : result.kind;
        return {
          data: {
            kind: result.kind,
            for: result.for,
            attempt: result.attempt,
            path: result.path,
            previous_state: result.previous_state,
            state: result.state,
            revision: result.revision,
            open: result.open,
          },
          warnings: result.warnings,
          text: `${label} ${result.attempt}회차 제출이 통과했습니다: 상태 ${result.previous_state} → ${result.state}, revision ${result.revision.slice(0, 12)}`,
        };
      }),
    );
}
