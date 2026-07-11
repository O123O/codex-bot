import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "../../src/storage/database.ts";
import { ClaudeGoalStore } from "../../src/sessions/claude-goals.ts";
import { ClaudeGoalDriver } from "../../src/sessions/claude-goal-driver.ts";

const session = { nickname: "s1", endpointId: "claude-local", threadId: "t1" };

function harness(maxDrivenTurns = 3) {
  const goals = new ClaudeGoalStore(createTestDatabase());
  const enqueued: string[] = [];
  const driver = new ClaudeGoalDriver({ goals, now: () => 1, maxDrivenTurns, enqueue: (_s, message) => enqueued.push(message) });
  return { goals, driver, enqueued };
}

test("no goal → no drive", () => {
  const h = harness();
  h.driver.activate(session);
  h.driver.onTurnCompleted(session);
  assert.equal(h.enqueued.length, 0);
});

test("activate announces the goal; each completed turn continues it while active", () => {
  const h = harness();
  h.goals.set("claude-local", "t1", { objective: "ship it" }, 1);

  h.driver.activate(session);
  assert.equal(h.enqueued.length, 1);
  assert.match(h.enqueued[0]!, /A goal has been set for you: ship it/);
  assert.match(h.enqueued[0]!, /set_goal_status/); // tells the worker how to end it

  h.driver.onTurnCompleted(session);
  assert.equal(h.enqueued.length, 2);
  assert.match(h.enqueued[1]!, /Continue pursuing your goal/);
});

test("the worker marking the goal complete stops the drive", () => {
  const h = harness();
  h.goals.set("claude-local", "t1", { objective: "x" }, 1);
  h.driver.onTurnCompleted(session);
  assert.equal(h.enqueued.length, 1);

  h.goals.setStatus("claude-local", "t1", "complete", 1); // worker's set_goal_status
  h.driver.onTurnCompleted(session);
  assert.equal(h.enqueued.length, 1); // no further driving
});

test("a blocked goal stops the drive too", () => {
  const h = harness();
  h.goals.set("claude-local", "t1", { objective: "x" }, 1);
  h.goals.setStatus("claude-local", "t1", "blocked", 1);
  h.driver.onTurnCompleted(session);
  assert.equal(h.enqueued.length, 0);
});

test("the backstop cap pauses a goal the worker never ends (budgetLimited)", () => {
  const h = harness(3);
  h.goals.set("claude-local", "t1", { objective: "x" }, 1);
  for (let i = 0; i < 6; i += 1) h.driver.onTurnCompleted(session);
  assert.equal(h.enqueued.length, 3); // drove 3, then capped
  assert.equal(h.goals.get("claude-local", "t1")?.status, "budgetLimited");
});

test("re-setting a fresh objective resets the drive counter", () => {
  const h = harness(3);
  h.goals.set("claude-local", "t1", { objective: "x" }, 1);
  for (let i = 0; i < 6; i += 1) h.driver.onTurnCompleted(session); // capped at 3
  h.goals.set("claude-local", "t1", { objective: "y" }, 2); // new goal → counter reset, active again
  h.driver.activate(session);
  assert.equal(h.enqueued.length, 4); // drives again after reset
});
