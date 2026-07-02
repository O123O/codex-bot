import assert from "node:assert/strict";
import test from "node:test";
import { recordAssistantAuthenticationFailure } from "../../src/assistant/auth-recovery.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";

test("assistant authentication warnings deduplicate within an incident", () => {
  const deliveries = new DeliveryStore(createTestDatabase());
  recordAssistantAuthenticationFailure(deliveries, "42", 3);
  recordAssistantAuthenticationFailure(deliveries, "42", 3);
  recordAssistantAuthenticationFailure(deliveries, "42", 4);
  const ready = deliveries.listReady();
  assert.deepEqual(ready.map((row) => row.id), ["assistant-auth-required:3", "assistant-auth-required:4"]);
  assert.ok(ready.every((row) => row.kind === "system_warning" && row.mandatory));
  assert.ok(ready.every((row) => row.body.includes("qiyan-bot assistant-login")));
});
