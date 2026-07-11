import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "../../src/storage/database.ts";
import { ScheduledSendOutbox } from "../../src/scheduling/send-outbox.ts";

test("a fire key is claimable once; a concurrent claim sees it in-flight", () => {
  const outbox = new ScheduledSendOutbox(createTestDatabase());
  assert.equal(outbox.claim("k1", "s1", "msg", 1000), "claimed");
  assert.equal(outbox.claim("k1", "s1", "msg", 1000), "in-flight"); // second instance loses the race
  outbox.markSent("k1");
  assert.equal(outbox.claim("k1", "s1", "msg", 1000), "delivered"); // already delivered
});

test("release after a failed send lets the key be re-claimed (at-least-once)", () => {
  const outbox = new ScheduledSendOutbox(createTestDatabase());
  assert.equal(outbox.claim("k1", "s1", "msg", 1000), "claimed");
  outbox.release("k1"); // send failed
  assert.equal(outbox.claim("k1", "s1", "msg", 2000), "claimed"); // re-claimable
});

test("a stale 'sending' row (crashed mid-send) is reclaimed by age, not lost", () => {
  const outbox = new ScheduledSendOutbox(createTestDatabase(), 60_000);
  assert.equal(outbox.claim("k1", "s1", "msg", 1000), "claimed");
  // another poll far later finds the crashed row and reclaims it
  assert.equal(outbox.claim("k1", "s1", "msg", 1000 + 61_000), "claimed");
  // but not before the stale window elapses
  outbox.markSent("k1");
  assert.equal(outbox.claim("k1", "s1", "msg", 1000 + 122_000), "delivered");
});
