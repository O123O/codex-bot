import { randomUUID } from "node:crypto";
import type { DeliveryState } from "../core/types.ts";
import type { Database } from "./database.ts";

export interface DeliveryRecord {
  id: string;
  kind: string;
  destination: string;
  body: string;
  mandatory: boolean;
  state: DeliveryState;
  telegramMessageId?: string;
  attemptCount: number;
}

export class DeliveryStore {
  constructor(private readonly db: Database) {}

  prepare(input: { kind: string; destination: string; body: string; mandatory: boolean; id?: string }): DeliveryRecord {
    const id = input.id ?? `delivery_${randomUUID()}`;
    const existing = this.get(id);
    if (existing) return existing;
    const now = Date.now();
    this.db.prepare(`INSERT INTO deliveries
      (id, kind, destination, body, mandatory, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?)`)
      .run(id, input.kind, input.destination, input.body, input.mandatory ? 1 : 0, now, now);
    return this.get(id) as DeliveryRecord;
  }

  get(id: string): DeliveryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      kind: String(row.kind),
      destination: String(row.destination),
      body: String(row.body),
      mandatory: Number(row.mandatory) === 1,
      state: String(row.state) as DeliveryState,
      ...(row.telegram_message_id ? { telegramMessageId: String(row.telegram_message_id) } : {}),
      attemptCount: Number(row.attempt_count),
    };
  }

  markDispatched(id: string): void {
    this.db.prepare("UPDATE deliveries SET state = 'dispatched', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  confirm(id: string, telegramMessageId: string): void {
    this.db.prepare("UPDATE deliveries SET state = 'confirmed', telegram_message_id = ?, updated_at = ? WHERE id = ?")
      .run(telegramMessageId, Date.now(), id);
  }

  fail(id: string): void {
    this.db.prepare("UPDATE deliveries SET state = 'failed', updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  recoverAfterCrash(): void {
    this.db.prepare("UPDATE deliveries SET state = 'uncertain', updated_at = ? WHERE state = 'dispatched'").run(Date.now());
  }

  listReady(): DeliveryRecord[] {
    const rows = this.db.prepare("SELECT id FROM deliveries WHERE state IN ('prepared', 'uncertain') ORDER BY created_at").all() as Array<{ id: string }>;
    return rows.map(({ id }) => this.get(id) as DeliveryRecord);
  }
}
