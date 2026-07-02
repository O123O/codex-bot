import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "../../src/chat/binding.ts";
import type { ChatDeliveryAdapter } from "../../src/chat/contracts.ts";
import { ChatAdapterRegistry } from "../../src/chat/adapter-registry.ts";
import { DeliveryWorker } from "../../src/chat/delivery-worker.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";

class FakeAdapter implements ChatDeliveryAdapter {
  readonly sent: Array<{ destination: JsonValue; body: string }> = [];
  constructor(readonly id: string, private readonly receipt: JsonValue) {}
  async sendMessage(destination: JsonValue, body: string): Promise<JsonValue> {
    this.sent.push({ destination, body });
    return this.receipt;
  }
}

test("delivery worker routes by adapter and persists opaque binding and receipt", async () => {
  const db = createTestDatabase();
  const store = new DeliveryStore(db);
  const telegram = new FakeAdapter("telegram", { messageId: 7 });
  const slack = new FakeAdapter("slack", { ts: "1.2" });
  const worker = new DeliveryWorker(store, new ChatAdapterRegistry([telegram, slack]));
  const binding = { adapterId: "slack", conversationKey: "slack:C1:thread:9", destination: { channel: "C1", threadTs: "9" } } as const;
  const delivery = store.prepare({ id: "d1", kind: "chat", binding, body: "hello", mandatory: true });
  assert.deepEqual(store.get("d1")?.binding, binding);
  await worker.processOne(delivery.id);
  assert.deepEqual(store.get("d1")?.receipt, { ts: "1.2" });
  assert.deepEqual(slack.sent, [{ destination: { channel: "C1", threadTs: "9" }, body: "hello" }]);
  assert.equal(telegram.sent.length, 0);
});

test("same destination JSON does not erase distinct conversation keys", () => {
  const store = new DeliveryStore(createTestDatabase());
  const first = store.prepare({
    id: "one", kind: "chat", binding: { adapterId: "slack", conversationKey: "slack:C1", destination: { channel: "C1" } }, body: "1", mandatory: true,
  });
  const second = store.prepare({
    id: "two", kind: "chat", binding: { adapterId: "slack", conversationKey: "slack:C1:T2", destination: { channel: "C1" } }, body: "2", mandatory: true,
  });
  assert.notEqual(first.binding.conversationKey, second.binding.conversationKey);
});
