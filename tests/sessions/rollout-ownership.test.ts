import assert from "node:assert/strict";
import { appendFile, mkdtemp, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OperationStore } from "../../src/storage/operation-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { RuntimeStore } from "../../src/storage/runtime-store.ts";
import { scanLocalRollout, SessionOwnershipGuard } from "../../src/sessions/rollout-ownership.ts";

function line(type: string, payload: unknown): string {
  return `${JSON.stringify({ timestamp: "2026-07-06T00:00:00.000Z", type, payload })}\n`;
}

test("incremental rollout scan returns only turn ownership metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-1.jsonl");
  const secret = "message body must not leave the scanner";
  await writeFile(path, "\n");
  const baseline = await scanLocalRollout({ path, threadId: "thread-1" });
  await appendFile(path, [
    line("event_msg", { type: "task_started", turn_id: "turn-1" }),
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: secret }] }),
    line("event_msg", { type: "user_message", message: secret, client_id: "context-1:call-1" }),
    line("event_msg", { type: "task_complete", turn_id: "turn-1", last_agent_message: secret }),
  ].join(""));

  const result = await scanLocalRollout({ path, threadId: "thread-1", cursor: baseline.cursor });

  assert.deepEqual(result.starts, [{ turnId: "turn-1", clientId: "context-1:call-1" }]);
  assert.equal(result.openTurn, undefined);
  assert.equal(result.cursor.offset, Buffer.byteLength(await readFile(path)));
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("an ownerless user turn is external while an incomplete line remains unconsumed", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-2.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const baseline = await scanLocalRollout({ path, threadId: "thread-2" });

  const partial = line("event_msg", { type: "task_started", turn_id: "external" }).trimEnd();
  await appendFile(path, partial);
  const waiting = await scanLocalRollout({ path, threadId: "thread-2", cursor: baseline.cursor });
  assert.deepEqual(waiting.starts, []);
  assert.deepEqual(waiting.cursor, baseline.cursor);

  await appendFile(path, `\n${line("event_msg", { type: "user_message" })}`);
  const detected = await scanLocalRollout({ path, threadId: "thread-2", cursor: baseline.cursor });
  assert.deepEqual(detected.starts, [{ turnId: "external" }]);
  assert.deepEqual(detected.openTurn, { turnId: "external" });
  assert.equal(detected.cursor.offset, Buffer.byteLength(await readFile(path)));
});

test("a complete task start without its user record remains unclassified", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-boundary.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const operations = new OperationStore(db);
  const identity = { endpoint: "local", thread_id: "thread-boundary", mapping_id: "mapping-boundary" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "idle");
  const guard = new SessionOwnershipGuard(db, runtime, operations, {
    scan: async (_endpointId, requests) => Promise.all(requests.map((request) => scanLocalRollout(request))),
  });
  await guard.initialize(identity, path);
  await appendFile(path, line("event_msg", { type: "task_started", turn_id: "not-yet-classified" }));

  assert.deepEqual(await guard.inspect(identity), { state: "unclassified", turnId: "not-yet-classified" });
  assert.equal(runtime.getSession(identity.endpoint, identity.thread_id, identity.mapping_id)?.managementState, "managed");
});

test("a completed external turn takes precedence over a trailing unclassified start", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-precedence.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const operations = new OperationStore(db);
  const identity = { endpoint: "local", thread_id: "thread-precedence", mapping_id: "mapping-precedence" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "idle");
  const guard = new SessionOwnershipGuard(db, runtime, operations, {
    scan: async (_endpointId, requests) => Promise.all(requests.map((request) => scanLocalRollout(request))),
  });
  await guard.initialize(identity, path);
  await appendFile(path, [
    line("event_msg", { type: "task_started", turn_id: "external-first" }),
    line("event_msg", { type: "user_message" }),
    line("event_msg", { type: "task_complete", turn_id: "external-first" }),
    line("event_msg", { type: "task_started", turn_id: "boundary-after" }),
  ].join(""));

  assert.deepEqual(await guard.inspect(identity), { state: "external", turnId: "external-first" });
  assert.equal(runtime.getSession(identity.endpoint, identity.thread_id, identity.mapping_id)?.managementState, "unadopting");
});

