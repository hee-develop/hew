/** hew mistake 명령 등록: 실수 기록(mistakes.jsonl)을 덧붙인다. */
import type { Command } from "commander";
import { appendMistake } from "../../core/mistakes.js";
import { resolveRunDir } from "../../core/paths.js";
import { runAction } from "./run-action.js";

interface AddOptions {
  run: string;
  foundStage: string;
  causeStage: string;
  foundBy: string;
  type: string;
  target: string;
  evidence: string;
  case?: string;
}

export function register(program: Command): void {
  const mistake = program.command("mistake").description("실수 기록 명령");
  mistake
    .command("add")
    .description("실수 기록을 mistakes.jsonl 에 한 줄 덧붙인다")
    .requiredOption("--run <폴더|id>", "실행 폴더 경로 또는 run_id")
    .requiredOption("--found-stage <단계>", "발견된 단계")
    .requiredOption("--cause-stage <단계>", "원인이 된 단계")
    .requiredOption("--found-by <누가>", "check|sasu|human_gate|replay_judge|review|qa|post")
    .requiredOption("--type <종류>", "missing_requirement|invented_requirement|false_confirmed|scope_closed_by_guess|wrong_evidence|visual_missed|needless_question|missed_question|bad_plan|format|other")
    .requiredOption("--target <id>", "걸린 항목 id")
    .requiredOption("--evidence <문장>", "무엇을 보고 실수로 판정했는지")
    .option("--case <id>", "이 실수를 회귀 사례로 만들었으면 그 id")
    .action((options: AddOptions, command: Command) =>
      runAction(command, () => {
        const m = appendMistake(resolveRunDir(options.run), {
          found_stage: options.foundStage,
          cause_stage: options.causeStage,
          found_by: options.foundBy,
          type: options.type,
          target: options.target,
          evidence: options.evidence,
          ...(options.case !== undefined ? { case: options.case } : {}),
        });
        return { data: m, text: `실수 기록 ${m.id} 을(를) 덧붙였습니다(${m.type}, ${m.target})` };
      }),
    );
}
