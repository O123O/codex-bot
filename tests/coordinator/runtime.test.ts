import assert from "node:assert/strict";
import test from "node:test";
import { CoordinatorRuntime } from "../../src/coordinator/runtime.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";

test("user coordinator finals are durable deliveries while internal finals are suppressed", () => {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "1", rawText: "question", attachmentIds: [] });
  operations.createSourceContext({ id: "batch", kind: "event_batch", sourceId: "b1", rawText: "", attachmentIds: [] });
  const runtime = new CoordinatorRuntime(db, operations, deliveries, { destination: "42" });
  runtime.beginUserAttempt("ctx", "attempt", "turn-user");
  runtime.handleTerminal("turn-user", "answer");
  runtime.beginInternalAttempt("batch", "attempt-2", "turn-internal");
  runtime.handleTerminal("turn-internal", "do not send");
  assert.deepEqual(deliveries.listReady().map((item) => item.body), ["[coordinator] answer"]);
});

test("post-dispatch coordinator failure creates one recovery context with receipts", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "1", rawText: "go", attachmentIds: [] });
  const operation = operations.prepare({ contextId: "ctx", attemptId: "a", callId: "c", kind: "send", args: { x: 1 } });
  operations.markDispatched(operation.id);
  const runtime = new CoordinatorRuntime(db, operations, new DeliveryStore(db), { destination: "42" });
  runtime.beginUserAttempt("ctx", "a", "turn");
  const first = runtime.failAttempt("turn", new Error("lost"));
  const replay = runtime.failAttempt("turn", new Error("lost"));
  assert.equal(first?.id, replay?.id);
  assert.equal(first?.kind, "recovery");
  assert.match(first?.rawText ?? "", /uncertain/);
});
