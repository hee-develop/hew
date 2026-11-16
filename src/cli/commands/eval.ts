/** hew eval 명령 등록: 결함 주입 평가(주입, 사수 1회차, 채점, 일괄 주입). */
import { resolve } from "node:path";
import type { Command } from "commander";
import { usageError } from "../../core/errors.js";
import { injectAll, injectDefect } from "../../core/eval/inject.js";
import { EVAL_KINDS, isEvalKind } from "../../core/eval/kinds.js";
import { parseCodes, runEvalSasu } from "../../core/eval/sasu.js";
import { formatTable, scoreRuns, writeMarkdown } from "../../core/eval/score.js";
import { runActionAsync, runAction } from "./run-action.js";

const toInt = (flag: string, text: string | undefined, fallback: number): number => {
  if (text === undefined) return fallback;
  const n = Number(text);
  if (!Number.isInteger(n)) throw usageError(`${flag} 는 정수여야 합니다: ${text}`);
  return n;
};

export function register(program: Command): void {
  const evalCommand = program.command("eval").description("결함 주입 평가 명령");
  evalCommand
    .command("inject")
    .description("원본 실행을 새 실행 폴더로 복사하고 분석 문서에 결함 하나를 심는다(모드 shadow)")
    .requiredOption("--run <폴더|id>", "원본 실행 폴더 경로 또는 run_id")
    .requiredOption("--kind <종류>", EVAL_KINDS.join("|"))
    .option("--seed <n>", "후보를 고르는 시드(기본 1)")
    .option("--out-id <run_id>", "새 실행의 run_id(기본 <원본>-inj-<종류>-<seed>)")
    .action((options: { run: string; kind: string; seed?: string; outId?: string }, command: Command) =>
      runAction(command, () => {
        if (!isEvalKind(options.kind)) throw usageError(`--kind 는 ${EVAL_KINDS.join("|")} 중 하나여야 합니다: ${options.kind}`);
        const r = injectDefect({ source: options.run, kind: options.kind, seed: toInt("--seed", options.seed, 1), outId: options.outId });
        return {
          data: r,
          text: `결함을 심은 실행을 만들었습니다: ${r.run_id}(${r.dir})\n- 종류 ${r.kind}, 시드 ${r.seed}, 후보 ${r.candidates}개 중 하나\n- 잡아야 하는 단위: ${r.expected}\n- 변형 뒤 거부 코드: ${r.checks_after.length > 0 ? r.checks_after.join(", ") : "없음"}`,
        };
      }),
    );
  evalCommand
    .command("inject-all")
    .description("종류 6개 × n 개(시드 시작값부터 연속)의 주입 실행을 한꺼번에 만든다(중복·후보 없음은 건너뛴다)")
    .requiredOption("--run <폴더|id>", "원본 실행 폴더 경로 또는 run_id")
    .option("--per-kind <n>", "종류마다 만들 개수(기본 3)")
    .option("--seed <시작>", "시작 시드(기본 1)")
    .action((options: { run: string; perKind?: string; seed?: string }, command: Command) =>
      runAction(command, () => {
        const r = injectAll({ source: options.run, perKind: toInt("--per-kind", options.perKind, 3), seed: toInt("--seed", options.seed, 1) });
        const lines = [`주입 실행 ${r.runs.length}개를 만들었고 ${r.skipped.length}개를 건너뛰었습니다`];
        for (const x of r.runs) lines.push(`- ${x.run_id} (${x.kind}, 시드 ${x.seed}, 잡아야 하는 단위 ${x.expected})`);
        for (const x of r.skipped) lines.push(`- 건너뜀 ${x.kind} 시드 ${x.seed}: ${x.reason}`);
        return { data: r, text: lines.join("\n") };
      }),
    );
  evalCommand
    .command("sasu")
    .description("주입 실행에서 사수 1회차만 돌리고 심은 결함을 잡았는지 채점한다(회차 완료 처리는 하지 않는다)")
    .requiredOption("--run <폴더|id>", "주입 실행 폴더 경로 또는 run_id")
    .option("--codes <W2,W3,…>", "돌릴 작업 단위 종류(기본: expected 의 종류)")
    .option("--max-steps <n>", "띄우는 횟수 상한(기본 40)")
    .action((options: { run: string; codes?: string; maxSteps?: string }, command: Command) =>
      runActionAsync(command, async () => {
        const timeoutEnv = process.env.HEW_RUN_TIMEOUT_MS;
        const r = await runEvalSasu({
          run: options.run,
          codes: options.codes === undefined ? undefined : parseCodes(options.codes),
          maxSteps: options.maxSteps === undefined ? undefined : toInt("--max-steps", options.maxSteps, 40),
          timeoutMs: timeoutEnv !== undefined && timeoutEnv.length > 0 ? Number(timeoutEnv) : undefined,
        });
        const verdict = r.caught ? "잡음" : r.caught_any ? "근거 없이만 지적함" : "못 잡음";
        return {
          data: r,
          text: `${r.expected}: ${verdict}(단위 ${r.units}개, 다른 단위 지적 ${r.other_issues.count}건, 비용 ${r.cost_usd.toFixed(4)} USD)`,
        };
      }),
    );
  evalCommand
    .command("score")
    .description("주입 실행들의 eval/result.json 을 모아 종류별 포착률 표를 낸다")
    .option("--runs <id,id,…>", "채점할 주입 실행들")
    .option("--source <폴더|id>", "그 원본 실행에서 나온 주입 실행 전부")
    .option("--out <파일>", "Markdown 표로 저장한다")
    .action((options: { runs?: string; source?: string; out?: string }, command: Command) =>
      runAction(command, () => {
        const runs = options.runs?.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        const r = scoreRuns({ runs, source: options.source });
        if (options.out !== undefined) writeMarkdown(resolve(options.out), r.rows);
        const text = r.rows.length === 0 ? "집계할 결과가 없습니다" : formatTable(r.rows);
        const tail = [
          r.without_result.length > 0 ? `결과가 아직 없는 실행: ${r.without_result.join(", ")}` : null,
          options.out !== undefined ? `Markdown 표를 저장했습니다: ${resolve(options.out)}` : null,
        ].filter((x): x is string => x !== null);
        return { data: r, text: [text, ...tail].join("\n") };
      }),
    );
}
