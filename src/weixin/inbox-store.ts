import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { AttachmentStore, FileHandleId, StoredAttachment } from "../attachments/store.ts";
import type { Database } from "../storage/database.ts";
import { inTransaction } from "../storage/database.ts";
import { classifyWeixinMessage, type WeixinClassifiedItem, type WeixinOwnerIdentity } from "./event-classifier.ts";
import type { ParsedUpdates, WeixinMessageIdentity } from "./protocol.ts";

export interface WeixinInboxRecord {
  generationId: string;
  identity: WeixinMessageIdentity;
  arrivalSequence: number;
  state: "pending" | "processing" | "retry" | "processed" | "fenced";
  items: readonly WeixinClassifiedItem[];
  routeTokenId?: string;
  attemptCount: number;
}

export interface WeixinPollCommit {
  inserted: number;
  discarded: number;
  cursor: string;
}

interface InboxStoreOptions {
  now?: () => number;
  beforeCursorUpdate?: () => void;
  attachments?: AttachmentStore;
}

interface InboxRow {
  generation_id: string;
  identity_kind: "message" | "client";
  identity_value: string;
  arrival_sequence: number;
  state: WeixinInboxRecord["state"];
  normalized_json: string;
  route_token_id: string | null;
  attempt_count: number;
}

export class WeixinInboxStore {
  private readonly now: () => number;

