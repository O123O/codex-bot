import { createHash } from "node:crypto";
import type { ConversationBinding, JsonValue } from "../chat/binding.ts";
import type { UncertainDeliveryResolution } from "../chat/contracts.ts";
import type { DeliveryRecord } from "../storage/delivery-store.ts";
import type { DeliveryStore } from "../storage/delivery-store.ts";
import type { Database } from "../storage/database.ts";
import { inTransaction } from "../storage/database.ts";
import type { WeixinSendMessageRequest } from "./api-client.ts";

const DEFAULT_TEXT_BYTES = 4_000;
const MAX_RECEIPT_BYTES = 16 * 1024;

export type WeixinOutboundStepState = "prepared" | "dispatching" | "succeeded" | "uncertain";

export interface WeixinFrozenDestination {
  generationId: string;
  botId: string;
  ownerUserId: string;
  routeTokenId?: string;
}

export interface WeixinOutboundStep {
  id: string;
  deliveryId: string;
  generationId: string;
  ordinal: number;
  kind: "text";
  state: WeixinOutboundStepState;
  requestHash: string;
  clientId: string;
  botId: string;
  ownerUserId: string;
  text: string;
  routeTokenId?: string;
  receipt?: JsonValue;
}

interface StepRow {
  id: string;
  delivery_id: string;
  generation_id: string;
  ordinal: number;
  kind: string;
  state: WeixinOutboundStepState;
  request_hash: string;
  request_json: string;
  receipt_json: string | null;
  route_token_id: string | null;
  client_id: string | null;
  plan_json: string | null;
}

interface TextRequestPlan {
  text: string;
}

interface TextPlan {
  version: 1;
  botId: string;
  ownerUserId: string;
}

export class WeixinOutboundStore {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {}

  prepareText(delivery: DeliveryRecord, target: WeixinFrozenDestination): readonly WeixinOutboundStep[] {
    return inTransaction(this.db, () => {
      this.validateDelivery(delivery, target);
      const existing = this.list(delivery.id);
      const routeTokenId = existing.length > 0 ? existing[0]!.routeTokenId : this.selectRouteToken(target);
      const chunks = splitWeixinText(delivery.body);
      const expected = chunks.map((text, ordinal) => this.textBlueprint(delivery.id, target, routeTokenId, text, ordinal));
      if (existing.length > 0) {
        this.assertSamePlan(existing, expected);
        return existing;
      }
      const now = this.now();
      for (const step of expected) {
        this.db.prepare(`INSERT INTO weixin_outbound_steps
          (id, delivery_id, generation_id, ordinal, kind, state, request_hash, request_json, route_token_id,
            client_id, plan_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'text', 'prepared', ?, ?, ?, ?, ?, ?, ?)`).run(
          step.id,
          step.deliveryId,
          step.generationId,
          step.ordinal,
          step.requestHash,
          JSON.stringify({ text: step.text } satisfies TextRequestPlan),
          step.routeTokenId ?? null,
          step.clientId,
          JSON.stringify({ version: 1, botId: step.botId, ownerUserId: step.ownerUserId } satisfies TextPlan),
          now,
          now,
        );
      }
      return this.list(delivery.id);
    });
  }

  get(stepId: string): WeixinOutboundStep | undefined {
    const row = this.db.prepare("SELECT * FROM weixin_outbound_steps WHERE id = ?").get(stepId) as unknown as StepRow | undefined;
    return row ? this.toTextStep(row) : undefined;
  }

  list(deliveryId: string): readonly WeixinOutboundStep[] {
    const rows = this.db.prepare(`SELECT * FROM weixin_outbound_steps WHERE delivery_id = ? ORDER BY ordinal`)
      .all(deliveryId) as unknown as StepRow[];
    return rows.map((row) => this.toTextStep(row));
  }

  begin(stepId: string): void {
    const changed = this.db.prepare(`UPDATE weixin_outbound_steps SET state = 'dispatching', updated_at = ?
      WHERE id = ? AND state = 'prepared'`).run(this.now(), stepId).changes;
    if (changed !== 1) throw new Error("WeChat outbound step state is not prepared");
  }

  succeed(stepId: string, receipt: JsonValue): void {
    const encoded = JSON.stringify(receipt);
    if (Buffer.byteLength(encoded) > MAX_RECEIPT_BYTES) throw new Error("WeChat outbound receipt exceeds limit");
    const changed = this.db.prepare(`UPDATE weixin_outbound_steps
      SET state = 'succeeded', receipt_json = ?, updated_at = ? WHERE id = ? AND state = 'dispatching'`)
      .run(encoded, this.now(), stepId).changes;
    if (changed !== 1) throw new Error("WeChat outbound step state is not dispatching");
  }

  resetPrepared(stepId: string): void {
    const changed = this.db.prepare(`UPDATE weixin_outbound_steps SET state = 'prepared', updated_at = ?
      WHERE id = ? AND state = 'dispatching'`).run(this.now(), stepId).changes;
    if (changed !== 1) throw new Error("WeChat outbound step state is not dispatching");
  }

