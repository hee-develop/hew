/** hew source add|list|request|plan|calls|fail|done 명령 등록. */
import { resolve } from "node:path";
import type { Command } from "commander";
import { computePlan } from "../../core/collect/plan.js";
import { usageError } from "../../core/errors.js";
import { resolveRunDir } from "../../core/paths.js";
import { loadRun } from "../../core/run.js";
import { addSource, doneSources, failSource, listCalls, listSources, requestSource } from "../../core/sources.js";
import { runAction } from "./run-action.js";

interface AddOptions {
  run: string;
  kind: string;
  ref: string;
  version?: string;
  title?: string;
  file?: string;
  fromCall?: string;
  node?: string;
  env?: string;
  baseSha?: string;
}

function parseCallNumber(value: string): number {
  if (!/^\d+$/.test(value)) throw usageError(`--from-call 은 호출 번호(숫자)여야 합니다: ${value}`);
  return Number(value);
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
    .option("--file <경로>", "복사할 원본 파일(code 는 쓰지 않는다. --from-call 과 둘 중 하나)")
    .option("--from-call <번호>", "받아 적은 도구 결과의 호출 번호(hew source calls 로 확인)")
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
          fromCall: options.fromCall === undefined ? undefined : parseCallNumber(options.fromCall),
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
    .command("plan")
    .description("다음에 가져올 항목(수집 계획)을 계산해 출력한다. 아무것도 바꾸지 않는다")
    .requiredOption("--run <폴더|id>", "실행 폴더 경로 또는 run_id")
    .action((options: { run: string }, command: Command) =>
      runAction(command, () => {
        const dir = resolveRunDir(options.run);
        loadRun(dir);
        const plan = computePlan(dir);
        const lines = plan.items.map((i) => `${i.skip === true ? "(건너뜀) " : ""}${i.id}\t${i.what}\t${i.tool_hint}${i.note === undefined ? "" : `\t※ ${i.note}`}`);
        for (const f of plan.failed) lines.push(`(실패 ${f.attempts}회) ${f.id}\t${f.what}`);
        for (const b of plan.blocked) lines.push(`(막힘) ${b}`);
        return { data: plan, text: lines.length > 0 ? lines.join("\n") : "가져올 항목이 없습니다" };
      }),
    );

  source
    .command("calls")
    .description("가장 최근 수집 작업 폴더에 받아 적힌 도구 결과 목록(번호, 도구, 입력, 크기, 등록 여부)")
    .requiredOption("--run <폴더|id>", "실행 폴더 경로 또는 run_id")
    .action((options: { run: string }, command: Command) =>
      runAction(command, () => {
        const r = listCalls(resolveRunDir(options.run));
        const lines = r.calls.map((c) => `${c.n}\t${c.tool ?? "-"}\t${c.input}\t${c.bytes}바이트\t${c.registered === null ? "미등록" : `등록됨(${c.registered})`}${c.error === undefined ? "" : `\t오류: ${c.error}`}`);
        return { data: r, text: lines.length > 0 ? lines.join("\n") : "받아 적은 호출이 없습니다" };
      }),
    );

  source
    .command("fail")
    .description("계획 항목을 가져오지 못했다고 기록한다(2회 실패한 항목은 계획에서 빠진다)")
    .requiredOption("--run <폴더|id>", "실행 폴더 경로 또는 run_id")
    .requiredOption("--item <항목 id>", "hew source plan 이 낸 항목 id")
    .requiredOption("--reason <글>", "실패 사유")
    .action((options: { run: string; item: string; reason: string }, command: Command) =>
      runAction(command, () => {
        const r = failSource({ runDir: resolveRunDir(options.run), item: options.item, reason: options.reason });
        return { data: r, text: `실패를 기록했습니다: ${r.item} (${r.attempts}회)${r.dropped ? " — 계획에서 빠집니다" : ""}` };
      }),
    );

  source
    .command("done")
    .description("필수 원천이 다 찼고 계획이 비었는지 확인하고, 차면 단위·화면 목록을 만들고 collected 로 간다")
    .requiredOption("--run <폴더|id>", "실행 폴더 경로 또는 run_id")
    .action((options: { run: string }, command: Command) =>
      runAction(command, () => {
        const r = doneSources(resolveRunDir(options.run));
        return {
          data: r,
          warnings: r.warnings.map((w) => ({ code: w.code, severity: "warn" as const, ref: w.item, message: w.message })),
          text: `수집이 끝났습니다: 상태 ${r.previous_state} → ${r.state}, 단위 ${r.units}개(Figma 화면 ${r.screens}개), revision ${r.revision.slice(0, 12)}`,
        };
      }),
    );
}
