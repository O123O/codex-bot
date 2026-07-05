import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { EndpointManager } from "../../src/endpoints/manager.ts";
import type { PermissionBlockedEvent } from "../../src/app-server/local-endpoint.ts";
import type { EndpointLossKind, ManagedAppServerEndpoint, RuntimeIdentity } from "../../src/endpoints/types.ts";

class FakeEndpoint implements ManagedAppServerEndpoint {
  state: ManagedAppServerEndpoint["state"] = "stopped";
  starts = 0;
  connectionCloses = 0;
  runtimeStops = 0;
  rotateIdentityOnStop = false;
  failStart = false;
  identityAvailable = true;
  identityToken = "a".repeat(32);
  threadStatus: "idle" | "active" | "systemError" = "idle";
  private readonly events = new EventEmitter();
  constructor(readonly id: string) {}
  async start() { this.starts += 1; if (this.failStart) throw new Error("offline"); this.state = "ready"; this.events.emit("ready"); }
  async closeConnection() { this.connectionCloses += 1; this.state = "stopped"; }
  async shutdownRuntime() {
    this.runtimeStops += 1;
    this.state = "stopped";
    if (this.rotateIdentityOnStop && this.id !== "local") this.identityToken = "b".repeat(32);
  }
  async runtimeIdentity(): Promise<RuntimeIdentity | undefined> {
    if (!this.identityAvailable) return undefined;
    return this.id === "local"
      ? { kind: "local", pid: 10, startTime: "20" }
      : { kind: "ssh", token: this.identityToken, pid: 10, linuxStartTime: "20", processGroupId: 10 };
  }
  async request<T>(method: string): Promise<T> {
    if (method === "thread/read") return { thread: { status: { type: this.threadStatus }, turns: [] } } as T;
    return {} as T;
  }
  onNotification(listener: (method: string, params: unknown) => void) { this.events.on("notification", listener); return () => this.events.off("notification", listener); }
  onReady(listener: () => void) { this.events.on("ready", listener); return () => this.events.off("ready", listener); }
  onUnavailable(listener: (kind: EndpointLossKind) => void) { this.events.on("unavailable", listener); return () => this.events.off("unavailable", listener); }
  onPermissionBlocked(listener: (event: PermissionBlockedEvent) => void) { this.events.on("permission", listener); return () => this.events.off("permission", listener); }
  fail(kind: EndpointLossKind = "connection-lost") { this.state = "unavailable"; this.events.emit("unavailable", kind); }
}

function fixture() {
  const local = new FakeEndpoint("local");
  const remotes = new Map<string, FakeEndpoint>();
  const commits: string[] = [];
  let reloads = 0;
  const manager = new EndpointManager({
    localEndpoint: local,
    catalog: {
      reload: async () => { reloads += 1; },
      require: (id: string) => ({ id, type: "ssh" as const, projectsRoot: "~/qiyan-projects" }),
    },
    createRemote: async (definition) => {
      const endpoint = remotes.get(definition.id) ?? new FakeEndpoint(definition.id);
      remotes.set(definition.id, endpoint);
      return { endpoint, pendingBinding: { endpointId: definition.id, destination: { hostname: definition.id, user: "xin", port: 22 } } };
    },
    hasIdentityReferences: () => true,
    commitBinding: (binding) => { commits.push(binding.endpointId); },
    managedThreadIds: (id) => id === "devbox" ? ["thread-1"] : [],
  });
  return { manager, local, remotes, commits, reloads: () => reloads };
}

test("local is the default and SSH endpoints are created lazily", async () => {
  const value = fixture();
  assert.equal(value.manager.normalize(), "local");
  assert.equal((await value.manager.ensureReady()).id, "local");
  assert.equal(value.remotes.size, 0);
  assert.equal((await value.manager.ensureReady("devbox")).id, "devbox");
  assert.equal(value.remotes.size, 1);
  assert.equal(value.reloads(), 1);
  assert.deepEqual(value.commits, ["devbox"]);
});

test("failed activation commits no destination and does not replace the published generation", async () => {
  const value = fixture();
  const remote = new FakeEndpoint("offline");
  remote.failStart = true;
  value.remotes.set("offline", remote);
  await assert.rejects(value.manager.ensureReady("offline"), /offline/u);
  assert.deepEqual(value.commits, []);
  assert.throws(() => value.manager.endpointGeneration("offline"), /unavailable/u);
});

