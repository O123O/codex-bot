import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { RpcClient } from "../../src/app-server/rpc-client.ts";
import { WebSocketWire } from "../../src/app-server/websocket-wire.ts";

test("WebSocket wire exchanges App Server frames over a Unix socket", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-ws-"));
  const socket = join(root, "app.sock");
  const server = createServer();
  const websocket = new WebSocketServer({ server, maxPayload: 1024 * 1024 });
  t.after(async () => {
    websocket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  websocket.on("connection", (peer) => peer.on("message", (value) => {
    const request = JSON.parse(value.toString()) as { id: number };
    peer.send(JSON.stringify({ id: request.id, result: { ready: true } }));
  }));
  await new Promise<void>((resolve, reject) => server.listen(socket, () => resolve()).once("error", reject));
  const wire = await WebSocketWire.connect(socket, { timeoutMs: 500 });
  const client = new RpcClient(wire, { requestTimeoutMs: 500 });
  assert.deepEqual(await client.request("initialize", {}), { ready: true });
  client.close();
});

test("WebSocket wire rejects non-absolute socket paths", async () => {
  await assert.rejects(WebSocketWire.connect("relative.sock", { timeoutMs: 10 }), /absolute Unix socket/u);
});
