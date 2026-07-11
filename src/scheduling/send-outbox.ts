// Durable idempotent outbox for schedule fires (Phase 2.2 wiring). This is the ONE
// dedup layer the trigger engine relies on: claiming a fire is a unique-constraint
// INSERT keyed by the single-fire key, so concurrent instances (shared-NFS DB) deliver
// at most once. Combined with the engine's advance-only-after-fire, delivery is
// at-least-once + idempotent.
//
// Usage (engine `fire`): claim → if won, send and markSent; on send failure release
// (so the engine re-fires next tick). If NOT won, the key is already being/been
// delivered — unless it's a stale 'sending' row (a crash mid-send), which is
// reclaimable so the fire is not lost.
import type { Database } from "../storage/database.ts";

export type ClaimOutcome = "claimed" | "in-flight" | "delivered";

export class ScheduledSendOutbox {
  constructor(private readonly db: Database, private readonly staleMs = 120_000) {}

  claim(singleFireKey: string, nickname: string, message: string, now: number): ClaimOutcome {
    const inserted = this.db.prepare(
      "INSERT INTO scheduled_sends(single_fire_key, nickname, message, state, claimed_at) VALUES (?, ?, ?, 'sending', ?) ON CONFLICT(single_fire_key) DO NOTHING",
    ).run(singleFireKey, nickname, message, now).changes;
    if (inserted === 1) return "claimed";
    const row = this.db.prepare("SELECT state, claimed_at FROM scheduled_sends WHERE single_fire_key = ?").get(singleFireKey) as { state: string; claimed_at: number } | undefined;
    if (row?.state === "sent") return "delivered";
    // A 'sending' row older than staleMs is a crashed delivery — reclaim it atomically.
    if (row && now - Number(row.claimed_at) > this.staleMs) {
      const reclaimed = this.db.prepare("UPDATE scheduled_sends SET claimed_at = ? WHERE single_fire_key = ? AND state = 'sending' AND claimed_at = ?")
        .run(now, singleFireKey, row.claimed_at).changes;
      return reclaimed === 1 ? "claimed" : "in-flight";
    }
    return "in-flight";
  }

  markSent(singleFireKey: string): void {
    this.db.prepare("UPDATE scheduled_sends SET state = 'sent' WHERE single_fire_key = ?").run(singleFireKey);
  }

  // Release a claim so the engine can re-fire (delivery failed).
  release(singleFireKey: string): void {
    this.db.prepare("DELETE FROM scheduled_sends WHERE single_fire_key = ? AND state = 'sending'").run(singleFireKey);
  }
}
