import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../src/core/errors.ts";
import { ChatAdapterRegistry } from "../../src/chat/adapter-registry.ts";
import { DeliveryWorker } from "../../src/chat/delivery-worker.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { WeixinAccountStore, type WeixinAuthorizationIncidentSink } from "../../src/weixin/account-store.ts";
import { WeixinApiError, type WeixinSendMessageRequest } from "../../src/weixin/api-client.ts";
import { WeixinDeliveryAdapter } from "../../src/weixin/delivery-adapter.ts";
import { WeixinOutboundStore } from "../../src/weixin/outbound-store.ts";

function setup(input: { body?: string; mandatory?: boolean; send?: (request: WeixinSendMessageRequest) => Promise<{ messageId?: string }> } = {}) {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const accounts = new WeixinAccountStore(db, deliveries);
  accounts.activate({
    accountGenerationId: "generation", credentialRevisionId: "revision", botId: "bot", ownerUserId: "owner",
    apiBaseUrl: "https://ilinkai.weixin.qq.com",
  });
  db.prepare(`INSERT INTO weixin_route_tokens(id, generation_id, token, is_current, created_at)
    VALUES ('route', 'generation', 'secret-context', 1, 1)`).run();
  const binding = {
    adapterId: "weixin",
    conversationKey: "weixin:generation:owner",
    destination: { generationId: "generation", botId: "bot", ownerUserId: "owner", routeTokenId: "route" },
  } as const;
  const delivery = deliveries.prepare({
    id: "delivery", kind: "text", binding, body: input.body ?? "hello", mandatory: input.mandatory ?? true,
  });
  const requests: WeixinSendMessageRequest[] = [];
  const incidents: Array<{ generationId: string; state: string; category: string }> = [];
  const incidentSink: WeixinAuthorizationIncidentSink = {
    async transition(event) { incidents.push(event); },
  };
  const api = {
    async sendMessage(request: WeixinSendMessageRequest) {
      requests.push(request);
      return input.send ? input.send(request) : { messageId: `message-${requests.length}` };
    },
  };
  const outbound = new WeixinOutboundStore(db);
  const adapter = new WeixinDeliveryAdapter({ api, outbound, deliveries, accounts, incidentSink });
  const worker = new DeliveryWorker(deliveries, new ChatAdapterRegistry([{ delivery: adapter }]));
  return { db, deliveries, delivery, requests, incidents, outbound, adapter, worker, accounts };
}

test("sends an immutable text plan with canonical bodies and confirms every chunk", async () => {
  const fixture = setup({ body: "🙂".repeat(1_001) });
  await fixture.worker.processOne(fixture.delivery.id);

  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(fixture.requests[0], { msg: {
    from_user_id: "",
    to_user_id: "owner",
    client_id: fixture.outbound.list(fixture.delivery.id)[0]!.clientId,
    message_type: 2,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text: "🙂".repeat(1_000) } }],
    context_token: "secret-context",
  } });
  assert.equal(fixture.outbound.list(fixture.delivery.id).every((step) => step.state === "succeeded"), true);
  assert.deepEqual(fixture.deliveries.get(fixture.delivery.id)?.receipt, { kind: "weixin", stepCount: 2 });
  fixture.db.close();
});

test("resumes after a fully checkpointed prefix without repeating it", async () => {
  const fixture = setup({ body: "x".repeat(4_001) });
  const steps = fixture.outbound.prepareText(fixture.delivery, fixture.delivery.binding.destination as never);
  fixture.outbound.begin(steps[0]!.id);
  fixture.outbound.succeed(steps[0]!.id, { messageId: "already-sent" });

  await fixture.worker.processOne(fixture.delivery.id);

  assert.equal(fixture.requests.length, 1);
  assert.equal((fixture.requests[0]?.msg.item_list as Array<{ text_item: { text: string } }>)[0]?.text_item.text, "x");
  fixture.db.close();
});

test("never redispatches an unresolved WeChat effect for mandatory or optional delivery", async () => {
  for (const mandatory of [true, false]) {
    let calls = 0;
    const fixture = setup({ mandatory, send: async () => {
      calls += 1;
      throw new WeixinApiError("service", "ambiguous", { uncertain: true });
    } });
    await assert.rejects(fixture.worker.processOne(fixture.delivery.id));
    assert.equal(fixture.deliveries.get(fixture.delivery.id)?.state, "uncertain");
    await assert.rejects(fixture.worker.processOne(fixture.delivery.id), /may already have been sent/u);
    assert.equal(calls, 1);
    assert.equal(fixture.outbound.list(fixture.delivery.id)[0]?.state, "uncertain");
    assert.equal(fixture.deliveries.get(`delivery-warning:${fixture.delivery.id}`), undefined);
    fixture.db.close();
  }
});

test("routes authorization and credential-pin failures once and makes them terminal", async () => {
  for (const failure of [
    {
      error: new WeixinApiError("authorization", "stale", { protocolCode: -14 }),
      state: "relogin_required",
      category: "authorization",
    },
    {
      error: new AppError("CONFIGURATION_ERROR", "WeChat credential file changed unexpectedly"),
      state: "credential_changed",
      category: "credential_changed",
    },
  ] as const) {
    const fixture = setup({ send: async () => { throw failure.error; } });
    await assert.rejects(fixture.worker.processOne(fixture.delivery.id));
    assert.equal(fixture.deliveries.get(fixture.delivery.id)?.state, "failed");
    assert.deepEqual(fixture.incidents, [{ generationId: "generation", state: failure.state, category: failure.category }]);
    fixture.db.close();
  }
});

test("treats a syntactically valid nonzero rejection as terminal without an incident", async () => {
  const fixture = setup({ send: async () => {
    throw new WeixinApiError("invalid_request", "rejected", { protocolCode: 7 });
  } });
  await assert.rejects(fixture.worker.processOne(fixture.delivery.id));
  assert.equal(fixture.deliveries.get(fixture.delivery.id)?.state, "failed");
  assert.deepEqual(fixture.incidents, []);
  fixture.db.close();
});

test("atomically fails a known terminal rejection before control returns to the delivery worker", async () => {
  const fixture = setup({ send: async () => {
    throw new WeixinApiError("invalid_request", "rejected", { protocolCode: 7 });
  } });
  fixture.deliveries.markDispatched(fixture.delivery.id);

  await assert.rejects(fixture.adapter.sendMessage(
    fixture.delivery.binding.destination,
    fixture.delivery.body,
    undefined,
    { deliveryId: fixture.delivery.id },
  ));

  assert.equal(fixture.deliveries.get(fixture.delivery.id)?.state, "failed");
  fixture.deliveries.recoverAfterCrash();
  assert.equal(fixture.deliveries.get(fixture.delivery.id)?.state, "failed");
  fixture.db.close();
});

test("an inactive authorization latch fails before dispatch without becoming uncertain", async () => {
  const fixture = setup();
  fixture.accounts.latchInactive("generation", "relogin_required", "incident");

  await assert.rejects(fixture.worker.processOne(fixture.delivery.id));

  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.deliveries.get(fixture.delivery.id)?.state, "failed");
  fixture.db.close();
});
