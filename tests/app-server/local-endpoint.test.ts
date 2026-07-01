import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { LocalEndpoint, resolveMcpClientPid } from "../../src/app-server/local-endpoint.ts";

class FakeChild extends EventEmitter {
  constructor(readonly pid?: number) { super(); }
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill() { this.killed = true; this.emit("exit", 0, null); return true; }
}

test("resolves one exact protocol process and rejects ambiguous launchers", async () => {
  assert.equal(await resolveMcpClientPid(10, async () => []), 10);
  assert.equal(await resolveMcpClientPid(10, async (pid) => pid === 10 ? [11] : []), 11);
  await assert.rejects(resolveMcpClientPid(10, async (pid) => pid === 10 ? [11, 12] : []), /launcher topology/);
  await assert.rejects(resolveMcpClientPid(10, async (pid) => pid === 10 ? [11] : [12]), /launcher topology/);
});

test("initializes app-server before becoming ready", async () => {
  const child = new FakeChild();
  const requests: Array<Record<string, unknown>> = [];
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
    requests.push(request);
    if (request.method === "initialize") child.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: "test", platformFamily: "unix", platformOs: "linux" } })}\n`);
  });
  const endpoint = new LocalEndpoint({ codexBinary: "codex", spawn: () => child as never });
  await endpoint.start();
  assert.equal(endpoint.state, "ready");
  assert.equal(requests[0]?.method, "initialize");
  assert.equal(requests[1]?.method, "initialized");
  await endpoint.stop();
  assert.equal(child.killed, true);
});

test("declines approval requests and emits a blocked event", async () => {
  const child = new FakeChild();
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
    if (request.method === "initialize") child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
  });
  const endpoint = new LocalEndpoint({ codexBinary: "codex", spawn: () => child as never });
  const blocked: unknown[] = [];
  endpoint.onPermissionBlocked((event) => blocked.push(event));
  await endpoint.start();
  child.stdout.write(`${JSON.stringify({ id: 17, method: "item/fileChange/requestApproval", params: { threadId: "t1", turnId: "turn1", itemId: "i1", reason: "write" } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(blocked.length, 1);
});

test("rejects an app-server version outside the generated protocol pin", async () => {
  const child = new FakeChild();
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
    if (request.method === "initialize") child.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: "codex_chat_bot/9.9.9 (test)" } })}\n`);
  });
  const endpoint = new LocalEndpoint({ codexBinary: "codex", spawn: () => child as never, expectedVersion: "0.142.4" });
  await assert.rejects(endpoint.start(), /expected Codex app-server 0\.142\.4/);
  assert.equal(endpoint.state, "unavailable");
});

test("a delayed exit from an old child cannot close a restarted endpoint", async () => {
  class DelayedChild extends FakeChild {
    override kill() { this.killed = true; return true; }
    exitNow() { this.emit("exit", 0, null); }
  }
  const children = [new DelayedChild(101), new DelayedChild(102)];
  for (const child of children) {
    child.stdin.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
      if (request.method === "initialize") child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      if (request.method === "model/list") child.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [], nextCursor: null } })}\n`);
    });
  }
  let index = 0;
  const endpoint = new LocalEndpoint({ codexBinary: "codex", spawn: () => children[index++] as never, resolveMcpClientPid: async (pid) => pid + 1_000 });
  await endpoint.start();
  assert.equal(endpoint.mcpClientPid, 1_101);
  await endpoint.stop();
  assert.equal(endpoint.mcpClientPid, undefined);
  await endpoint.start();
  assert.equal(endpoint.mcpClientPid, 1_102);
  children[0]!.exitNow();
  assert.equal(endpoint.mcpClientPid, 1_102);
  assert.deepEqual(await endpoint.request("model/list", {}), { data: [], nextCursor: null });
  assert.equal(endpoint.state, "ready");
  await endpoint.stop();
  assert.equal(endpoint.mcpClientPid, undefined);
  children[1]!.exitNow();
});
