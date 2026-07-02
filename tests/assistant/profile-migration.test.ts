import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantRuntime } from "../../src/assistant/runtime.ts";
import { recoverAssistantProfileAttempts } from "../../src/assistant/profile-migration.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";
import { FinalMessageStore } from "../../src/sessions/final-messages.ts";

test("legacy migration delivers completed rollout state and safely recovers unresolved attempts", async () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  const deliveries = new DeliveryStore(db);
  const finals = new FinalMessageStore(db);
  const runtime = new AssistantRuntime(db, operations, deliveries, { destination: "42" });
  for (const id of ["completed", "no-effect", "effect"]) {
    operations.createSourceContext({ id, kind: "telegram", sourceId: id, rawText: id, attachmentIds: [] });
  }
  runtime.prepareAttempt("completed", "attempt-completed", "user");
  runtime.beginUserAttempt("no-effect", "attempt-no-effect", "turn-no-effect");
  runtime.beginUserAttempt("effect", "attempt-effect", "turn-effect");
  const effect = operations.prepare({ contextId: "effect", attemptId: "attempt-effect", callId: "call", kind: "send_to_session", args: { nickname: "work" } });
  operations.markDispatched(effect.id);
  const assistantDir = await mkdtemp(join(tmpdir(), "assistant-legacy-migration-"));
  let reconciliations = 0;
  const completedTurn = {
    id: "turn-completed",
    status: "completed",
    completedAt: 10,
    items: [
      { type: "userMessage", id: "user", clientId: "completed" },
      { type: "agentMessage", id: "answer", phase: "final_answer", text: "already finished" },
    ],
  };
  await recoverAssistantProfileAttempts({
    runtime,
    legacyThreadId: "old-assistant",
    assistantDir,
    readLegacyThread: async () => ({ id: "old-assistant", cwd: assistantDir, turns: [completedTurn] }),
    reconcileOperations: async () => { reconciliations += 1; },
    completeTurn: async (turn) => {
      const messages = finals.persistTerminalTurn("assistant-local", "old-assistant", turn as never, 10);
      runtime.handleTerminal(turn.id, messages.map((message) => message.body).join("\n") || undefined);
    },
  });
  assert.equal(reconciliations, 1);
  assert.deepEqual(runtime.activeAttempts(), []);
  assert.equal(operations.getSourceContext("completed")?.state, "completed");
  assert.deepEqual(deliveries.listReady().map((row) => row.body), ["[assistant] already finished"]);
  assert.equal(operations.getSourceContext("no-effect")?.state, "pending");
  assert.equal(operations.getSourceContext("effect")?.state, "superseded");
  const recoveryRows = db.prepare("SELECT id FROM source_contexts WHERE kind = 'recovery' AND superseded_by IS NULL").all();
  assert.equal(recoveryRows.length, 1);
});

test("legacy migration verifies thread identity and cwd before changing attempts", async () => {
  for (const mismatch of ["id", "cwd"] as const) {
    const db = createTestDatabase();
    const operations = new OperationStore(db);
    operations.createSourceContext({ id: mismatch, kind: "telegram", sourceId: mismatch, rawText: mismatch, attachmentIds: [] });
    const runtime = new AssistantRuntime(db, operations, new DeliveryStore(db), { destination: "42" });
    runtime.beginUserAttempt(mismatch, `attempt-${mismatch}`, `turn-${mismatch}`);
    const assistantDir = await mkdtemp(join(tmpdir(), "assistant-legacy-expected-"));
    const otherDir = await mkdtemp(join(tmpdir(), "assistant-legacy-other-"));
    await assert.rejects(recoverAssistantProfileAttempts({
      runtime,
      legacyThreadId: "old-assistant",
      assistantDir,
      readLegacyThread: async () => ({ id: mismatch === "id" ? "wrong" : "old-assistant", cwd: mismatch === "cwd" ? otherDir : assistantDir, turns: [] }),
      reconcileOperations: async () => {},
      completeTurn: async () => {},
    }), mismatch === "id" ? /thread identity/ : /working directory/);
    assert.equal(runtime.activeAttempts().length, 1);
    assert.equal(operations.getSourceContext(mismatch)?.state, "active");
  }
});

test("legacy migration binds a provisional attempt to the newest matching client id", async () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "repeated", kind: "telegram", sourceId: "repeated", rawText: "repeated", attachmentIds: [] });
  const runtime = new AssistantRuntime(db, operations, new DeliveryStore(db), { destination: "42" });
  runtime.prepareAttempt("repeated", "attempt-repeated", "user");
  const assistantDir = await mkdtemp(join(tmpdir(), "assistant-legacy-repeated-"));
  const completed: string[] = [];
  await recoverAssistantProfileAttempts({
    runtime,
    legacyThreadId: "old-assistant",
    assistantDir,
    readLegacyThread: async () => ({
      id: "old-assistant",
      cwd: assistantDir,
      turns: [
        { id: "old-failed", status: "failed", items: [{ type: "userMessage", clientId: "repeated" }] },
        { id: "new-completed", status: "completed", items: [{ type: "userMessage", clientId: "repeated" }] },
      ],
    }),
    reconcileOperations: async () => {},
    completeTurn: async (turn) => { completed.push(turn.id); runtime.handleTerminal(turn.id, "done"); },
  });
  assert.deepEqual(completed, ["new-completed"]);
  assert.equal(operations.getSourceContext("repeated")?.state, "completed");
});
