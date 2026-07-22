import { AppError } from "../core/errors.ts";
import type { Database } from "./database.ts";
import { inTransaction } from "./database.ts";

export interface AssistantDelegatedTurn {
  endpointId: string;
  threadId: string;
  turnId: string;
  mappingId: string;
  operationId: string;
  createdAt: number;
}

export interface DelegatedTurnRecordResult {
  inserted: boolean;
  reactivatedTerminalEvent: boolean;
}

interface CurrentMapping {
  endpoint: string;
  thread_id: string;
  mapping_id: string;
}

export class AssistantDelegatedTurnStore {
  constructor(private readonly db: Database) {}

  record(value: AssistantDelegatedTurn, options: { reactivateProcessed?: boolean } = {}): DelegatedTurnRecordResult {
    return inTransaction(this.db, () => {
      const inserted = Number(this.db.prepare(`INSERT OR IGNORE INTO assistant_delegated_turns
        (endpoint_id, thread_id, turn_id, mapping_id, operation_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        value.endpointId,
        value.threadId,
        value.turnId,
        value.mappingId,
        value.operationId,
        value.createdAt,
      ).changes) === 1;
      if (inserted) {
        const eligibleState = options.reactivateProcessed === false ? "state = 'coalesced'" : "state IN ('processed', 'coalesced')";
        const reactivatedTerminalEvent = Number(this.db.prepare(`UPDATE events SET state = 'pending'
          WHERE id = ? AND ${eligibleState}`).run(
          `terminal:${value.endpointId}:${value.threadId}:${value.turnId}`,
        ).changes) === 1;
        return { inserted: true, reactivatedTerminalEvent };
      }
      const existing = this.db.prepare(`SELECT endpoint_id, thread_id, turn_id, mapping_id, operation_id
        FROM assistant_delegated_turns WHERE operation_id = ? OR
        (endpoint_id = ? AND thread_id = ? AND turn_id = ?)`)
        .get(value.operationId, value.endpointId, value.threadId, value.turnId) as Record<string, unknown> | undefined;
      if (existing
        && existing.endpoint_id === value.endpointId
        && existing.thread_id === value.threadId
        && existing.turn_id === value.turnId
        && existing.mapping_id === value.mappingId
        && existing.operation_id === value.operationId) {
        return { inserted: false, reactivatedTerminalEvent: false };
      }
      throw new AppError("OPERATION_CONFLICT", "QiYan worker-turn delegation identity changed");
    });
  }

  backfillLastSentStarts(mappings: readonly CurrentMapping[]): number {
    const state = this.db.prepare("SELECT delegation_backfill_completed FROM qiyan_state WHERE product = 'qiyan-bot'")
      .get() as { delegation_backfill_completed: number } | undefined;
    if (state?.delegation_backfill_completed === 1) return 0;
    const starts = new Map<string, { operationId: string; createdAt: number }>();
    const ambiguous = new Set<string>();
    const rows = this.db.prepare(`SELECT id, args_json, receipt_json, created_at FROM operations
      WHERE kind = 'send_to_session' AND state = 'succeeded' AND receipt_json IS NOT NULL`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      let args: Record<string, unknown>;
      let receipt: Record<string, unknown>;
      try {
        args = JSON.parse(String(row.args_json)) as Record<string, unknown>;
        receipt = JSON.parse(String(row.receipt_json)) as Record<string, unknown>;
      } catch { continue; }
      if (args.mode !== "start" || typeof receipt.turnId !== "string" || receipt.turnId.length === 0) continue;
      if (starts.has(receipt.turnId)) {
        starts.delete(receipt.turnId);
        ambiguous.add(receipt.turnId);
      } else if (!ambiguous.has(receipt.turnId)) {
        starts.set(receipt.turnId, { operationId: String(row.id), createdAt: Number(row.created_at) });
      }
    }
    let inserted = 0;
    for (const mapping of mappings) {
      const fact = this.db.prepare(`SELECT last_sent_json FROM session_dashboard_facts
        WHERE endpoint_id = ? AND thread_id = ?`).get(mapping.endpoint, mapping.thread_id) as
        { last_sent_json: string | null } | undefined;
      if (!fact?.last_sent_json) continue;
      let turnId: string | undefined;
      try {
        const lastSent = JSON.parse(fact.last_sent_json) as Record<string, unknown>;
        if (typeof lastSent.turn_id === "string" && lastSent.turn_id.length > 0) turnId = lastSent.turn_id;
      } catch { continue; }
      const start = turnId ? starts.get(turnId) : undefined;
      if (!turnId || !start) continue;
      if (this.record({
        endpointId: mapping.endpoint,
        threadId: mapping.thread_id,
        turnId,
        mappingId: mapping.mapping_id,
        operationId: start.operationId,
        createdAt: start.createdAt,
      }, { reactivateProcessed: false }).inserted) inserted += 1;
    }
    this.db.prepare("UPDATE qiyan_state SET delegation_backfill_completed = 1 WHERE product = 'qiyan-bot'").run();
    return inserted;
  }

  has(endpointId: string, threadId: string, turnId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM assistant_delegated_turns
      WHERE endpoint_id = ? AND thread_id = ? AND turn_id = ?`)
      .get(endpointId, threadId, turnId) !== undefined;
  }
}