test("startup activation isolates an unavailable referenced endpoint", async () => {
  const value = fixture();
  const offline = new FakeEndpoint("offline");
  offline.failStart = true;
  value.remotes.set("offline", offline);
  const result = await value.manager.activateReferenced(["offline", "healthy"]);
  assert.deepEqual(result.unavailable, ["offline"]);
  assert.equal(value.manager.endpointGeneration("healthy").endpoint.state, "ready");
});

test("an unavailable referenced endpoint keeps retrying without blocking startup", async () => {
  const local = new FakeEndpoint("local");
  const remote = new FakeEndpoint("offline");
  remote.failStart = true;
  const scheduled: Array<() => void> = [];
  const manager = new EndpointManager({
    localEndpoint: local,
    catalog: { reload: async () => undefined, require: () => ({ id: "offline", type: "ssh" as const, projectsRoot: "~/qiyan-projects" }) },
    createRemote: async () => ({ endpoint: remote }),
    hasIdentityReferences: () => true,
    managedThreadIds: () => [],
    schedule: (_delay, run) => { scheduled.push(run); return { cancel: () => undefined }; },
  });
  assert.deepEqual(await manager.activateReferenced(["offline"]), { unavailable: ["offline"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 1);
  remote.failStart = false;
  scheduled.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.endpointGeneration("offline").endpoint.state, "ready");
});

test("disconnect drains admitted work, rejects new work, proves idle, and stops only that runtime", async () => {
  const value = fixture();
  await value.manager.ensureReady("devbox");
  let release!: () => void;
  let admitted!: () => void;
  const reached = new Promise<void>((resolve) => { admitted = resolve; });
  const held = value.manager.withWorkLease("devbox", "file-transfer", async () => {
    admitted();
    await new Promise<void>((resolve) => { release = resolve; });
  });
  await reached;
  const disconnecting = value.manager.disconnect("devbox");
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(value.manager.withWorkLease("devbox", "rpc", async () => undefined), /draining/u);
  release();
  await held;
  await disconnecting;
  assert.equal(value.remotes.get("devbox")!.runtimeStops, 1);
  assert.equal(value.manager.desiredState("devbox"), "disconnected");
});

test("concurrent disconnects serialize and stop one exact runtime generation", async () => {
  const value = fixture();
  await value.manager.ensureReady("devbox");
  const checkpoints: unknown[] = [];
  await Promise.all([
    value.manager.disconnect("devbox", (item) => checkpoints.push(item)),
    value.manager.disconnect("devbox", (item) => checkpoints.push(item)),
  ]);
  assert.equal(value.remotes.get("devbox")!.runtimeStops, 1);
  assert.deepEqual(checkpoints.map((item) => (item as { phase: string }).phase), ["draining", "idle_proven", "runtime_stopped"]);
});

test("disconnect stops an attested unavailable orphan without requiring a ready connection", async () => {
  const value = fixture();
  const orphan = await value.manager.ensureReady("orphan") as FakeEndpoint;
  orphan.state = "unavailable";
  await value.manager.disconnect("orphan");
  assert.equal(orphan.starts, 1);
  assert.equal(orphan.runtimeStops, 1);
  assert.equal(value.manager.desiredState("orphan"), "disconnected");
});

test("shutdown fences a reconnect whose identity-reference check resolves late", async () => {
  const local = new FakeEndpoint("local");
  const remote = new FakeEndpoint("devbox");
  let resolveReferences!: (value: boolean) => void;
  const references = new Promise<boolean>((resolve) => { resolveReferences = resolve; });
  let referenceChecks = 0;
  const scheduled: Array<() => void> = [];
  const manager = new EndpointManager({
    localEndpoint: local,
    catalog: { reload: async () => undefined, require: () => ({ id: "devbox", type: "ssh" as const, projectsRoot: "~/qiyan-projects" }) },
    createRemote: async () => ({ endpoint: remote }),
    hasIdentityReferences: () => referenceChecks++ === 0 ? true : references,
    managedThreadIds: () => [],
    schedule: (_delay, run) => { scheduled.push(run); return { cancel: () => undefined }; },
  });
  await manager.ensureReady("devbox");
  remote.fail();
  await manager.closeConnections();
  resolveReferences(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(scheduled, []);
  assert.equal(remote.starts, 1);
});

test("disconnect recovery confirms an already-absent exact runtime without starting a replacement", async () => {
  const value = fixture();
  const remote = new FakeEndpoint("orphan");
  remote.identityAvailable = false;
  value.remotes.set("orphan", remote);
  const checkpoints: unknown[] = [];
  await value.manager.recoverDisconnect("orphan", "draining", { kind: "ssh", token: "a".repeat(32), pid: 10, linuxStartTime: "20", processGroupId: 10 }, (checkpoint) => checkpoints.push(checkpoint));
  assert.equal(remote.starts, 0);
  assert.equal(remote.runtimeStops, 0);
  assert.equal(value.manager.desiredState("orphan"), "disconnected");
  assert.deepEqual(checkpoints, [{ phase: "runtime_stopped", identity: { kind: "ssh", token: "a".repeat(32), pid: 10, linuxStartTime: "20", processGroupId: 10 } }]);
});

test("restart recovery accepts the checkpointed replacement without restarting it again", async () => {
  const value = fixture();
  const remote = await value.manager.ensureReady("devbox") as FakeEndpoint;
  const identity = await remote.runtimeIdentity();
  assert.ok(identity);
  await value.manager.recoverRestart("devbox", "runtime_started", identity);
  assert.equal(remote.starts, 1);
  assert.equal(remote.runtimeStops, 0);

  remote.identityToken = "b".repeat(32);
  await assert.rejects(value.manager.recoverRestart("devbox", "runtime_started", identity), /identity changed/u);
  assert.equal(remote.runtimeStops, 0);
});

test("restart recovery durably checkpoints the stopped and replacement runtime identities", async () => {
  const value = fixture();
  const remote = await value.manager.ensureReady("devbox") as FakeEndpoint;
  const identity = await remote.runtimeIdentity();
  assert.ok(identity);
  remote.rotateIdentityOnStop = true;
  const checkpoints: unknown[] = [];

  await value.manager.recoverRestart("devbox", "draining", identity, (checkpoint) => checkpoints.push(checkpoint));

  assert.deepEqual(checkpoints.map((checkpoint) => (checkpoint as { phase: string }).phase), ["runtime_stopped", "runtime_started"]);
});

test("runtime-stopped restart recovery refuses to relabel the old runtime as its replacement", async () => {
  const value = fixture();
  const remote = await value.manager.ensureReady("devbox") as FakeEndpoint;
  const identity = await remote.runtimeIdentity();
  assert.ok(identity);

  await assert.rejects(value.manager.recoverRestart("devbox", "runtime_stopped", identity), /replacement|identity changed/u);
});

test("restart prepares the replacement before stopping the current runtime", async () => {
  const value = fixture();
  const current = await value.manager.ensureReady("devbox") as FakeEndpoint;
  value.remotes.delete("devbox");
  let failPreparation = true;
  const original = value.manager as unknown as { options: { createRemote: (definition: { id: string }, refs: boolean) => Promise<unknown> } };
  const create = original.options.createRemote;
  original.options.createRemote = async (definition, refs) => {
    if (failPreparation) throw new Error("SSH preflight failed");
    return create(definition as never, refs);
  };
  await assert.rejects(value.manager.restart("devbox"), /preflight failed/u);
  assert.equal(current.runtimeStops, 0);
  failPreparation = false;
});

test("restart refuses a replacement that retains the stopped runtime identity", async () => {
  const value = fixture();
  await value.manager.ensureReady("devbox");

  await assert.rejects(value.manager.restart("devbox"), /replacement|identity/u);
});

test("active history prevents disconnect and reopens admission without stopping", async () => {
  const value = fixture();
  const endpoint = await value.manager.ensureReady("devbox") as FakeEndpoint;
  endpoint.threadStatus = "active";
  await assert.rejects(value.manager.disconnect("devbox"), /not idle/u);
  assert.equal(endpoint.runtimeStops, 0);
  assert.equal(value.manager.desiredState("devbox"), "automatic");
  await value.manager.withWorkLease("devbox", "rpc", async () => undefined);
});

test("leases reject foreign generations and old endpoint callbacks cannot replace a newer generation", async () => {
  const value = fixture();
  const first = await value.manager.ensureReady("devbox") as FakeEndpoint;
  let captured: import("../../src/endpoints/types.ts").EndpointWorkLease | undefined;
  await value.manager.withWorkLease("devbox", "rpc", async (_endpoint, lease) => { captured = lease; });
  assert.equal(value.manager.validateWorkLease(captured!, "devbox"), false);

  first.fail("connection-lost");
  const second = new FakeEndpoint("devbox");
  value.remotes.set("devbox", second);
  await value.manager.ensureReady("devbox");
  first.fail("runtime-lost");
  assert.equal(value.manager.endpointGeneration("devbox").endpoint, second);
});
