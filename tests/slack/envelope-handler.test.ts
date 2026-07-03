import assert from "node:assert/strict";
import test from "node:test";
import { SlackEnvelopeHandler } from "../../src/slack/envelope-handler.ts";
import { SlackInboxStore } from "../../src/slack/inbox-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";

const mention = {
  type: "event_callback", team_id: "T1", event_id: "E1", event_time: 1,
  event: { type: "app_mention", channel: "C1", user: "U1", ts: "1.0", text: "<@B1> start" },
};
const followUp = {
  type: "event_callback", team_id: "T1", event_id: "E2", event_time: 1,
  event: { type: "message", channel_type: "channel", channel: "C1", user: "U1", ts: "2.0", thread_ts: "1.0", text: "continue" },
};

function handler(store: SlackInboxStore) {
  return new SlackEnvelopeHandler(store, { teamId: "T1", ownerUserId: "U1", botUserId: "B1", now: () => 1 });
}

test("mention activation and inbox commit happen before ack so an immediate follow-up is retained", async () => {
  const db = createTestDatabase();
  const store = new SlackInboxStore(db);
  const value = handler(store);
  const observations: string[] = [];
  await value.handle({ body: mention, ack: async () => { observations.push(`ack:${db.prepare("SELECT COUNT(*) AS count FROM slack_inbox").get()!.count}`); } });
  await value.handle({ body: followUp, ack: async () => { observations.push("ack:follow-up"); } });
  assert.deepEqual(observations, ["ack:1", "ack:follow-up"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM slack_inbox").get()!.count, 2);
  assert.equal(store.isActivated("slack:T1:thread:C1:1.0"), true);
});

test("unauthorized content is acknowledged without retention", async () => {
  const db = createTestDatabase();
  const store = new SlackInboxStore(db);
  let acked = 0;
  await handler(store).handle({ body: { ...mention, event: { ...mention.event, user: "U2", text: "private secret" } }, ack: async () => { acked += 1; } });
  assert.equal(acked, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM slack_inbox").get()!.count, 0);
  assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM slack_inbox").all()), /private secret/u);
});

test("persistence failure prevents acknowledgement", async () => {
  const db = createTestDatabase();
  const store = new SlackInboxStore(db);
  db.exec("DROP TABLE slack_inbox");
  let acked = false;
  await assert.rejects(handler(store).handle({ body: mention, ack: async () => { acked = true; } }));
  assert.equal(acked, false);
});
