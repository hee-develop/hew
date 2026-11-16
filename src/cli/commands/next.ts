/** hew next 명령 등록. 아무것도 바꾸지 않는다. */
import type { Command } from "commander";
import { nextAction, type NextAction } from "../../core/next.js";
import { resolveRunDir } from "../../core/paths.js";
import { loadRun } from "../../core/run.js";
import { runAction } from "./run-action.js";

function describe(action: NextAction): string {
  switch (action.action) {
    case "spawn":
      return `${action.role} 를 띄웁니다(${action.purpose})`;
    case "sasu":
      return `${action.for} 사수를 돌립니다`;
    case "publish_gate":
      return `게이트(${action.phase})를 게시합니다`;
    case "wait_human":
      return `사람의 ${action.for === "answers" ? "답" : "승인"}을 기다립니다`;
    case "done":
      return "끝났습니다";
  }
}

export function register(program: Command): void {
  program
    .command("next")
    .description("다음에 할 일을 알려 준다(아무것도 바꾸지 않는다)")
    .requiredOption("--run <폴더|id>", "실행 폴더 경로 또는 run_id")
    .action((options: { run: string }, command: Command) =>
      runAction(command, () => {
        const run = loadRun(resolveRunDir(options.run));
        const next = nextAction(run.state, { rework: run.rework, progress: run.progress });
        return { data: { state: run.state, next }, text: `상태 ${run.state}: ${describe(next)}` };
      }),
    );
}
