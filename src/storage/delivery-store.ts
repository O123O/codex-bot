import { randomUUID } from "node:crypto";
import type { ConversationBinding, JsonValue } from "../chat/binding.ts";
import type { DeliveryState } from "../core/types.ts";
import type { Database } from "./database.ts";
import { inTransaction } from "./database.ts";

export interface DeliveryRecord {
  id: string;
  kind: string;
  binding: ConversationBinding;
  body: string;
  attachmentId?: string;
  attachmentScopeId?: string;
  mandatory: boolean;
  state: DeliveryState;
  receipt?: JsonValue;
  attemptCount: number;
}

export class DeliveryStore {
  constructor(private readonly db: Database) {}

  prepare(input: { kind: string; binding: ConversationBinding; body: string; mandatory: boolean; id?: string; attachmentId?: string; attachmentScopeId?: string }): DeliveryRecord {
    const id = input.id ?? `delivery_${randomUUID()}`;
    const existing = this.get(id);
    if (existing) return existing;
    return this.insert(id, input);
  }

  prepareAttachment(input: { kind: string; binding: ConversationBinding; body: string; mandatory: boolean; id?: string; attachmentId: string; attachmentScopeId: string }): DeliveryRecord {
    const id = input.id ?? `delivery_${randomUUID()}`;
    return inTransaction(this.db, () => {
      const existing = this.get(id);
      if (existing) return existing;
      const delivery = this.insert(id, input);
      const retained = this.db.prepare("UPDATE attachments SET ref_count = ref_count + 1 WHERE id = ? AND scope_id = ?")
        .run(input.attachmentId, input.attachmentScopeId).changes;
      if (retained !== 1) throw new Error("attachment delivery handle is missing or out of scope");
      return delivery;
    });
  }

  private insert(id: string, input: { kind: string; binding: ConversationBinding; body: string; mandatory: boolean; attachmentId?: string; attachmentScopeId?: string }): DeliveryRecord {
    const now = Date.now();
    this.db.prepare(`INSERT INTO deliveries
      (id, kind, destination, body, attachment_id, attachment_scope_id, reply_to, mandatory, state, created_at, updated_at,
        adapter_id, conversation_key, destination_json, reply_json)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'prepared', ?, ?, ?, ?, ?, ?)`)
      .run(id, input.kind, JSON.stringify(input.binding.destination), input.body, input.attachmentId ?? null, input.attachmentScopeId ?? null,
        input.mandatory ? 1 : 0, now, now, input.binding.adapterId, input.binding.conversationKey,
        JSON.stringify(input.binding.destination), input.binding.reply === undefined ? null : JSON.stringify(input.binding.reply));
    return this.get(id) as DeliveryRecord;
  }

  get(id: string): DeliveryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      kind: String(row.kind),
      binding: {
        adapterId: String(row.adapter_id),
        conversationKey: String(row.conversation_key),
        destination: JSON.parse(String(row.destination_json)),
        ...(row.reply_json ? { reply: JSON.parse(String(row.reply_json)) as JsonValue } : {}),
      },
      body: String(row.body),
      ...(row.attachment_id ? { attachmentId: String(row.attachment_id) } : {}),
      ...(row.attachment_scope_id ? { attachmentScopeId: String(row.attachment_scope_id) } : {}),
      mandatory: Number(row.mandatory) === 1,
      state: String(row.state) as DeliveryState,
      ...(row.receipt_json ? { receipt: JSON.parse(String(row.receipt_json)) as JsonValue } : {}),
      attemptCount: Number(row.attempt_count),
    };
  }

  markDispatched(id: string): void {
    this.db.prepare("UPDATE deliveries SET state = 'dispatched', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  confirm(id: string, receipt: JsonValue): void {
    inTransaction(this.db, () => {
      const prior = this.db.prepare("SELECT state, mandatory FROM deliveries WHERE id = ?").get(id) as
        { state: string; mandatory: number } | undefined;
      if (!prior || prior.state === "confirmed" || prior.state === "failed") return;
      const changed = this.db.prepare("UPDATE deliveries SET state = 'confirmed', receipt_json = ?, updated_at = ? WHERE id = ? AND state <> 'confirmed'")
        .run(JSON.stringify(receipt), Date.now(), id).changes;
      if (changed && !(prior.state === "uncertain" && prior.mandatory === 0)) this.releaseAttachment(id);
    });
  }

  fail(id: string): void {
    inTransaction(this.db, () => { this.failInTransaction(id); });
  }

  failInTransaction(id: string): boolean {
    const prior = this.db.prepare("SELECT state, mandatory FROM deliveries WHERE id = ?").get(id) as
      { state: string; mandatory: number } | undefined;
    if (!prior || prior.state === "failed" || prior.state === "confirmed") return false;
    const changed = this.db.prepare("UPDATE deliveries SET state = 'failed', updated_at = ? WHERE id = ? AND state = ?")
      .run(Date.now(), id, prior.state).changes;
    if (changed !== 1) return false;
    if (!(prior.state === "uncertain" && prior.mandatory === 0)) this.releaseAttachment(id);
    return true;
  }

  markUncertain(id: string): void {
    inTransaction(this.db, () => {
      const row = this.db.prepare("SELECT state, mandatory FROM deliveries WHERE id = ?").get(id) as { state: string; mandatory: number } | undefined;
      if (!row || row.state === "uncertain") return;
      this.db.prepare("UPDATE deliveries SET state = 'uncertain', updated_at = ? WHERE id = ?").run(Date.now(), id);
      if (row.mandatory === 0) this.releaseAttachment(id);
    });
  }

  markPrepared(id: string): void {
    this.db.prepare("UPDATE deliveries SET state = 'prepared', updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  recoverAfterCrash(): DeliveryRecord[] {
    return inTransaction(this.db, () => {
      const optional = this.db.prepare("SELECT id FROM deliveries WHERE state = 'dispatched' AND mandatory = 0").all() as Array<{ id: string }>;
      const recovered = this.db.prepare("SELECT id FROM deliveries WHERE state = 'dispatched' ORDER BY created_at, id").all() as Array<{ id: string }>;
      this.db.prepare("UPDATE deliveries SET state = 'uncertain', updated_at = ? WHERE state = 'dispatched'").run(Date.now());
      for (const delivery of optional) {
        this.releaseAttachment(delivery.id);
        const original = this.get(delivery.id)!;
        this.prepare({
          id: `delivery-warning:${delivery.id}`,
          kind: "delivery_warning",
          binding: original.binding,
          body: `[system] delivery ${delivery.id} could not be confirmed and was not automatically retried`,
          mandatory: true,
        });
      }
      return recovered.map(({ id }) => this.get(id)!).filter(Boolean);
    });
  }

  listReady(): DeliveryRecord[] {
    const rows = this.db.prepare("SELECT id FROM deliveries WHERE state IN ('prepared', 'uncertain') ORDER BY created_at").all() as Array<{ id: string }>;
    return rows.map(({ id }) => this.get(id) as DeliveryRecord);
  }

  private releaseAttachment(deliveryId: string): void {
    this.db.prepare(`UPDATE attachments SET ref_count = MAX(ref_count - 1, 0)
      WHERE id = (SELECT attachment_id FROM deliveries WHERE id = ?)`).run(deliveryId);
  }
}
