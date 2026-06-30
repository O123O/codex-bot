import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

test("loadConfig requires the Telegram token", () => {
  assert.throws(() => loadConfig({}), /TELEGRAM_BOT_TOKEN/);
});

test("loadConfig applies bounded defaults", () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: "secret",
    TELEGRAM_OWNER_ID: "42",
    TELEGRAM_DESTINATION_CHAT_ID: "42",
  });
  assert.equal(config.maxConcurrentTurns, 4);
  assert.equal(config.maxCollectCount, 20);
  assert.equal(config.mcpHost, "127.0.0.1");
  assert.equal(config.sandboxMode, "workspace-write");
});

test("loadConfig accepts an explicit execution sandbox", () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: "secret",
    TELEGRAM_OWNER_ID: "42",
    TELEGRAM_DESTINATION_CHAT_ID: "42",
    SANDBOX_MODE: "read-only",
  });
  assert.equal(config.sandboxMode, "read-only");
});

test("loadConfig rejects unsafe MCP binding", () => {
  assert.throws(() => loadConfig({
    TELEGRAM_BOT_TOKEN: "secret",
    TELEGRAM_OWNER_ID: "42",
    TELEGRAM_DESTINATION_CHAT_ID: "42",
    MCP_HOST: "0.0.0.0",
  }), /MCP_HOST/);
});

test("loadConfig rejects an outbound chat other than the authorized owner's private chat", () => {
  assert.throws(() => loadConfig({
    TELEGRAM_BOT_TOKEN: "secret",
    TELEGRAM_OWNER_ID: "42",
    TELEGRAM_DESTINATION_CHAT_ID: "99",
  }), /TELEGRAM_DESTINATION_CHAT_ID/);
});
