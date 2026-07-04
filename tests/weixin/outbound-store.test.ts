import assert from "node:assert/strict";
import test from "node:test";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { WeixinAccountStore } from "../../src/weixin/account-store.ts";
import {
  splitWeixinText,
  WeixinOutboundStore,
  type WeixinFrozenDestination,
} from "../../src/weixin/outbound-store.ts";

const target: WeixinFrozenDestination = {
  generationId: "generation",
  botId: "bot",
  ownerUserId: "owner",
  routeTokenId: "route",
};

function setup(body = "hello") {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  new WeixinAccountStore(db, deliveries).activate({
    accountGenerationId: "generation",
    credentialRevisionId: "revision",
    botId: "bot",
    ownerUserId: "owner",
    apiBaseUrl: "https://ilinkai.weixin.qq.com",
  });
  db.prepare(`INSERT INTO weixin_route_tokens(id, generation_id, token, is_current, created_at)
    VALUES ('route', 'generation', 'secret-context', 1, 1)`).run();
  const delivery = deliveries.prepare({
    id: "delivery",
    kind: "text",
    binding: {
      adapterId: "weixin",
      conversationKey: "weixin:generation:owner",
      destination: { ...target },
    },
    body,
    mandatory: true,
  });
  return { db, deliveries, delivery, outbound: new WeixinOutboundStore(db) };
}

test("splits WeChat text at Unicode-safe UTF-8 byte boundaries", () => {
  const text = `start-${"🙂".repeat(2_001)}-end`;
  const chunks = splitWeixinText(text, 4_000);
  assert.equal(chunks.length > 1, true);
  assert.equal(chunks.every((chunk) => Buffer.byteLength(chunk) <= 4_000), true);
  assert.equal(chunks.join(""), text);
  assert.deepEqual(splitWeixinText("", 4_000), [""]);
  assert.throws(() => splitWeixinText("x", 0), /byte limit/u);
});

test("persists an immutable non-secret text plan with deterministic client identities", () => {
  const { db, delivery, outbound } = setup("🙂".repeat(1_001));
  const first = outbound.prepareText(delivery, target);
  const again = outbound.prepareText(delivery, target);

  assert.deepEqual(again, first);
  assert.equal(first.length, 2);
  assert.equal(first.every((step) => /^[a-f0-9]{32}$/u.test(step.clientId)), true);
  assert.notEqual(first[0]?.clientId, first[1]?.clientId);
  assert.equal(first.every((step) => step.generationId === "generation" && step.routeTokenId === "route"), true);
  const persisted = db.prepare(`SELECT request_json, plan_json FROM weixin_outbound_steps
    WHERE delivery_id = ? ORDER BY ordinal`).all(delivery.id) as Array<{ request_json: string; plan_json: string }>;
  assert.equal(JSON.stringify(persisted).includes("secret-context"), false);
  assert.throws(() => outbound.prepareText({ ...delivery, body: "changed" }, target), /immutable|inconsistent/u);
  assert.throws(() => outbound.prepareText(delivery, { ...target, ownerUserId: "changed" }), /immutable|inconsistent/u);
  db.close();
});

test("checkpoints text effects and reconciles only proven prefixes", () => {
  const { db, delivery, outbound } = setup("x".repeat(4_001));
  const steps = outbound.prepareText(delivery, target);
  assert.deepEqual(outbound.reconcile(delivery.id), { outcome: "resume_safe" });

  outbound.begin(steps[0]!.id);
  assert.deepEqual(outbound.reconcile(delivery.id), { outcome: "unresolved" });
  assert.equal(outbound.markDispatchingUncertain(), 1);
  assert.equal(outbound.get(steps[0]!.id)?.state, "uncertain");
  assert.deepEqual(outbound.reconcile(delivery.id), { outcome: "unresolved" });

  const second = setup("x".repeat(4_001));
  const resumable = second.outbound.prepareText(second.delivery, target);
  second.outbound.begin(resumable[0]!.id);
  second.outbound.succeed(resumable[0]!.id, { messageId: "one" });
  assert.deepEqual(second.outbound.reconcile(second.delivery.id), { outcome: "resume_safe" });
  second.outbound.begin(resumable[1]!.id);
  second.outbound.succeed(resumable[1]!.id, { messageId: "two" });
  assert.deepEqual(second.outbound.reconcile(second.delivery.id), {
    outcome: "confirmed",
    receipt: { kind: "weixin", stepCount: 2 },
  });
  assert.throws(() => second.outbound.begin(resumable[0]!.id), /state/u);
  second.db.close();
  db.close();
});

test("selects and freezes the current route token when the destination omits one", () => {
  const { db, deliveries, outbound } = setup();
  const destination = { generationId: "generation", botId: "bot", ownerUserId: "owner" } as const;
  const delivery = deliveries.prepare({
    id: "current-route-delivery",
    kind: "text",
    binding: { adapterId: "weixin", conversationKey: "weixin:generation:owner", destination },
    body: "hello",
    mandatory: true,
  });
  const plan = outbound.prepareText(delivery, destination);
  assert.equal(plan[0]?.routeTokenId, "route");
  assert.equal(outbound.resolveRouteToken(plan[0]!), "secret-context");
  db.prepare("UPDATE weixin_route_tokens SET is_current = 0 WHERE id = 'route'").run();
  db.prepare(`INSERT INTO weixin_route_tokens(id, generation_id, token, is_current, created_at)
    VALUES ('new-route', 'generation', 'new-secret', 1, 2)`).run();
  assert.deepEqual(outbound.prepareText(delivery, destination), plan);
  db.close();
});
