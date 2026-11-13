/** 명령 본문을 실행하고 결과·오류를 출력 규약대로 내보낸다. */
import type { Command } from "commander";
import { emitFailure, emitSuccess, type CommandResult } from "../output.js";

export const isJson = (command: Command): boolean => Boolean(command.optsWithGlobals().json);

export function runAction(command: Command, body: () => CommandResult): void {
  const json = isJson(command);
  try {
    emitSuccess(json, body());
  } catch (error) {
    process.exitCode = emitFailure(json, error);
  }
}
