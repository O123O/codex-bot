import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";

const binding = { adapterId: "telegram", conversationKey: "telegram:42", destination: { chatId: "42" } } as const;

test("dispatched deliveries become uncertain during startup recovery", () => {
  const store = new DeliveryStore(createTestDatabase());
  const delivery = store.prepare({ kind: "worker_final", binding, body: "done", mandatory: true });
  store.markDispatched(delivery.id);
  store.recoverAfterCrash();
  assert.equal(store.get(delivery.id)?.state, "uncertain");
});

test("confirmed deliveries are never recovered as uncertain", () => {
  const store = new DeliveryStore(createTestDatabase());
  const delivery = store.prepare({ kind: "worker_final", binding, body: "done", mandatory: true });
  store.markDispatched(delivery.id);
  store.confirm(delivery.id, { messageId: 9 });
  store.recoverAfterCrash();
  assert.equal(store.get(delivery.id)?.state, "confirmed");
});
