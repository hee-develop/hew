/** hew units 명령 등록. */
import type { Command } from "commander";
import { loadRun } from "../../core/run.js";
import { resolveRunDir } from "../../core/paths.js";
import { writeUnits } from "../../core/units/index.js";
import { runAction } from "./run-action.js";

export function register(program: Command): void {
  program
    .command("units")
    .description("등록된 원천에서 sources/units.json 과 Figma 화면 목록을 다시 만든다")
    .requiredOption("--run <폴더|id>", "실행 폴더 경로 또는 run_id")
    .action((options: { run: string }, command: Command) =>
      runAction(command, () => {
        const dir = resolveRunDir(options.run);
        loadRun(dir);
        const { units, inventory } = writeUnits(dir);
        const screens = units.units.filter((u) => u.kind === "figma_screen").length;
        return {
          data: { units: units.units.length, screens, inventory: inventory !== null },
          text: `원문 단위 ${units.units.length}개를 만들었습니다(Figma 화면 ${screens}개)`,
        };
      }),
    );
}
