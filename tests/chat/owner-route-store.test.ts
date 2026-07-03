import assert from "node:assert/strict";
import test from "node:test";
import { OwnerRouteStore } from "../../src/chat/owner-route-store.ts";
import { ConversationStore } from "../../src/storage/conversation-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";

const primary = { adapterId: "telegram", conversationKey: "telegram:42", destination: { chatId: "42" } } as const;
const slack = {
  adapterId: "slack",
  conversationKey: "slack:T1:dm:D1",
  destination: { workspaceId: "T1", channelId: "D1" },
  reply: { messageTs: "1.0" },
} as const;

test("latest owner route falls back to primary then follows newly accepted owner sources", () => {
  const db = createTestDatabase();
  const routes = new OwnerRouteStore(db, primary);
  const conversations = new ConversationStore(db, new DeliveryStore(db));
  assert.deepEqual(routes.current(), primary);

  conversations.acceptChatSource({
    id: "slack-source",
    nativeSourceId: "T1:D1:1.0",
    binding: slack,
    rawText: "hello",
    attachmentIds: [],
    failedAttachments: [],
    receivedAt: 1,
  });
  assert.deepEqual(routes.current(), slack);

  const first = routes.current() as unknown as { destination: { channelId: string } };
  first.destination.channelId = "mutated";
  assert.deepEqual(new OwnerRouteStore(db, primary).current(), slack);
});

test("a duplicate native source cannot replace its accepted route", () => {
  const db = createTestDatabase();
  const routes = new OwnerRouteStore(db, primary);
  const conversations = new ConversationStore(db, new DeliveryStore(db));
  conversations.acceptChatSource({ id: "first", nativeSourceId: "native", binding: slack, rawText: "one", attachmentIds: [], failedAttachments: [], receivedAt: 1 });
  conversations.acceptChatSource({
    id: "duplicate",
    nativeSourceId: "native",
    binding: { adapterId: "slack", conversationKey: "slack:T1:dm:D2", destination: { workspaceId: "T1", channelId: "D2" } },
    rawText: "two",
    attachmentIds: [],
    failedAttachments: [],
    receivedAt: 2,
  });
  assert.deepEqual(routes.current(), slack);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM source_contexts WHERE adapter_id = 'slack'").get()!.count, 1);
});
