/** hew CLI 진입점. 종료 코드는 §2.5 를 따른다. */
import { Command, CommanderError } from "commander";
import { EXIT, usageError } from "../core/errors.js";
import { register as registerInit } from "./commands/init.js";
import { register as registerNext } from "./commands/next.js";
import { register as registerStatus } from "./commands/status.js";
import { register as registerSource } from "./commands/source.js";
import { register as registerSubmit } from "./commands/submit.js";
import { register as registerUnits } from "./commands/units.js";
import { emitFailure } from "./output.js";

const program = new Command();
program
  .name("hew")
  .description("hew 코어 CLI")
  .option("--json", "기계 판독 JSON 출력")
  .exitOverride()
  .configureOutput({ writeErr: () => {} });

for (const register of [registerInit, registerStatus, registerNext, registerSubmit, registerSource, registerUnits]) register(program);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const wantsJson = process.argv.includes("--json");
  if (error instanceof CommanderError) {
    const informational = error.code === "commander.helpDisplayed" || error.code === "commander.version";
    process.exitCode = informational ? EXIT.ok : emitFailure(wantsJson, usageError(error.message.replace(/^error: /, "")));
  } else {
    process.exitCode = emitFailure(wantsJson, error);
  }
}
