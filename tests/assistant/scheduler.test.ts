import assert from "node:assert/strict";
import test from "node:test";
import { AssistantScheduler } from "../../src/assistant/scheduler.ts";

const event = (id: string, queuedStatus: "transient" | "final" = "final") => ({
  id,
  sessionKey: id.split(":")[0]!,
  payload: queuedStatus === "transient" ? { status: id } : { final: true, id },
});

test("events become forced after five completed conversation ownership periods", () => {
  const scheduler = new AssistantScheduler({ now: () => 0, batchWindowMs: 10_000 });
  scheduler.enqueueEvent(event("e1"));
  assert.equal(scheduler.peekEligibleEventBatch(1_000), undefined);
  for (let index = 0; index < 5; index += 1) scheduler.noteConversationPeriodCompleted();
  assert.deepEqual(scheduler.peekEligibleEventBatch(1_000)?.eventIds, ["e1"]);
  assert.equal(scheduler.peekEligibleEventBatch(1_000)?.forced, true);
});

test("peek is non-destructive and commit consumes exactly the frozen capped prefix", () => {
  const scheduler = new AssistantScheduler({ now: () => 0, batchWindowMs: 0, maxBatchEvents: 2, maxBatchBytes: 1_000 });
  scheduler.enqueueEvent(event("one:a"));
  scheduler.enqueueEvent(event("two:b"));
  scheduler.enqueueEvent(event("three:c"));
  const candidate = scheduler.peekEligibleEventBatch(0)!;
  assert.deepEqual(candidate.eventIds, ["one:a", "two:b"]);
  assert.deepEqual(scheduler.peekEligibleEventBatch(0)?.eventIds, candidate.eventIds);
  assert.throws(() => scheduler.commitEventBatch(candidate.batchId, ["wrong"]), /changed/u);
  assert.deepEqual(scheduler.peekEligibleEventBatch(0)?.eventIds, candidate.eventIds);
  scheduler.commitEventBatch(candidate.batchId, candidate.eventIds);
  assert.deepEqual(scheduler.peekEligibleEventBatch(0)?.eventIds, ["three:c"]);
});

test("transient events coalesce per session without reordering the durable queue", () => {
  const scheduler = new AssistantScheduler({ now: () => 0, batchWindowMs: 0 });
  scheduler.enqueueEvent(event("one:old", "transient"));
  scheduler.enqueueEvent(event("two:final"));
  scheduler.enqueueEvent(event("one:new", "transient"));
  const candidate = scheduler.peekEligibleEventBatch(0)!;
  assert.deepEqual(candidate.eventIds, ["one:new", "two:final"]);
});

test("batch window and 30-second maximum age expose the next lease-boundary wake", () => {
  let now = 5_000;
  const scheduler = new AssistantScheduler({ now: () => now, batchWindowMs: 1_000, maxEventAgeMs: 30_000 });
  scheduler.enqueueEvent(event("e"));
  assert.equal(scheduler.nextWakeAt(), 6_000);
  assert.equal(scheduler.peekEligibleEventBatch(5_999), undefined);
  assert.ok(scheduler.peekEligibleEventBatch(6_000));
  now = 35_000;
  assert.equal(scheduler.peekEligibleEventBatch()?.forced, true);
});
