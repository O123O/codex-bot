import assert from "node:assert/strict";
import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { RpcWire } from "../../src/app-server/rpc-client.ts";
import { SshAppServerRuntime } from "../../src/endpoints/ssh-app-server-runtime.ts";
import type { SshConnectionPlan } from "../../src/endpoints/ssh-config.ts";
import type { SshRuntimeController } from "../../src/endpoints/ssh-runtime.ts";
import type { EndpointLossKind, RuntimeIdentity } from "../../src/endpoints/types.ts";

const identity: RuntimeIdentity = { kind: "ssh", token: "a".repeat(32), pid: 10, linuxStartTime: "20", processGroupId: 10 };
const replacement: RuntimeIdentity = { kind: "ssh", token: "b".repeat(32), pid: 11, linuxStartTime: "21", processGroupId: 11 };
const plan: SshConnectionPlan = {
  alias: "devbox",
  destination: { hostname: "host.example", user: "xin", port: 22 },
  commonArgs: ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"],
  ownsControlMaster: true,
  controlPath: "/tmp/helper-master",
};

class FakeWire implements RpcWire {
  private readonly messages = new Set<(message: string) => void>();
  private readonly closes = new Set<(error?: Error) => void>();
  closed = false;
  closeError: Error | undefined;
  send(): void {}
  close(): void {
    if (!this.closed) { this.closed = true; for (const listener of this.closes) listener(); }
    if (this.closeError) throw this.closeError;
  }
  onMessage(listener: (message: string) => void): () => void { this.messages.add(listener); return () => this.messages.delete(listener); }
  onClose(listener: (error?: Error) => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }
}

class FakeForwardChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  server: Server | undefined;
  killed = false;
  delayKill = false;
  private pendingKill?: () => void;
  kill(signal?: NodeJS.Signals) {
    this.killed = true;
    this.signalCode = signal ?? "SIGTERM";
    const finish = () => this.emit("exit", null, this.signalCode);
    const close = () => { if (this.server?.listening) this.server.close(finish); else finish(); };
    if (this.delayKill) this.pendingKill = close; else close();
    return true;
  }
  releaseKill(): void { this.pendingKill?.(); delete this.pendingKill; }
  fail(): void {
    this.exitCode = 255;
    const finish = () => this.emit("exit", 255, null);
    if (this.server?.listening) this.server.close(finish); else finish();
  }
}

class FakeRemoteRuntime implements SshRuntimeController {
  readonly remoteSocketPath = "/tmp/qiyan-1000/abcdef0123456789abcdef01/app-server.sock";
  current: RuntimeIdentity | undefined = identity;
  classification: EndpointLossKind = "connection-lost";
  starts = 0;
  readonly stops: RuntimeIdentity[] = [];
  async ensureStarted(): Promise<RuntimeIdentity> { this.starts += 1; return identity; }
  async runtimeIdentity(): Promise<RuntimeIdentity | undefined> { return this.current; }
  async classifyLoss(): Promise<EndpointLossKind> { return this.classification; }
  async stop(expected: RuntimeIdentity): Promise<void> { this.stops.push(expected); }
}

function fixture(root: string, remote = new FakeRemoteRuntime(), options: {
  connectWire?: (socketPath: string) => Promise<RpcWire>;
  afterSpawn?: (child: FakeForwardChild, localSocket: string) => void;
} = {}) {
  const children: FakeForwardChild[] = [];
  const args: string[][] = [];
  const wires: FakeWire[] = [];
  let generation = 0;
  const runtime = new SshAppServerRuntime({
    runtime: remote,
    plan,
    socketRoot: root,
    socketGeneration: () => `${++generation}`.padStart(8, "0"),
    spawn: ((_command: string, childArgs: readonly string[], _options: SpawnOptions) => {
      args.push([...childArgs]);
      const spec = childArgs[childArgs.indexOf("-L") + 1]!;
      const localSocket = spec.slice(0, spec.indexOf(":"));
      const child = new FakeForwardChild();
      const server = createServer();
      child.server = server;
      server.listen(localSocket, () => { void chmod(localSocket, 0o600); });
      children.push(child);
      options.afterSpawn?.(child, localSocket);
      return child as never;
    }) as never,
    connectWire: options.connectWire ?? (async () => { const wire = new FakeWire(); wires.push(wire); return wire; }),
    connectionTimeoutMs: 2_000,
  });
  return { runtime, remote, children, args, wires };
}

test("an asynchronous SSH spawn error is observed during open", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-forward-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const value = fixture(root, new FakeRemoteRuntime(), {
    afterSpawn: (child) => queueMicrotask(() => child.emit("error", new Error("ssh missing"))),
  });

  await assert.rejects(value.runtime.open(), /ssh missing|forward/iu);
  assert.equal(value.children[0]!.killed, true);
  assert.deepEqual(value.remote.stops, []);
});

