import { pathToFileURL } from "node:url";
import { createApp } from "./app.ts";
import { formatStartupError, parseCliArgs } from "./cli.ts";
import { loadConfig } from "./config.ts";

export function isDirectExecution(moduleUrl: string, argvEntry: string | undefined): boolean {
  return argvEntry !== undefined && moduleUrl === pathToFileURL(argvEntry).href;
}

export async function main(env = process.env, argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const app = await createApp(loadConfig(env, parseCliArgs(argv)));
  await app.start();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void app.stop().catch(() => { process.exitCode = 1; });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  void main().catch((error) => {
    process.stderr.write(`codex-bot: ${formatStartupError(error)}\n`);
    process.exitCode = 1;
  });
}
