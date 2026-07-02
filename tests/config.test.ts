import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { loadConfig, loadAssistantLoginConfig } from "../src/config.ts";

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    TELEGRAM_BOT_TOKEN: "secret",
    TELEGRAM_OWNER_ID: "42",
    TELEGRAM_DESTINATION_CHAT_ID: "42",
    ASSISTANT_WORKDIR: "assistant-home",
    ...overrides,
  };
}

test("loadConfig requires the Telegram token", () => {
  assert.throws(() => loadConfig({}), /TELEGRAM_BOT_TOKEN/);
});

test("loadConfig applies bounded defaults", () => {
  const config = loadConfig(baseEnv());
  assert.equal(config.maxConcurrentTurns, 4);
  assert.equal(config.maxCollectCount, 20);
  assert.equal(config.mcpHost, "127.0.0.1");
  assert.equal(config.sandboxMode, "workspace-write");
});

test("loadConfig accepts an explicit execution sandbox", () => {
  const config = loadConfig(baseEnv({ ASSISTANT_SANDBOX_MODE: "read-only" }));
  assert.equal(config.sandboxMode, "read-only");
});

test("loadConfig rejects unsafe MCP binding", () => {
  assert.throws(() => loadConfig(baseEnv({ MCP_HOST: "0.0.0.0" })), /MCP_HOST/);
});

test("loadConfig rejects an outbound chat other than the authorized owner's private chat", () => {
  assert.throws(() => loadConfig(baseEnv({ TELEGRAM_DESTINATION_CHAT_ID: "99" })), /TELEGRAM_DESTINATION_CHAT_ID/);
});

test("loadConfig requires a assistant workdir", () => {
  assert.throws(() => loadConfig(baseEnv({ ASSISTANT_WORKDIR: undefined })), /ASSISTANT_WORKDIR/);
});

test("CLI workdir overrides the environment and resolves from the launch directory", () => {
  const config = loadConfig(baseEnv({ ASSISTANT_WORKDIR: "from-env" }), { assistantWorkdir: "from-cli" });
  assert.equal(config.assistantWorkdir, resolve("from-cli"));
});

test("CLI workdir takes precedence before an invalid environment workdir is validated", () => {
  const config = loadConfig(baseEnv({ ASSISTANT_WORKDIR: "" }), { assistantWorkdir: "from-cli" });
  assert.equal(config.assistantWorkdir, resolve("from-cli"));
});

test("assistant login configuration needs only data and Codex paths", () => {
  assert.deepEqual(loadAssistantLoginConfig({ DATA_DIR: "private-data", CODEX_BINARY: "/opt/codex" }), {
    dataDir: resolve("private-data"),
    codexBinary: "/opt/codex",
  });
  assert.deepEqual(loadAssistantLoginConfig({}), { dataDir: resolve("data"), codexBinary: "codex" });
});
