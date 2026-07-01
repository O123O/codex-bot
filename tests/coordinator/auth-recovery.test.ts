import assert from "node:assert/strict";
import test from "node:test";
import { recordCoordinatorAuthenticationFailure } from "../../src/coordinator/auth-recovery.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";

test("coordinator authentication warnings deduplicate within an incident", () => {
  const deliveries = new DeliveryStore(createTestDatabase());
  recordCoordinatorAuthenticationFailure(deliveries, "42", 3);
  recordCoordinatorAuthenticationFailure(deliveries, "42", 3);
  recordCoordinatorAuthenticationFailure(deliveries, "42", 4);
  const ready = deliveries.listReady();
  assert.deepEqual(ready.map((row) => row.id), ["coordinator-auth-required:3", "coordinator-auth-required:4"]);
  assert.ok(ready.every((row) => row.kind === "system_warning" && row.mandatory));
  assert.ok(ready.every((row) => row.body.includes("codex-bot coordinator-login")));
});
