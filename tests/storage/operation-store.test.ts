import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "../../src/storage/database.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";

test("an identical operation replay returns its stored receipt", () => {
  const db = createTestDatabase();
  const store = new OperationStore(db);
  const first = store.prepare({ contextId: "ctx", attemptId: "a1", callId: "c1", kind: "send", args: { text: "x" } });
  store.markDispatched(first.id);
  store.succeed(first.id, { turnId: "turn-1" });

  const replay = store.prepare({ contextId: "ctx", attemptId: "a1", callId: "c1", kind: "send", args: { text: "x" } });
  assert.equal(replay.state, "succeeded");
  assert.deepEqual(replay.receipt, { turnId: "turn-1" });
});

test("changing arguments for an existing operation is rejected", () => {
  const db = createTestDatabase();
  const store = new OperationStore(db);
  store.prepare({ contextId: "ctx", attemptId: "a1", callId: "c1", kind: "send", args: { text: "x" } });

  assert.throws(
    () => store.prepare({ contextId: "ctx", attemptId: "a1", callId: "c1", kind: "send", args: { text: "y" } }),
    (error: unknown) => error instanceof Error && error.message.includes("OPERATION_CONFLICT"),
  );
});

test("a context with dispatched effects is atomically superseded once", () => {
  const db = createTestDatabase();
  const store = new OperationStore(db);
  store.createSourceContext({ id: "ctx", kind: "event_batch", sourceId: "batch", rawText: "", attachmentIds: [] });
  const operation = store.prepare({ contextId: "ctx", attemptId: "a1", callId: "c1", kind: "send", args: {} });
  store.markDispatched(operation.id);

  const recovery = store.supersedeWithRecovery("ctx", [{ operationId: operation.id, state: "uncertain" }]);
  const replay = store.supersedeWithRecovery("ctx", [{ operationId: operation.id, state: "uncertain" }]);
  assert.equal(recovery.id, replay.id);
  assert.equal(store.getSourceContext("ctx")?.supersededBy, recovery.id);
});