  constructor(
    private readonly db: Database,
    private readonly owner: WeixinOwnerIdentity,
    private readonly options: InboxStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  cursor(generationId: string): string {
    const row = this.db.prepare("SELECT cursor FROM weixin_sync_state WHERE generation_id = ?").get(generationId) as
      { cursor: string } | undefined;
    if (!row) throw new Error("WeChat account generation is unavailable");
    return row.cursor;
  }

  commitPoll(generationId: string, expectedCursor: string, batch: ParsedUpdates): WeixinPollCommit {
    return inTransaction(this.db, () => {
      this.requireActive(generationId);
      const current = this.cursor(generationId);
      if (current !== expectedCursor) throw new Error("WeChat polling cursor changed unexpectedly");
      let inserted = 0;
      let discarded = 0;
      for (const candidate of batch.messages) {
        const message = classifyWeixinMessage(candidate, this.owner);
        if (!message || this.has(generationId, message.identity)) {
          discarded += 1;
          continue;
        }
        const routeTokenId = message.contextToken === undefined
          ? undefined
          : this.storeRouteToken(generationId, message.contextToken);
        const sequence = this.allocateSequence();
        const now = this.now();
        this.db.prepare(`INSERT INTO weixin_inbox
          (generation_id, identity_kind, identity_value, arrival_sequence, state, normalized_json, route_token_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
          .run(generationId, message.identity.kind, message.identity.value, sequence,
            JSON.stringify({ ordinal: message.ordinal, items: message.items }), routeTokenId ?? null, now, now);
        inserted += 1;
      }
      this.options.beforeCursorUpdate?.();
      const cursor = batch.cursor ?? current;
      if (batch.cursor !== undefined) {
        const changed = this.db.prepare("UPDATE weixin_sync_state SET cursor = ? WHERE generation_id = ? AND cursor = ?")
          .run(batch.cursor, generationId, expectedCursor).changes;
        if (changed !== 1) throw new Error("WeChat polling cursor changed unexpectedly");
      }
      return { inserted, discarded, cursor };
    });
  }

  list(generationId: string): readonly WeixinInboxRecord[] {
    const rows = this.db.prepare(`SELECT * FROM weixin_inbox WHERE generation_id = ?
      ORDER BY arrival_sequence`).all(generationId) as unknown as InboxRow[];
    return rows.map(toRecord);
  }

  get(generationId: string, identity: WeixinMessageIdentity): WeixinInboxRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM weixin_inbox
      WHERE generation_id = ? AND identity_kind = ? AND identity_value = ?`)
      .get(generationId, identity.kind, identity.value) as unknown as InboxRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  claimHead(generationId: string): WeixinInboxRecord | undefined {
    return inTransaction(this.db, () => {
      if (!this.isActive(generationId)) return undefined;
      const processing = this.db.prepare(`SELECT 1 AS present FROM weixin_inbox
        WHERE generation_id = ? AND state = 'processing'`).get(generationId);
      if (processing) return undefined;
      const row = this.db.prepare(`SELECT identity_kind, identity_value FROM weixin_inbox
        WHERE generation_id = ? AND state IN ('pending', 'retry') ORDER BY arrival_sequence LIMIT 1`)
        .get(generationId) as { identity_kind: "message" | "client"; identity_value: string } | undefined;
      if (!row) return undefined;
      const changed = this.db.prepare(`UPDATE weixin_inbox SET state = 'processing', attempt_count = attempt_count + 1, updated_at = ?
        WHERE generation_id = ? AND identity_kind = ? AND identity_value = ? AND state IN ('pending', 'retry')`)
        .run(this.now(), generationId, row.identity_kind, row.identity_value).changes;
      if (changed !== 1) return undefined;
      return this.get(generationId, { kind: row.identity_kind, value: row.identity_value });
    });
  }

  recoverProcessing(generationId: string): void {
    this.db.prepare(`UPDATE weixin_inbox SET state = 'retry', updated_at = ?
      WHERE generation_id = ? AND state = 'processing'`).run(this.now(), generationId);
  }

  checkpointAttachment(
    generationId: string,
    identity: WeixinMessageIdentity,
    itemOrdinal: number,
    input: { scopeId: string; attachment: StoredAttachment; descriptor?: unknown },
  ): void {
    if (!this.options.attachments) throw new Error("WeChat attachment store is unavailable");
    inTransaction(this.db, () => {
      const inbox = this.get(generationId, identity);
      if (!inbox || inbox.state !== "processing") throw new Error("WeChat inbox row is not processing");
      const descriptor = JSON.stringify(input.descriptor ?? {});
      const existing = this.db.prepare(`SELECT state, descriptor_json, attachment_id, attachment_scope_id
        FROM weixin_inbox_media WHERE generation_id = ? AND identity_kind = ? AND identity_value = ? AND item_ordinal = ?`)
        .get(generationId, identity.kind, identity.value, itemOrdinal) as {
          state: string; descriptor_json: string; attachment_id: string | null; attachment_scope_id: string | null;
        } | undefined;
      if (existing) {
        if (existing.state !== "completed" || existing.descriptor_json !== descriptor
          || existing.attachment_id !== input.attachment.id || existing.attachment_scope_id !== input.scopeId) {
          throw new Error("WeChat media checkpoint is inconsistent");
        }
        const hold = this.db.prepare(`SELECT COUNT(*) AS total,
            SUM(CASE WHEN hold_id = ? AND generation_id = ? AND identity_kind = ? AND identity_value = ?
              AND scope_id = ? THEN 1 ELSE 0 END) AS matching
          FROM weixin_inbox_attachment_refs WHERE attachment_id = ?`)
          .get(inboxHoldId(generationId, identity), generationId, identity.kind, identity.value,
            input.scopeId, input.attachment.id) as { total: number; matching: number };
        const retained = this.db.prepare("SELECT ref_count FROM attachments WHERE id = ? AND scope_id = ?")
          .get(input.attachment.id, input.scopeId) as { ref_count: number } | undefined;
        if (hold.total !== 1 || hold.matching !== 1 || !retained || retained.ref_count < 1) {
          throw new Error("WeChat media checkpoint hold is inconsistent");
        }
        return;
      }
      this.db.prepare(`INSERT INTO weixin_inbox_media
        (generation_id, identity_kind, identity_value, item_ordinal, hold_id, state, descriptor_json,
          attachment_id, attachment_scope_id, updated_at)
        VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`)
        .run(generationId, identity.kind, identity.value, itemOrdinal, inboxHoldId(generationId, identity), descriptor,
          input.attachment.id, input.scopeId, this.now());
      this.options.attachments!.retainInboxAttachmentInTransaction(
        inboxHoldId(generationId, identity), input.scopeId, input.attachment.id,
      );
    });
  }

  attachmentHoldCount(generationId: string, identity: WeixinMessageIdentity): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM weixin_inbox_attachment_refs WHERE hold_id = ?")
      .get(inboxHoldId(generationId, identity)) as { count: number }).count);
  }

  resolveRouteToken(generationId: string, routeTokenId?: string): string | undefined {
    const row = routeTokenId === undefined
      ? this.db.prepare(`SELECT token FROM weixin_route_tokens
        WHERE generation_id = ? AND is_current = 1`).get(generationId)
      : this.db.prepare(`SELECT token FROM weixin_route_tokens
        WHERE generation_id = ? AND id = ?`).get(generationId, routeTokenId);
    return (row as { token: string } | undefined)?.token;
  }

  collectUnreferencedRouteTokens(generationId: string): number {
    return Number(this.db.prepare(`DELETE FROM weixin_route_tokens AS token
      WHERE token.generation_id = ? AND token.is_current = 0
        AND NOT EXISTS (SELECT 1 FROM weixin_inbox WHERE generation_id = token.generation_id AND route_token_id = token.id)
        AND NOT EXISTS (SELECT 1 FROM weixin_outbound_steps WHERE generation_id = token.generation_id AND route_token_id = token.id)
        AND NOT EXISTS (SELECT 1 FROM source_contexts
          WHERE adapter_id = 'weixin' AND json_valid(destination_json) AND json_extract(destination_json, '$.routeTokenId') = token.id)
        AND NOT EXISTS (SELECT 1 FROM assistant_attempts
          WHERE adapter_id = 'weixin' AND json_valid(destination_json) AND json_extract(destination_json, '$.routeTokenId') = token.id)
        AND NOT EXISTS (SELECT 1 FROM deliveries
          WHERE adapter_id = 'weixin' AND json_valid(destination_json) AND json_extract(destination_json, '$.routeTokenId') = token.id)`)
      .run(generationId).changes);
  }

  private requireActive(generationId: string): void {
    if (!this.isActive(generationId)) throw new Error("WeChat account authorization is inactive");
  }

  private isActive(generationId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 AS present FROM weixin_account_generations
      WHERE generation_id = ? AND active = 1 AND authorization_state = 'active'`).get(generationId));
  }

  private has(generationId: string, identity: WeixinMessageIdentity): boolean {
    return Boolean(this.db.prepare(`SELECT 1 AS present FROM weixin_inbox
      WHERE generation_id = ? AND identity_kind = ? AND identity_value = ?`)
      .get(generationId, identity.kind, identity.value));
  }

  private allocateSequence(): number {
    const row = this.db.prepare("SELECT next_value FROM weixin_inbox_sequence WHERE singleton = 1").get() as { next_value: number };
    this.db.prepare("UPDATE weixin_inbox_sequence SET next_value = next_value + 1 WHERE singleton = 1").run();
    return row.next_value;
  }

  private storeRouteToken(generationId: string, token: string): string {
    const current = this.db.prepare(`SELECT id, token FROM weixin_route_tokens
      WHERE generation_id = ? AND is_current = 1`).get(generationId) as { id: string; token: string } | undefined;
    if (current?.token === token) return current.id;
    this.db.prepare("UPDATE weixin_route_tokens SET is_current = 0 WHERE generation_id = ? AND is_current = 1").run(generationId);
    const id = `weixin-route-${randomUUID()}`;
    this.db.prepare(`INSERT INTO weixin_route_tokens(id, generation_id, token, is_current, created_at)
      VALUES (?, ?, ?, 1, ?)`).run(id, generationId, token, this.now());
    return id;
  }
}

export function weixinNativeSourceId(generationId: string, identity: WeixinMessageIdentity): string {
  return `weixin:${generationId}:${identity.kind}:${identity.value}`;
}

export function inboxHoldId(generationId: string, identity: WeixinMessageIdentity): string {
  return `weixin-inbox-${createHash("sha256").update(JSON.stringify([generationId, identity.kind, identity.value])).digest("hex")}`;
}

function toRecord(row: InboxRow): WeixinInboxRecord {
  const normalized = JSON.parse(row.normalized_json) as { items: WeixinClassifiedItem[] };
  return {
    generationId: row.generation_id,
    identity: { kind: row.identity_kind, value: row.identity_value },
    arrivalSequence: row.arrival_sequence,
    state: row.state,
    items: normalized.items,
    ...(row.route_token_id === null ? {} : { routeTokenId: row.route_token_id }),
    attemptCount: row.attempt_count,
  };
}
