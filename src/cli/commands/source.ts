/** hew source add|list|request|done 명령 등록. */
import { resolve } from "node:path";
import type { Command } from "commander";
import { resolveRunDir } from "../../core/paths.js";
import { addSource, doneSources, listSources, requestSource } from "../../core/sources.js";
import { runAction } from "./run-action.js";

interface AddOptions {
  run: string;
  kind: string;
  ref: string;
  version?: string;
  title?: string;
  file?: string;
  node?: string;
  env?: string;
  baseSha?: string;
}

export function register(program: Command): void {
  const source = program.command("source").description("원천 등록, 목록, 추가 수집 요청, 수집 완료 확인");

  source
    .command("add")
    .description("원천을 등록한다(같은 kind+ref+version 은 내용을 바꾼다)")
    .requiredOption("--run <폴더|id>", "실행 폴더 경로 또는 run_id")
    .requiredOption("--kind <kind>", "prd|ticket|figma_meta|figma_shot|related|code|openapi")
    .requiredOption("--ref <식별자>", "원천 식별자(페이지 번호, 티켓 키, 파일 키, 저장소 경로 등)")
    .option("--version <v>", "버전")
    .option("--title <t>", "제목")
    .option("--file <경로>", "복사할 원본 파일(code 는 쓰지 않는다)")
    .option("--node <figma 노드 id>", "Figma 노드 id(figma_shot 은 필수)")
    .option("--env <환경 이름>", "환경 이름(openapi 는 필수)")
    .option("--base-sha <sha>", "code 의 base SHA")
    .action((options: AddOptions, command: Command) =>
      runAction(command, () => {
        const result = addSource({
          runDir: resolveRunDir(options.run),
          kind: options.kind,
          ref: options.ref,
          version: options.version,
          title: options.title,
          file: options.file === undefined ? undefined : resolve(options.file),
          node: options.node,
          env: options.env,
          baseSha: options.baseSha,
        });
        const s = result.source;
        const verb = result.unchanged ? "이미 같은 내용으로 등록돼 있습니다" : result.replaced ? "내용을 바꿔 다시 등록했습니다" : "등록했습니다";
        return {
          data: { ...s, replaced: result.replaced, unchanged: result.unchanged },
          text: `${s.id} (${s.kind}, ${s.ref}) ${verb}${s.path ? `: ${s.path}` : ""}`,
        };
      }),
    );

  source
    .command("list")
    .description("등록된 원천 목록")
    .requiredOption("--run <폴더|id>", "실행 폴더 경로 또는 run_id")
    .action((options: { run: string }, command: Command) =>
      runAction(command, () => {
        const sources = listSources(resolveRunDir(options.run));
        const lines = sources.map(
          (s) => `${s.id}\t${s.kind}\t${s.ref}${s.version ? ` v${s.version}` : ""}\t${s.path ?? "-"}\t${s.sha256?.slice(0, 12) ?? "-"}`,
        );
        return { data: { sources }, text: sources.length > 0 ? lines.join("\n") : "등록된 원천이 없습니다" };
      }),
    );

  source
    .command("request")
    .description("추가 수집 요청을 sources/requests.jsonl 에 덧붙인다")
    .requiredOption("--run <폴더|id>", "실행 폴더 경로 또는 run_id")
    .requiredOption("--what <설명>", "무엇이 더 필요한지")
    .option("--node <id>", "관련 Figma 노드 id")
    .action((options: { run: string; what: string; node?: string }, command: Command) =>
      runAction(command, () => {
        const record = requestSource({ runDir: resolveRunDir(options.run), what: options.what, node: options.node });
        return { data: record, text: `추가 수집 요청을 남겼습니다: ${record.what}` };
      }),
    );

  source
    .command("done")
    .description("필수 원천이 다 찼는지 확인하고, 차면 단위·화면 목록을 만들고 collected 로 간다")
    .requiredOption("--run <폴더|id>", "실행 폴더 경로 또는 run_id")
    .action((options: { run: string }, command: Command) =>
      runAction(command, () => {
        const r = doneSources(resolveRunDir(options.run));
        return {
          data: r,
          text: `필수 원천이 갖춰졌습니다: 상태 ${r.previous_state} → ${r.state}, 단위 ${r.units}개(Figma 화면 ${r.screens}개), revision ${r.revision.slice(0, 12)}`,
        };
      }),
    );
}
