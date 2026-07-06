import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppError } from "../../src/core/errors.ts";
import { SessionRegistry } from "../../src/registry/session-registry.ts";
import { externalOwnershipEventPayload, SessionOwnershipWatcher } from "../../src/sessions/ownership-watcher.ts";

async function registryFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "qiyan-ownership-watcher-")));
  return SessionRegistry.open(join(root, "sessions.json"), {
    version: 3,
    assistant: { endpoint: "local", thread_id: "assistant", project_dir: root },
    sessions: {
      worker: { endpoint: "local", thread_id: "thread-1", project_dir: root, mapping_id: "mapping-1", lifecycle_state: "managed" },
    },
  });
}

test("an external turn is reported and automatically unadopted", async () => {
  const registry = await registryFixture();
  const removed: string[] = [];
  const notifications: string[] = [];
  const watcher = new SessionOwnershipWatcher(
    registry,
    { inspect: async () => ({ state: "external", turnId: "external-turn" }) },
    { unadopt: async (nickname) => {
      const session = registry.get(nickname)!;
      await registry.transition(nickname, session, "unadopting");
      await registry.removeIfMatch(nickname, session);
      removed.push(nickname);
    } },
    {
      onExternal: (incident) => { notifications.push(`pending:${incident.nickname}:${incident.turnId}`); },
      onReleased: (incident) => {
        assert.equal(registry.get(incident.nickname), undefined);
        notifications.push(`released:${incident.nickname}:${incident.turnId}`);
      },
    },
  );

  await watcher.reconcileEndpoint("local");

  assert.deepEqual(notifications, ["pending:worker:external-turn", "released:worker:external-turn"]);
  assert.deepEqual(removed, ["worker"]);
  assert.equal(registry.get("worker"), undefined);
});

test("a busy external turn remains pending without a false released notification", async () => {
  const registry = await registryFixture();
  const notifications: string[] = [];
  const watcher = new SessionOwnershipWatcher(
    registry,
    { inspect: async () => ({ state: "external", turnId: "external-turn" }) },
    { unadopt: async () => { throw new AppError("SESSION_BUSY", "external turn is active"); } },
    {
      onExternal: () => { notifications.push("pending"); },
      onReleased: () => { notifications.push("released"); },
    },
  );

  await watcher.reconcileEndpoint("local");

  assert.deepEqual(notifications, ["pending"]);
  assert.equal(registry.get("worker")?.lifecycle_state, "managed");
});

test("external ownership event payloads explicitly distinguish pending and completed release", () => {
  const incident = { nickname: "worker", endpoint: "local", thread_id: "thread-1", mapping_id: "mapping-1", turnId: "external-turn" };
  assert.deepEqual(externalOwnershipEventPayload(incident, "pending"), {
    event: "external_worker_turn_detected",
    releaseStatus: "pending",
    nickname: "worker",
    mappingId: "mapping-1",
    turnId: "external-turn",
  });
  assert.deepEqual(externalOwnershipEventPayload(incident, "completed"), {
    event: "external_worker_session_released",
    releaseStatus: "completed",
    nickname: "worker",
    mappingId: "mapping-1",
    turnId: "external-turn",
  });
});

test("ownership inspection is serialized with session dispatch", async () => {
  const registry = await registryFixture();
  const seen: string[] = [];
  const watcher = new SessionOwnershipWatcher(
    registry,
    { inspect: async () => { seen.push("inspect"); return { state: "owned" }; } },
    { unadopt: async () => undefined },
    { onExternal: async () => undefined, onReleased: async () => undefined },
    { run: async (endpointId, threadId, inspect) => {
      seen.push(`gate:${endpointId}:${threadId}:start`);
      const result = await inspect();
      seen.push(`gate:${endpointId}:${threadId}:end`);
      return result;
    } },
  );

  await watcher.reconcileEndpoint("local");

  assert.deepEqual(seen, ["gate:local:thread-1:start", "inspect", "gate:local:thread-1:end"]);
});

test("an unavailable mapping without an initialized rollout guard is isolated", async () => {
  const registry = await registryFixture();
  let inspected = false;
  const watcher = new SessionOwnershipWatcher(
    registry,
    { inspect: async () => { inspected = true; throw new Error("guard is not initialized"); } },
    { unadopt: async () => undefined },
    { onExternal: async () => undefined, onReleased: async () => undefined, isInspectable: () => false },
  );

  await watcher.reconcileEndpoint("local");

  assert.equal(inspected, false);
});
