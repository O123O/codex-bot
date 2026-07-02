import assert from "node:assert/strict";
import test from "node:test";
import type { ChatDeliveryAdapter } from "../../src/chat/contracts.ts";
import { ChatAdapterRegistry } from "../../src/chat/adapter-registry.ts";

function adapter(id: string): ChatDeliveryAdapter {
  return {
    id,
    sendMessage: async () => ({ id: `${id}-receipt` }),
  };
}

test("adapter registry selects exact IDs and rejects duplicates or unknown IDs", () => {
  const telegram = adapter("telegram");
  const slack = adapter("slack");
  const registry = new ChatAdapterRegistry([telegram, slack]);
  assert.equal(registry.delivery("slack"), slack);
  assert.throws(() => registry.delivery("wechat"), /unknown chat adapter/i);
  assert.throws(() => new ChatAdapterRegistry([telegram, adapter("telegram")]), /duplicate chat adapter/i);
});
