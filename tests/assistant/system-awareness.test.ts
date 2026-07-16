import assert from "node:assert/strict";
import test from "node:test";
import { AssistantPostTurnActions, PostTurnActionRetry } from "../../src/assistant/post-turn-actions.ts";
import { recordAssistantSystemAwareness } from "../../src/assistant/system-awareness.ts";
import { ConversationStore } from "../../src/storage/conversation-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";

test("records one pending internal [system] message for a completed self action", () => {
  const db = createTestDatabase();
  const conversations = new ConversationStore(db, new DeliveryStore(db));

  assert.equal(recordAssistantSystemAwareness(conversations, "operation-1", "assistant session compacted", 100),
    "assistant-system:operation-1");
  assert.equal(recordAssistantSystemAwareness(conversations, "operation-1", "changed on retry", 200),
    "assistant-system:operation-1");

  assert.deepEqual({ ...db.prepare(`SELECT id, kind, source_id, raw_text, source_class, state, created_at
    FROM source_contexts WHERE id = 'assistant-system:operation-1'`).get() }, {
    id: "assistant-system:operation-1",
    kind: "system_notice",
    source_id: "operation-1",
    raw_text: "[system] assistant session compacted",
    source_class: "internal",
    state: "pending",
    created_at: 100,
  });
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM source_contexts WHERE kind = 'system_notice'").get() as { count: number }).count, 1);
});

test("does not record self-action awareness while completion is merely scheduled or uncertain", async () => {
  const db = createTestDatabase();
  const conversations = new ConversationStore(db, new DeliveryStore(db));
  let confirmed = false;
  const actions = new AssistantPostTurnActions(db, {
    compact: async (action) => {
      if (!confirmed) throw new PostTurnActionRetry("native completion is not visible");
      recordAssistantSystemAwareness(conversations, action.id, String(action.payload.awarenessBody), 100);
    },
  });

  actions.schedule("operation-1", "compact", { awarenessBody: "assistant session compacted" });
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM source_contexts WHERE kind = 'system_notice'").get() as { count: number }).count, 0);
  assert.deepEqual(await actions.drain(), { completed: 0, failed: 0, pending: 1 });
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM source_contexts WHERE kind = 'system_notice'").get() as { count: number }).count, 0);

  confirmed = true;
  assert.deepEqual(await actions.drain(), { completed: 1, failed: 0, pending: 0 });
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM source_contexts WHERE kind = 'system_notice'").get() as { count: number }).count, 1);
});
