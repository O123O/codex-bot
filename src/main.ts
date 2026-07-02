import { createApp } from "./app.ts";
import { parseCliArgs } from "./cli.ts";
import { loadConfig, loadCoordinatorLoginConfig } from "./config.ts";
import { runCoordinatorLogin } from "./coordinator/login.ts";
import { readPackageInfo } from "./distribution/package-info.ts";
import { updateFromLatestRelease } from "./distribution/update.ts";

export async function main(env = process.env, argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const command = parseCliArgs(argv);
  if (command.command === "version") {
    const packageInfo = await readPackageInfo();
    process.stdout.write(`${packageInfo.version}\n`);
    return;
  }
  if (command.command === "update") {
    const result = await updateFromLatestRelease({ env });
    process.stdout.write(`Updated codex-bot to ${result.version} in ${result.prefix}.\n`);
    process.stdout.write("Restart any running codex-bot process to use this version.\n");
    return;
  }
  if (command.command === "coordinator-login") {
    await runCoordinatorLogin(loadCoordinatorLoginConfig(env), env);
    return;
  }
  const app = await createApp(loadConfig(env, command.coordinatorWorkdir === undefined ? {} : { coordinatorWorkdir: command.coordinatorWorkdir }));
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