  markUncertain(stepId: string): void {
    const changed = this.db.prepare(`UPDATE weixin_outbound_steps SET state = 'uncertain', updated_at = ?
      WHERE id = ? AND state = 'dispatching'`).run(this.now(), stepId).changes;
    if (changed !== 1) throw new Error("WeChat outbound step state is not dispatching");
  }

  failTerminal(stepId: string, deliveries: DeliveryStore): void {
    inTransaction(this.db, () => {
      const row = this.db.prepare(`SELECT delivery_id, state FROM weixin_outbound_steps WHERE id = ?`)
        .get(stepId) as { delivery_id: string; state: WeixinOutboundStepState } | undefined;
      if (!row || row.state !== "dispatching") throw new Error("WeChat outbound step state is not dispatching");
      if (!deliveries.failInTransaction(row.delivery_id)) throw new Error("WeChat delivery cannot fail terminally");
      const changed = this.db.prepare(`UPDATE weixin_outbound_steps SET state = 'prepared', updated_at = ?
        WHERE id = ? AND state = 'dispatching'`).run(this.now(), stepId).changes;
      if (changed !== 1) throw new Error("WeChat outbound step state changed unexpectedly");
    });
  }

  markDispatchingUncertain(): number {
    return Number(this.db.prepare(`UPDATE weixin_outbound_steps SET state = 'uncertain', updated_at = ?
      WHERE state = 'dispatching'`).run(this.now()).changes);
  }

  reconcile(deliveryId: string): UncertainDeliveryResolution {
    const steps = this.list(deliveryId);
    if (steps.some((step) => step.state === "dispatching" || step.state === "uncertain")) return { outcome: "unresolved" };
    let sawPrepared = false;
    for (const step of steps) {
      if (step.state === "prepared") sawPrepared = true;
      else if (step.state === "succeeded" && sawPrepared) return { outcome: "unresolved" };
    }
    if (steps.length > 0 && steps.every((step) => step.state === "succeeded")) {
      return { outcome: "confirmed", receipt: { kind: "weixin", stepCount: steps.length } };
    }
    return { outcome: "resume_safe" };
  }

  resolveRouteToken(step: Pick<WeixinOutboundStep, "generationId" | "routeTokenId">): string | undefined {
    if (step.routeTokenId === undefined) return undefined;
    const row = this.db.prepare(`SELECT token FROM weixin_route_tokens WHERE generation_id = ? AND id = ?`)
      .get(step.generationId, step.routeTokenId) as { token: string } | undefined;
    if (!row) throw new Error("WeChat outbound route token is unavailable");
    return row.token;
  }

