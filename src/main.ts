import { createApp } from "./app.ts";
import { parseCliArgs } from "./cli.ts";
import { loadConfig, loadAssistantLoginConfig } from "./config.ts";
import { loadConfigSource } from "./config-source.ts";
import { runAssistantLogin } from "./assistant/login.ts";
import { readPackageInfo } from "./distribution/package-info.ts";
import { updateFromLatestRelease } from "./distribution/update.ts";
import { validateAssistantWorkspacePaths } from "./assistant/workspace.ts";
import { WeixinAuthClient } from "./weixin/auth-client.ts";
import { WeixinCredentialStore } from "./weixin/credential-store.ts";
import { createNodeWeixinLoginTerminal, runWeixinLogin } from "./weixin/login.ts";
import { bootstrapWeixin } from "./weixin/bootstrap.ts";

export async function main(env = process.env, argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const command = parseCliArgs(argv);
  if (command.command === "version") {
    const packageInfo = await readPackageInfo();
    process.stdout.write(`${packageInfo.version}\n`);
    return;
  }
  if (command.command === "update") {
    const result = await updateFromLatestRelease({ env });
    process.stdout.write(`Updated qiyan-bot to ${result.version} in ${result.prefix}.\n`);
    process.stdout.write("Restart any running qiyan-bot process to use this version.\n");
    return;
  }
  if (command.command === "assistant-login") {
    const loaded = await loadConfigSource(env, command.qiyanHome === undefined ? {} : { cliHome: command.qiyanHome });
    await runAssistantLogin(loadAssistantLoginConfig(loaded.values, loaded.qiyanHome), loaded.hostEnv);
    return;
  }
  if (command.command === "weixin-login") {
    const loaded = await loadConfigSource(env, command.qiyanHome === undefined ? {} : { cliHome: command.qiyanHome });
    const transport = { fetch: (url: URL, init: RequestInit) => fetch(url, init) };
    const controller = new AbortController();
    const abort = () => { controller.abort(); };
    const terminal = createNodeWeixinLoginTerminal();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      await runWeixinLogin({
        store: new WeixinCredentialStore(loaded.qiyanHome),
        auth: new WeixinAuthClient(transport),
        terminal,
        signal: controller.signal,
      });
    } catch (error) {
      if (!controller.signal.aborted || !(error instanceof Error) || error.name !== "AbortError") throw error;
      terminal.status("WeChat authorization cancelled; no changes were made.");
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
    return;
  }
  const loaded = await loadConfigSource(env, command.qiyanHome === undefined ? {} : { cliHome: command.qiyanHome });
  const weixin = await bootstrapWeixin(loaded.qiyanHome);
  if (command.command === "config-check") {
    const config = loadConfig(loaded.values, { qiyanHome: loaded.qiyanHome, weixinConfigured: weixin.configured });
    await validateAssistantWorkspacePaths({ workdir: config.assistantWorkdir, dataDir: config.dataDir, registryPath: config.sessionRegistryPath });
    process.stdout.write("Configuration OK.\n");
    return;
  }
  const config = loadConfig(loaded.values, {
    qiyanHome: loaded.qiyanHome,
    weixinConfigured: weixin.configured,
    ...(command.assistantWorkdir === undefined ? {} : { assistantWorkdir: command.assistantWorkdir }),
  });
  const app = await createApp(config, weixin.configured ? { weixinCredential: weixin.credential } : {});
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