test("a cursor cannot cross rollout replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-3.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const baseline = await scanLocalRollout({ path, threadId: "thread-3" });
  const replacement = join(root, "replacement");
  await writeFile(replacement, line("event_msg", { type: "task_started", turn_id: "external" }));
  await rename(replacement, path);

  await assert.rejects(scanLocalRollout({ path, threadId: "thread-3", cursor: baseline.cursor }), /rollout identity changed/u);
});

test("initialization scans transcripts larger than the former whole-file buffer limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-large.jsonl");
  const file = await open(path, "w");
  try {
    const blankMegabyte = Buffer.alloc(1024 * 1024, 0x0a);
    for (let index = 0; index < 65; index += 1) await file.write(blankMegabyte);
    await file.write(line("event_msg", { type: "task_complete", turn_id: "historical" }));
  } finally {
    await file.close();
  }

  const result = await scanLocalRollout({ path, threadId: "thread-large" });

  assert.equal(result.cursor.offset, (await stat(path)).size);
  assert.equal(result.openTurn, undefined);
});

test("the guard advances owned turns and durably fences the first external turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-4.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const operations = new OperationStore(db);
  const identity = { endpoint: "local", thread_id: "thread-4", mapping_id: "mapping-4" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "idle");
  const guard = new SessionOwnershipGuard(db, runtime, operations, {
    scan: async (_endpointId, requests) => Promise.all(requests.map((request) => scanLocalRollout(request))),
  });
  await guard.initialize(identity, path);

  operations.prepare({ contextId: "ctx", attemptId: "attempt", callId: "call", kind: "send_to_session", args: { nickname: "worker", content: "private" } });
  await appendFile(path, [
    line("event_msg", { type: "task_started", turn_id: "owned" }),
    line("event_msg", { type: "user_message", client_id: "ctx:call" }),
    line("event_msg", { type: "task_complete", turn_id: "owned" }),
  ].join(""));
  assert.deepEqual(await guard.inspect(identity), { state: "owned" });
  assert.equal(guard.ownsTurn(identity, "owned"), true);
  assert.equal(guard.ownsTurn(identity, "external"), false);
  assert.equal(runtime.getSession(identity.endpoint, identity.thread_id, identity.mapping_id)?.managementState, "managed");

  await appendFile(path, [
    line("event_msg", { type: "task_started", turn_id: "external" }),
    line("event_msg", { type: "user_message" }),
  ].join(""));
  assert.deepEqual(await guard.inspect(identity), { state: "external", turnId: "external" });
  assert.equal(runtime.getSession(identity.endpoint, identity.thread_id, identity.mapping_id)?.managementState, "unadopting");
  assert.deepEqual(await guard.inspect(identity), { state: "external", turnId: "external" });

  operations.prepare({ contextId: "ctx-after", attemptId: "attempt-after", callId: "call-after", kind: "send_to_session", args: { nickname: "worker", content: "late" } });
  await appendFile(path, [
    line("event_msg", { type: "task_started", turn_id: "owned-after-fence" }),
    line("event_msg", { type: "user_message", client_id: "ctx-after:call-after" }),
  ].join(""));
  assert.deepEqual(await guard.inspect(identity), { state: "external", turnId: "external" });
  assert.equal(guard.ownsTurn(identity, "owned-after-fence"), true);
});

test("initialization durably fences an already active external turn for managed-session recovery", async () => {
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const operations = new OperationStore(db);
  const identity = { endpoint: "local", thread_id: "thread-recovery", mapping_id: "mapping-recovery" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "idle");
  const cursor = { device: "1", inode: "2", offset: 100 };
  const guard = new SessionOwnershipGuard(db, runtime, operations, {
    scan: async () => [{ cursor, starts: [{ turnId: "external-active" }], openTurn: { turnId: "external-active" } }],
  });

  await assert.rejects(guard.initialize(identity, "/tmp/rollout-thread-recovery.jsonl"), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "SESSION_BUSY");
    return true;
  });

  assert.deepEqual(await guard.inspect(identity), { state: "external", turnId: "external-active" });
  assert.equal(runtime.getSession(identity.endpoint, identity.thread_id, identity.mapping_id)?.managementState, "unadopting");
});
