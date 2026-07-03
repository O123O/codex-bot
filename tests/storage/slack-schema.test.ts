import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "../../src/storage/database.ts";

test("Slack storage has a durable inbox sequence, activation, and latest route", () => {
  const db = createTestDatabase();
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
  for (const name of ["slack_inbox", "slack_inbox_sequence", "activated_chat_conversations", "latest_owner_route"]) {
    assert.ok(tables.has(name), name);
  }
  const inboxColumns = new Set((db.prepare("PRAGMA table_info(slack_inbox)").all() as Array<{ name: string }>).map((row) => row.name));
  for (const name of ["event_id", "files_json", "file_state_json", "arrival_sequence", "state", "attempt_count", "received_at", "updated_at"]) {
    assert.ok(inboxColumns.has(name), name);
  }
  const sourceColumns = new Set((db.prepare("PRAGMA table_info(source_contexts)").all() as Array<{ name: string }>).map((row) => row.name));
  assert.ok(sourceColumns.has("failed_attachments_json"));
  assert.equal(db.prepare("SELECT next_value FROM slack_inbox_sequence WHERE singleton = 1").get()!.next_value, 1);
  db.prepare(`INSERT INTO slack_inbox
    (event_id, team_id, event_type, channel_id, message_ts, user_id, text, files_json, arrival_sequence, state, received_at, updated_at)
    VALUES ('E1', 'T1', 'message.im', 'D1', '1.0', 'U1', 'one', '[]', 1, 'pending', 1, 1)`).run();
  assert.throws(() => db.prepare(`INSERT INTO slack_inbox
    (event_id, team_id, event_type, channel_id, message_ts, user_id, text, files_json, arrival_sequence, state, received_at, updated_at)
    VALUES ('E2', 'T1', 'message.im', 'D1', '2.0', 'U1', 'two', '[]', 1, 'pending', 1, 1)`).run());
});
