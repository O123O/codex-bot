import assert from "node:assert/strict";
import test from "node:test";
import { readWorkerMessages } from "../../src/assistant/worker-message-history.ts";

const mapping = { endpoint: "remote", thread_id: "thread", mapping_id: "mapping" };

test("worker message reads delegate one bounded page and project native rows", async () => {
  const signal = new AbortController().signal;
  const calls: unknown[][] = [];
  const result = await readWorkerMessages({
    resolveSession: (nickname) => nickname === "worker" ? mapping : undefined,
    writeResultFile: async () => { throw new Error("small result must stay inline"); },
    readTurns: async (...args) => {
      calls.push(args);
      return {
        messages: [
          { id: "u1", turnId: "turn", role: "you", body: "question", completedAt: 1, terminalStatus: "completed", turnOrder: 1, itemOrder: 1, clientId: "client" },
          { id: "a1", turnId: "turn", body: "answer", completedAt: 2, terminalStatus: "completed", turnOrder: 1, itemOrder: 2, phase: "final_answer" },
        ],
        hasOlder: true, nextCursor: "next", openTurnIds: [], terminalTurnIds: ["turn"],
      };
    },
  }, { nickname: "worker", count: 7, before: "before" }, signal);

  assert.deepEqual(calls, [["remote", "thread", "mapping", 7, "before", signal]]);
  assert.deepEqual(result, {
    messages: [
      { id: "u1", turnId: "turn", role: "user", body: "question", completedAt: 1, status: "completed", clientId: "client" },
      { id: "a1", turnId: "turn", role: "worker", body: "answer", completedAt: 2, status: "completed", phase: "final_answer" },
    ],
    hasOlder: true, nextCursor: "next", openTurnIds: [], terminalTurnIds: ["turn"],
  });
});

test("worker message reads reject unknown and remapped nicknames", async () => {
  let current = mapping;
  let resolveRead!: (value: any) => void;
  const pending = new Promise<any>((resolve) => { resolveRead = resolve; });
  const deps = {
    resolveSession: (nickname: string) => nickname === "worker" ? current : undefined,
    writeResultFile: async () => { throw new Error("must not write"); },
    readTurns: async () => pending,
  };

  await assert.rejects(readWorkerMessages(deps, { nickname: "missing", count: 1 }, new AbortController().signal), (error: any) => error?.code === "UNKNOWN_SESSION");
  const read = readWorkerMessages(deps, { nickname: "worker", count: 1 }, new AbortController().signal);
  current = { ...mapping, mapping_id: "replacement" };
  resolveRead({ messages: [], hasOlder: false, openTurnIds: [], terminalTurnIds: [] });
  await assert.rejects(read, (error: any) => error?.code === "OPERATION_CONFLICT");
});

test("large worker conversations spill without returning message bodies", async () => {
  const longBody = Array.from({ length: 1_001 }, (_, index) => `word${index}`).join(" ");
  let stored: unknown;
  const result = await readWorkerMessages({
    resolveSession: () => mapping,
    readTurns: async () => ({
      messages: [{ id: "a1", turnId: "turn", body: longBody, completedAt: 2, terminalStatus: "inProgress", turnOrder: 1, itemOrder: 1 }],
      hasOlder: true, nextCursor: "next", openTurnIds: ["turn"], terminalTurnIds: [],
    }),
    writeResultFile: async (value) => { stored = value; return "/private/worker-conversation.json"; },
  }, { nickname: "worker", count: 20 }, new AbortController().signal);

  assert.equal((stored as any).messages[0].body, longBody);
  assert.deepEqual(result, {
    storage: "file",
    path: "/private/worker-conversation.json",
    format: "json",
    messageCount: 1,
    wordCount: 1_001,
    inlineByteCount: Buffer.byteLength(JSON.stringify(stored), "utf8"),
    hasOlder: true,
    nextCursor: "next",
    openTurnIds: ["turn"],
    terminalTurnIds: [],
  });
  assert.doesNotMatch(JSON.stringify(result), /word1000/u);
});

test("a large unbroken body spills even below the word threshold", async () => {
  let writes = 0;
  const result = await readWorkerMessages({
    resolveSession: () => mapping,
    readTurns: async () => ({
      messages: [{ id: "a1", turnId: "turn", body: "x".repeat(20_000), completedAt: 2, terminalStatus: "completed", turnOrder: 1, itemOrder: 1 }],
      hasOlder: false, openTurnIds: [], terminalTurnIds: ["turn"],
    }),
    writeResultFile: async () => { writes += 1; return "/private/large-code.json"; },
  }, { nickname: "worker", count: 20 }, new AbortController().signal);

  assert.equal(writes, 1);
  assert.equal((result as any).storage, "file");
  assert.equal((result as any).wordCount, 1);
  assert.ok((result as any).inlineByteCount > 16_384);
});
