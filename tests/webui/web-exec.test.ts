import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { runCommand } from "../../src/webui/web-exec.ts";

test("runs a one-shot command in the cwd and captures output + exit code", async () => {
  const r = await runCommand(tmpdir(), "echo hello && pwd", { maxBytes: 4096, timeoutMs: 5000 });
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /hello/);
  assert.equal(r.timedOut, false);
});

test("reports a non-zero exit code", async () => {
  const r = await runCommand(tmpdir(), "exit 3", { maxBytes: 4096, timeoutMs: 5000 });
  assert.equal(r.exitCode, 3);
});

test("blocks interactive/pager commands", async () => {
  const r = await runCommand(tmpdir(), "vim x", { maxBytes: 4096, timeoutMs: 5000 });
  assert.equal(r.error, "blocked");
});

test("enforces the timeout (SIGTERM/SIGKILL)", async () => {
  const r = await runCommand(tmpdir(), "sleep 5", { maxBytes: 4096, timeoutMs: 300 });
  assert.equal(r.timedOut, true);
});

test("caps output at maxBytes and marks it truncated", async () => {
  const r = await runCommand(tmpdir(), "yes abcdefgh | head -c 100000", { maxBytes: 1024, timeoutMs: 5000 });
  assert.equal(r.truncated, true);
  assert.ok(r.stdout.length <= 1024);
});
