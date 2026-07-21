import assert from "node:assert/strict";
import test from "node:test";
import { boundLargeToolResult } from "../../src/assistant/large-tool-result.ts";

test("small tool results stay inline", async () => {
  const value = { messages: [{ text: "small result" }] };
  const result = await boundLargeToolResult(value, {
    writeResultFile: async () => { throw new Error("small result must stay inline"); },
  });
  assert.equal(result, value);
});

test("large tool results spill to an owner-only JSON path with an actionable warning", async () => {
  const value = { messages: [{ text: Array.from({ length: 1_001 }, (_, index) => `word${index}`).join(" ") }] };
  let stored: unknown;
  const result = await boundLargeToolResult(value, {
    writeResultFile: async (candidate) => { stored = candidate; return "/private/tool-result.json"; },
  });

  assert.equal(stored, value);
  assert.equal((result as any).storage, "file");
  assert.equal((result as any).path, "/private/tool-result.json");
  assert.equal((result as any).format, "json");
  assert.equal((result as any).wordCount, 1_001);
  assert.match((result as any).warning, /large result.*saved.*read.*file/i);
  assert.doesNotMatch(JSON.stringify(result), /word1000/u);
});

test("large unbroken JSON spills by byte size", async () => {
  const result = await boundLargeToolResult({ body: "x".repeat(20_000) }, {
    writeResultFile: async () => "/private/tool-result.json",
  });
  assert.equal((result as any).storage, "file");
  assert.ok((result as any).inlineByteCount > 16_384);
});
