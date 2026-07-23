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

test("fast-fails obvious interactive commands without blocking useful one-shot runtimes", async () => {
  const r = await runCommand(tmpdir(), "vim x", { maxBytes: 4096, timeoutMs: 5000 });
  assert.equal(r.error, "blocked");
  const node = await runCommand(tmpdir(), "node -e \"process.stdout.write('node ok')\"", { maxBytes: 4096, timeoutMs: 5000 });
  assert.equal(node.exitCode, 0);
  assert.equal(node.stdout, "node ok");
});

test("forces pager and credential prompts into noninteractive mode", async () => {
  const r = await runCommand(tmpdir(), "printf '%s' \"$PAGER,$SYSTEMD_PAGER,$MANPAGER,$GIT_TERMINAL_PROMPT,$GCM_INTERACTIVE,$SSH_ASKPASS_REQUIRE\"", {
    maxBytes: 4096, timeoutMs: 5000,
  });
  assert.equal(r.stdout, "cat,cat,cat,0,Never,force");
});

test("enforces the timeout (SIGTERM/SIGKILL)", async () => {
  const r = await runCommand(tmpdir(), "sleep 5", { maxBytes: 4096, timeoutMs: 300 });
  assert.equal(r.timedOut, true);
});

test("a backgrounded grandchild cannot hang the response (group kill)", async () => {
  const t0 = Date.now();
  const r = await runCommand(tmpdir(), "echo hi; sleep 30 &", { maxBytes: 4096, timeoutMs: 2000 });
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`); // bounded well under the 30s sleep
  assert.match(r.stdout, /hi/);
});

test("caps output at maxBytes and marks it truncated", async () => {
  const r = await runCommand(tmpdir(), "yes abcdefgh | head -c 100000", { maxBytes: 1024, timeoutMs: 5000 });
  assert.equal(r.truncated, true);
  assert.ok(r.stdout.length <= 1024);
});
