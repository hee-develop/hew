/** hew check 명령 등록: 정본에 결정적 검사만 다시 돌린다. 아무것도 바꾸지 않는다. */
import { existsSync } from "node:fs";
import type { Command } from "commander";
import { rejectedError, stateError, usageError, type Issue } from "../../core/errors.js";
import { readJsonFile } from "../../core/fsx.js";
import { resolveRunDir, runPaths } from "../../core/paths.js";
import { loadRun } from "../../core/run.js";
import { getKindSpec } from "../../core/submit.js";
import { runAction } from "./run-action.js";

const CHECK_KINDS = ["analysis", "scenarios"] as const;
type CheckKind = (typeof CHECK_KINDS)[number];

export function register(program: Command): void {
  program
    .command("check")
    .description("정본에 결정적 검사만 다시 돌려 지적 목록을 낸다(거부 지적이 있으면 종료 3)")
    .requiredOption("--run <폴더|id>", "실행 폴더 경로 또는 run_id")
    .option("--only <종류>", "검사할 정본: analysis|scenarios (없으면 있는 정본을 모두)")
    .action((options: { run: string; only?: string }, command: Command) =>
      runAction(command, () => {
        if (options.only !== undefined && !(CHECK_KINDS as readonly string[]).includes(options.only)) {
          throw usageError(`--only 는 ${CHECK_KINDS.join("|")} 중 하나여야 합니다: ${options.only}`);
        }
        const runDir = resolveRunDir(options.run);
        const run = loadRun(runDir);
        const paths = runPaths(runDir);
        const fileOf = (kind: CheckKind): string => (kind === "analysis" ? paths.analysis : paths.scenarios);
        const kinds: CheckKind[] = options.only !== undefined ? [options.only as CheckKind] : CHECK_KINDS.filter((k) => existsSync(fileOf(k)));
        if (kinds.length === 0) throw stateError("검사할 정본(doc/analysis.json, doc/scenarios.json)이 없습니다. 먼저 analysis 를 제출하세요");
        const issues: Issue[] = [];
        for (const kind of kinds) {
          const file = fileOf(kind);
          if (!existsSync(file)) throw stateError(`정본(doc/${kind}.json)이 없습니다. 먼저 ${kind} 를 제출하세요`);
          const items = (readJsonFile(file) as { items: Record<string, unknown> }).items;
          issues.push(...getKindSpec(kind).checks.flatMap((check) => check(items, { kind, for: null, run, runDir })));
        }
        const rejects = issues.filter((i) => i.severity === "reject");
        if (rejects.length > 0) {
          throw rejectedError(`결정적 검사에서 거부 지적이 ${rejects.length}건 나왔습니다`, issues);
        }
        const others = issues.filter((i) => i.severity !== "reject");
        return {
          data: {
            kind: options.only ?? "all",
            kinds,
            rejects: 0,
            warnings: others.filter((i) => i.severity === "warn").length,
            issues: others,
          },
          warnings: others,
          text: `결정적 검사(${kinds.join("·")})를 통과했습니다(경고·정보 ${others.length}건)`,
        };
      }),
    );
}
