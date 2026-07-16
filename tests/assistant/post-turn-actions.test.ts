import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../src/core/errors.ts";
import {
  AssistantPostTurnActions,
  PostTurnActionRetry,
  type AssistantPostTurnAction,
} from "../../src/assistant/post-turn-actions.ts";
import { createTestDatabase } from "../../src/storage/database.ts";

test("post-turn actions schedule idempotently and reject a changed payload", () => {
  const db = createTestDatabase();
  const actions = new AssistantPostTurnActions(db, {});

  assert.equal(actions.schedule("op-1", "compact", { threadId: "thread-1" }), true);
  assert.equal(actions.schedule("op-1", "compact", { threadId: "thread-1" }), false);
  assert.throws(
    () => actions.schedule("op-1", "compact", { threadId: "thread-2" }),
    (error: unknown) => error instanceof AppError && error.code === "OPERATION_CONFLICT",
  );
  assert.deepEqual(actions.get("op-1"), {
    id: "op-1", kind: "compact", payload: { threadId: "thread-1" }, state: "pending",
  });
});

test("post-turn drain is serialized, ordered, and persists handler checkpoints", async () => {
  const db = createTestDatabase();
  const seen: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const actions = new AssistantPostTurnActions(db, {
    compact: async (action, context) => {
      seen.push(`start:${action.id}`);
      context.checkpoint({ ...action.payload, baseline: [action.id] });
      if (action.id === "op-1") await barrier;
      seen.push(`end:${action.id}`);
    },
  });
  actions.schedule("op-1", "compact", { threadId: "thread-1" });
  actions.schedule("op-2", "compact", { threadId: "thread-1" });

  const first = actions.drain();
  const second = actions.drain();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["start:op-1"]);
  assert.deepEqual(actions.get("op-1"), {
    id: "op-1", kind: "compact", payload: { threadId: "thread-1", baseline: ["op-1"] }, state: "running",
  });
  release();
  await Promise.all([first, second]);

  assert.deepEqual(seen, ["start:op-1", "end:op-1", "start:op-2", "end:op-2"]);
  assert.equal(actions.get("op-1")?.state, "completed");
  assert.equal(actions.get("op-2")?.state, "completed");
});

test("a new post-turn action owner reconciles running rows from durable evidence", async () => {
  const db = createTestDatabase();
  const first = new AssistantPostTurnActions(db, {
    compact: async (_action, context) => {
      context.checkpoint({ threadId: "thread-1", baseline: ["compact-old"] });
      throw new PostTurnActionRetry("simulated process loss");
    },
  });
  first.schedule("op-1", "compact", { threadId: "thread-1" });
  await first.drain();
  assert.equal(first.get("op-1")?.state, "pending");

  const recovered: AssistantPostTurnAction[] = [];
  const second = new AssistantPostTurnActions(db, {
    compact: async (action) => { recovered.push(action); },
  });
  await second.drain();

  assert.deepEqual(recovered.map((action) => action.payload), [{ threadId: "thread-1", baseline: ["compact-old"] }]);
  assert.equal(second.get("op-1")?.state, "completed");
});

test("post-turn action failure is retained and does not block later actions", async () => {
  const db = createTestDatabase();
  const completed: string[] = [];
  const actions = new AssistantPostTurnActions(db, {
    compact: async (action) => {
      if (action.id === "bad") throw new Error("compact failed");
      completed.push(action.id);
    },
  });
  actions.schedule("bad", "compact", {});
  actions.schedule("good", "compact", {});

  const result = await actions.drain();

  assert.deepEqual(result, { completed: 1, failed: 1, pending: 0 });
  assert.equal(actions.get("bad")?.state, "failed");
  assert.equal(actions.get("good")?.state, "completed");
  assert.deepEqual(completed, ["good"]);
});
