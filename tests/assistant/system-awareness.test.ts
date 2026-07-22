import assert from "node:assert/strict";
import test from "node:test";
import { recordCompletedSystemAction } from "../../src/assistant/system-awareness.ts";
import { ConversationStore } from "../../src/storage/conversation-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";

test("a completed tool action notifies the originating chat without waking QiYan", () => {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const conversations = new ConversationStore(db, deliveries);
  const notice = {
    binding: { adapterId: "web", conversationKey: "web:owner", destination: { surface: "web" } },
    body: "[system] worker-a session compacted",
  };

  recordCompletedSystemAction(deliveries, "operation-1", notice);
  recordCompletedSystemAction(deliveries, "operation-1", notice);

  assert.equal(deliveries.get("tool-system:operation-1")?.body, "[system] worker-a session compacted");
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE id = 'tool-system:operation-1'").get() as { count: number }).count, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM source_contexts WHERE kind = 'system_notice'").get() as { count: number }).count, 0);
});