test("wire connection failure removes the exact forward socket without stopping the remote runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-forward-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const value = fixture(root, new FakeRemoteRuntime(), {
    connectWire: async () => { throw new Error("wire connect failed"); },
  });

  await assert.rejects(value.runtime.open(), /wire connect failed/u);

  const socketSpec = value.args[0]![value.args[0]!.indexOf("-L") + 1]!;
  const socketPath = socketSpec.slice(0, socketSpec.indexOf(":"));
  assert.equal(value.children[0]!.killed, true);
  await assert.rejects(lstat(socketPath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.deepEqual(value.remote.stops, []);
});

test("SSH exit while wire connection is pending rejects open", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-forward-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  let beginConnect!: () => void;
  const connecting = new Promise<void>((resolve) => { beginConnect = resolve; });
  const value = fixture(root, new FakeRemoteRuntime(), {
    connectWire: async () => { beginConnect(); return new Promise<RpcWire>(() => undefined); },
  });
  const opening = value.runtime.open();
  await connecting;

  value.children[0]!.fail();

  await assert.rejects(opening, /forward exited/iu);
});

test("process failure in the wire handoff closes the newly created wire", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-forward-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const wire = new FakeWire();
  const value = fixture(root, new FakeRemoteRuntime(), {
    connectWire: async () => {
      queueMicrotask(() => value.children[0]!.emit("error", new Error("handoff failed")));
      return wire;
    },
  });

  await assert.rejects(value.runtime.open(), /handoff failed|forward/iu);
  assert.equal(wire.closed, true);
  assert.equal(value.children[0]!.killed, true);
});

test("overlapping opens reserve the single forward before the first await", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-forward-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  let release!: (wire: RpcWire) => void;
  let beginConnect!: () => void;
  const connecting = new Promise<void>((resolve) => { beginConnect = resolve; });
  const connected = new Promise<RpcWire>((resolve) => { release = resolve; });
  const value = fixture(root, new FakeRemoteRuntime(), { connectWire: () => { beginConnect(); return connected; } });
  const first = value.runtime.open();

  await assert.rejects(value.runtime.open(), /already open/iu);
  await connecting;
  assert.equal(value.children.length, 1);
  release(new FakeWire());
  await (await first).close();
});

test("SSH runtime service owns one independent forward and confirms exact remote identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-forward-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const value = fixture(root);

  const connection = await value.runtime.open();
  const confirmed = await connection.confirmInitialized({});

  assert.deepEqual(confirmed, { runtime: identity });
  assert.equal(value.remote.starts, 1);
  const rendered = value.args[0]!.join(" ");
  assert.match(rendered, /ControlMaster=no/u);
  assert.doesNotMatch(rendered, /helper-master|ControlPersist=60/u);
  assert.deepEqual(await value.runtime.runtimeIdentity(), identity);

  await connection.close();
  assert.equal(value.children[0]!.killed, true);
  assert.deepEqual(value.remote.stops, [], "closing the forward must leave the detached runtime alive");
});

test("SSH connection refuses a changed detached runtime identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-forward-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const value = fixture(root);
  const connection = await value.runtime.open();
  value.remote.current = replacement;

  await assert.rejects(connection.confirmInitialized({}), /identity changed/u);
  await connection.close();
});

test("forward loss is connection loss and explicit shutdown stops only the exact runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-forward-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const value = fixture(root);
  const connection = await value.runtime.open();
  await connection.confirmInitialized({});
  const losses: string[] = [];
  connection.onClose(() => losses.push("closed"));

  value.children[0]!.fail();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(losses, ["closed"]);
  assert.equal(await value.runtime.classifyLoss(), "connection-lost");
  await value.runtime.shutdownRuntime(identity);
  assert.deepEqual(value.remote.stops, [identity]);
});

test("an old forward exit and socket cleanup cannot affect a new generation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-forward-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const value = fixture(root);
  const first = await value.runtime.open();
  await first.confirmInitialized({});
  value.children[0]!.delayKill = true;
  const closing = first.close();
  await new Promise((resolve) => setImmediate(resolve));
  const second = await value.runtime.open();
  await second.confirmInitialized({});

  value.children[0]!.releaseKill();
  await closing;

  assert.equal(value.wires[1]!.closed, false);
  const secondSpec = value.args[1]![value.args[1]!.indexOf("-L") + 1]!;
  const secondPath = secondSpec.slice(0, secondSpec.indexOf(":"));
  assert.equal((await lstat(secondPath)).isSocket(), true);
  assert.deepEqual(await value.runtime.runtimeIdentity(), identity);
  await second.close();
});

test("wire cleanup failure cannot leak the forward or skip exact remote shutdown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-forward-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const value = fixture(root);
  const connection = await value.runtime.open();
  await connection.confirmInitialized({});
  const socketSpec = value.args[0]![value.args[0]!.indexOf("-L") + 1]!;
  const socketPath = socketSpec.slice(0, socketSpec.indexOf(":"));
  value.wires[0]!.closeError = new Error("wire cleanup failed");

  await assert.rejects(value.runtime.shutdownRuntime(identity), /wire cleanup failed/u);

  assert.equal(value.children[0]!.killed, true);
  await assert.rejects(lstat(socketPath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.deepEqual(value.remote.stops, [identity]);
});
