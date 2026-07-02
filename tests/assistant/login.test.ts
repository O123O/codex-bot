import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAssistantLogin } from "../../src/assistant/login.ts";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

test("safe login prepares the profile and spawns device auth without bot secrets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-login-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const child = new FakeChild();
  let call: { command: string; args: readonly string[]; options: Record<string, unknown> } | undefined;
  const completion = runAssistantLogin({ dataDir, codexBinary: "/opt/codex" }, {
    PATH: "/bin", HOME: "/real/home", CODEX_HOME: "/real/codex", OPENAI_API_KEY: "auth", TELEGRAM_BOT_TOKEN: "telegram-secret",
  }, ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    call = { command, args, options };
    queueMicrotask(() => child.finish(0));
    return child as never;
  }) as never);
  await completion;
  assert.equal(call?.command, "/opt/codex");
  assert.deepEqual(call?.args, ["login", "--device-auth"]);
  assert.equal(call?.options.stdio, "inherit");
  const env = call?.options.env as NodeJS.ProcessEnv;
  assert.equal(env.HOME, join(dataDir, "assistant-profile/home"));
  assert.equal(env.CODEX_HOME, join(dataDir, "assistant-profile/codex"));
  assert.equal(env.OPENAI_API_KEY, "auth");
  assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(env.QIYAN_BOT_MCP_TOKEN, undefined);
  await assert.rejects(readFile(join(dataDir, "assistant-profile/profile.json")), /ENOENT/);
});

test("safe login propagates failure and rejects unsafe profile paths before spawn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-login-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  await mkdir(dataDir);
  const child = new FakeChild();
  const failed = runAssistantLogin({ dataDir, codexBinary: "codex" }, {}, (() => {
    queueMicrotask(() => child.finish(7));
    return child as never;
  }) as never);
  await assert.rejects(failed, /exited with status 7/);

  const unsafeData = join(root, "unsafe-data");
  const target = join(root, "target");
  await mkdir(unsafeData);
  await mkdir(target);
  await symlink(target, join(unsafeData, "assistant-profile"));
  let spawns = 0;
  await assert.rejects(runAssistantLogin({ dataDir: unsafeData, codexBinary: "codex" }, {}, (() => { spawns += 1; return new FakeChild() as never; }) as never));
  assert.equal(spawns, 0);
});
