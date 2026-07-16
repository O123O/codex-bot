import assert from "node:assert/strict";
import { symlink, lstat, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareLocalSshRuntimeRoot } from "../../src/endpoints/local-runtime.ts";
import { parseSshConfig, planSshConnection } from "../../src/endpoints/ssh-config.ts";

test("places transient SSH sockets in the host runtime instead of the durable data directory", async (t) => {
  const runtimeBase = await mkdtemp(join(tmpdir(), "qiyan-local-runtime-"));
  t.after(() => rm(runtimeBase, { recursive: true, force: true }));

  const first = await prepareLocalSshRuntimeRoot("/nfs/home/user/.qiyan-bot/data", { runtimeBase });
  const repeated = await prepareLocalSshRuntimeRoot("/nfs/home/user/.qiyan-bot/data", { runtimeBase });
  const other = await prepareLocalSshRuntimeRoot("/nfs/home/user/other-qiyan/data", { runtimeBase });

  assert.equal(first, repeated);
  assert.notEqual(first, other);
  assert.match(first, new RegExp(`^${runtimeBase}/qiyan/[a-f0-9]{16}$`, "u"));
  assert.doesNotMatch(first, /^\/nfs\/home/u);
  assert.equal((await lstat(first)).mode & 0o777, 0o700);
});

test("keeps representative ControlMaster sockets within the portable path bound", () => {
  for (const runtimeRoot of [
    "/run/user/104284/qiyan/0123456789abcdef",
    "/tmp/qiyan-104284/qiyan/0123456789abcdef",
  ]) {
    const owned = planSshConnection("dfw-vscode", parseSshConfig(
      "hostname host.example\nuser xin\nport 22\ncontrolmaster no\ncontrolpath none\n",
    ), runtimeRoot);
    assert.ok(Buffer.byteLength(owned.controlPath!) <= 100);
  }
  assert.throws(
    () => planSshConnection("dfw-vscode", parseSshConfig(
      "hostname host.example\nuser xin\nport 22\ncontrolmaster no\ncontrolpath none\n",
    ), `/${"x".repeat(100)}`),
    /control path is too long/u,
  );
});

test("rejects a symlink in the private SSH runtime path", async (t) => {
  const runtimeBase = await mkdtemp(join(tmpdir(), "qiyan-local-runtime-link-"));
  const target = await mkdtemp(join(tmpdir(), "qiyan-local-runtime-target-"));
  t.after(() => Promise.all([
    rm(runtimeBase, { recursive: true, force: true }),
    rm(target, { recursive: true, force: true }),
  ]));
  await mkdir(join(runtimeBase, "qiyan"), { mode: 0o700 });
  const namespaceRoot = await prepareLocalSshRuntimeRoot("/known-data-dir", { runtimeBase });
  await rm(namespaceRoot, { recursive: true, force: true });
  await symlink(target, namespaceRoot);

  await assert.rejects(
    prepareLocalSshRuntimeRoot("/known-data-dir", { runtimeBase }),
    /private owner directory/u,
  );
});