  messageRequest(step: WeixinOutboundStep): WeixinSendMessageRequest {
    const contextToken = this.resolveRouteToken(step);
    return { msg: {
      from_user_id: "",
      to_user_id: step.ownerUserId,
      client_id: step.clientId,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: step.text } }],
      ...(contextToken === undefined ? {} : { context_token: contextToken }),
    } };
  }

  private validateDelivery(delivery: DeliveryRecord, target: WeixinFrozenDestination): void {
    if (delivery.binding.adapterId !== "weixin") throw new Error("WeChat outbound delivery adapter is inconsistent");
    validateDestination(target);
    const account = this.db.prepare(`SELECT bot_id, owner_user_id FROM weixin_account_generations
      WHERE generation_id = ? AND active = 1 AND authorization_state = 'active'`).get(target.generationId) as
      { bot_id: string; owner_user_id: string } | undefined;
    if (!account || account.bot_id !== target.botId || account.owner_user_id !== target.ownerUserId) {
      throw new Error("WeChat outbound destination is inactive or inconsistent");
    }
    const bindingTarget = parseWeixinDestination(delivery.binding);
    if (bindingTarget.generationId !== target.generationId || bindingTarget.botId !== target.botId
      || bindingTarget.ownerUserId !== target.ownerUserId || bindingTarget.routeTokenId !== target.routeTokenId) {
      throw new Error("WeChat outbound destination is inconsistent");
    }
  }

  private selectRouteToken(target: WeixinFrozenDestination): string | undefined {
    const row = target.routeTokenId === undefined
      ? this.db.prepare(`SELECT id FROM weixin_route_tokens WHERE generation_id = ? AND is_current = 1`).get(target.generationId)
      : this.db.prepare(`SELECT id FROM weixin_route_tokens WHERE generation_id = ? AND id = ?`)
        .get(target.generationId, target.routeTokenId);
    if (target.routeTokenId !== undefined && !row) throw new Error("WeChat outbound route token is unavailable");
    return (row as { id: string } | undefined)?.id;
  }

  private textBlueprint(
    deliveryId: string,
    target: WeixinFrozenDestination,
    routeTokenId: string | undefined,
    text: string,
    ordinal: number,
  ): WeixinOutboundStep {
    const clientId = digest32(["weixin-text-client", deliveryId, ordinal]);
    const id = `weixin-step-${digest32(["weixin-text-step", deliveryId, ordinal])}`;
    const requestHash = createHash("sha256").update(JSON.stringify({
      version: 1,
      generationId: target.generationId,
      botId: target.botId,
      ownerUserId: target.ownerUserId,
      routeTokenId: routeTokenId ?? null,
      clientId,
      text,
    })).digest("hex");
    return {
      id,
      deliveryId,
      generationId: target.generationId,
      ordinal,
      kind: "text",
      state: "prepared",
      requestHash,
      clientId,
      botId: target.botId,
      ownerUserId: target.ownerUserId,
      text,
      ...(routeTokenId === undefined ? {} : { routeTokenId }),
    };
  }

  private assertSamePlan(existing: readonly WeixinOutboundStep[], expected: readonly WeixinOutboundStep[]): void {
    if (existing.length !== expected.length) throw new Error("WeChat outbound plan is immutable and inconsistent");
    for (let index = 0; index < existing.length; index += 1) {
      const left = existing[index]!;
      const right = expected[index]!;
      if (left.id !== right.id || left.deliveryId !== right.deliveryId || left.generationId !== right.generationId
        || left.ordinal !== right.ordinal || left.kind !== right.kind || left.requestHash !== right.requestHash
        || left.clientId !== right.clientId || left.botId !== right.botId || left.ownerUserId !== right.ownerUserId
        || left.text !== right.text || left.routeTokenId !== right.routeTokenId) {
        throw new Error("WeChat outbound plan is immutable and inconsistent");
      }
    }
  }

  private toTextStep(row: StepRow): WeixinOutboundStep {
    if (row.kind !== "text" || !row.client_id || !row.plan_json) throw new Error("WeChat outbound plan is invalid");
    const request = parseObject(row.request_json) as Partial<TextRequestPlan>;
    const plan = parseObject(row.plan_json) as Partial<TextPlan>;
    if (typeof request.text !== "string" || plan.version !== 1 || typeof plan.botId !== "string"
      || typeof plan.ownerUserId !== "string" || !/^[a-f0-9]{32}$/u.test(row.client_id)) {
      throw new Error("WeChat outbound plan is invalid");
    }
    const receipt = row.receipt_json === null ? undefined : JSON.parse(row.receipt_json) as JsonValue;
    return {
      id: row.id,
      deliveryId: row.delivery_id,
      generationId: row.generation_id,
      ordinal: row.ordinal,
      kind: "text",
      state: row.state,
      requestHash: row.request_hash,
      clientId: row.client_id,
      botId: plan.botId,
      ownerUserId: plan.ownerUserId,
      text: request.text,
      ...(row.route_token_id === null ? {} : { routeTokenId: row.route_token_id }),
      ...(receipt === undefined ? {} : { receipt }),
    };
  }
}

export function splitWeixinText(value: string, maxUtf8Bytes = DEFAULT_TEXT_BYTES): readonly string[] {
  if (!Number.isSafeInteger(maxUtf8Bytes) || maxUtf8Bytes <= 0) throw new TypeError("WeChat text byte limit is invalid");
  if (value.length === 0) return [""];
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const codePoint of value) {
    const bytes = Buffer.byteLength(codePoint);
    if (bytes > maxUtf8Bytes) throw new TypeError("WeChat text code point exceeds byte limit");
    if (currentBytes + bytes > maxUtf8Bytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += codePoint;
    currentBytes += bytes;
  }
  chunks.push(current);
  return chunks;
}

export function parseWeixinDestination(binding: ConversationBinding): WeixinFrozenDestination {
  const value = binding.destination;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("WeChat destination is invalid");
  const generationId = value.generationId;
  const botId = value.botId;
  const ownerUserId = value.ownerUserId;
  const routeTokenId = value.routeTokenId;
  const keys = Object.keys(value);
  if (keys.some((key) => !["generationId", "botId", "ownerUserId", "routeTokenId"].includes(key))
    || typeof generationId !== "string" || typeof botId !== "string" || typeof ownerUserId !== "string"
    || (routeTokenId !== undefined && typeof routeTokenId !== "string")) {
    throw new TypeError("WeChat destination is invalid");
  }
  const target = {
    generationId,
    botId,
    ownerUserId,
    ...(routeTokenId === undefined ? {} : { routeTokenId }),
  };
  validateDestination(target);
  return target;
}

function validateDestination(value: WeixinFrozenDestination): void {
  for (const item of [value.generationId, value.botId, value.ownerUserId, value.routeTokenId]) {
    if (item !== undefined && (item.length === 0 || Buffer.byteLength(item) > 16 * 1024)) {
      throw new TypeError("WeChat destination is invalid");
    }
  }
}

function digest32(value: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("WeChat outbound plan is invalid");
  return parsed as Record<string, unknown>;
}
