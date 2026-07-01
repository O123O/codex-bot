import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "../../src/storage/database.ts";
import { RuntimeStore } from "../../src/storage/runtime-store.ts";

test("consumes pending settings once after a proven start", () => {
  const store = new RuntimeStore(createTestDatabase());
  store.setSession("local", "thread", "managed", "idle");
  store.setModel("local", "thread", "gpt-5");
  store.setEffort("local", "thread", "high");
  const expected = store.settings("local", "thread");
  assert.deepEqual(store.consumeSettings("local", "thread", expected), { model: "gpt-5", effort: "high" });
  assert.deepEqual(store.settings("local", "thread"), {});
  assert.deepEqual(store.consumeSettings("local", "thread", expected), { model: "gpt-5", effort: "high" });
});

test("compare-and-clear preserves a replacement queued while a turn starts", () => {
  const store = new RuntimeStore(createTestDatabase());
  store.setSession("local", "thread", "managed", "idle");
  store.setModel("local", "thread", "old-model");
  const dispatched = store.settings("local", "thread");
  store.setModel("local", "thread", "next-model");
  assert.deepEqual(store.consumeSettings("local", "thread", dispatched), { model: "old-model" });
  assert.deepEqual(store.settings("local", "thread"), { model: "next-model" });
});

test("older native observations cannot regress status or active turn", () => {
  const store = new RuntimeStore(createTestDatabase());
  store.setSession("local", "thread", "managed", "idle");
  assert.equal(store.reconcileNativeState("local", "thread", "active", "turn-2", 2), true);
  assert.equal(store.reconcileNativeState("local", "thread", "idle", undefined, 1), false);
  assert.equal(store.clearActiveTurn("local", "thread", "turn-2", 1), false);
  assert.equal(store.activeTurn("local", "thread"), "turn-2");
  assert.equal(store.clearActiveTurn("local", "thread", "turn-2", 3), true);
  assert.equal(store.getSession("local", "thread")?.nativeStatus, "idle");
  assert.equal(store.getSession("local", "thread")?.nativeObservationSequence, 3);
});
