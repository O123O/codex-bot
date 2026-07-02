import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { BotConfig } from "../src/config.ts";
import { buildProductionApp } from "../src/production-app.ts";

test("production prepares the configured assistant workdir before endpoint startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-production-workdir-"));
  const workdir = join(root, "external-assistant");
  const dataDir = join(root, "backend-data");
  const registryPath = join(root, "backend-registry", "sessions.json");
  const policyAsset = fileURLToPath(new URL("../assets/assistant/AGENTS.md", import.meta.url));
  const config: BotConfig = {
    telegramBotToken: "test-token",
    telegramOwnerId: 42,
    telegramDestinationChatId: 42,
    assistantWorkdir: workdir,
    dataDir,
    sessionRegistryPath: registryPath,
    codexBinary: join(root, "missing-codex"),
    maxConcurrentTurns: 1,
    maxCollectCount: 20,
    mcpHost: "127.0.0.1",
    mcpPort: 0,
    attachmentMaxBytes: 1024,
    attachmentStoreMaxBytes: 4096,
    sandboxMode: "workspace-write",
  };
  const app = await buildProductionApp(config);
  await assert.rejects(app.start());
  await app.stop();

  assert.equal(await readFile(join(workdir, "AGENTS.md"), "utf8"), await readFile(policyAsset, "utf8"));
  assert.match(await readFile(join(workdir, ".qiyan-bot-agents.sha256"), "utf8"), /^[a-f0-9]{64}\n$/u);
  assert.deepEqual(JSON.parse(await readFile(join(workdir, "session-status.json"), "utf8")), { version: 2, sessions: {} });
  assert.equal(JSON.parse(await readFile(registryPath, "utf8")).assistant.project_dir, await realpath(workdir));
  for (const path of [
    join(dataDir, "assistant-profile"),
    join(dataDir, "assistant-profile/home"),
    join(dataDir, "assistant-profile/codex"),
  ]) assert.equal((await stat(path)).mode & 0o777, 0o700);
});
