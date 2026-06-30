import type { SourceContext } from "../core/types.ts";
import type { Database } from "../storage/database.ts";
import type { DeliveryStore } from "../storage/delivery-store.ts";
import type { OperationStore } from "../storage/operation-store.ts";

export interface ActiveCoordinatorContext { contextId: string; attemptId: string; turnId: string; triggerKind: "user" | "internal" }

export class CoordinatorRuntime {
  private active: ActiveCoordinatorContext | undefined;

  constructor(private readonly db: Database, private readonly operations: OperationStore, private readonly deliveries: DeliveryStore, private readonly options: { destination: string }) {}

  beginUserAttempt(contextId: string, attemptId: string, turnId: string): void { this.begin(contextId, attemptId, turnId, "user"); }
  beginInternalAttempt(contextId: string, attemptId: string, turnId: string): void { this.begin(contextId, attemptId, turnId, "internal"); }

  prepareAttempt(contextId: string, attemptId: string, triggerKind: "user" | "internal"): void {
    const provisionalTurnId = `pending:${attemptId}`;
    this.db.prepare(`INSERT OR REPLACE INTO coordinator_attempts(id, context_id, turn_id, trigger_kind, state, created_at)
      VALUES (?, ?, ?, ?, 'active', ?)`)
      .run(attemptId, contextId, provisionalTurnId, triggerKind, Date.now());
    this.active = { contextId, attemptId, turnId: provisionalTurnId, triggerKind };
  }

  bindTurn(attemptId: string, turnId: string): void {
    this.db.prepare("UPDATE coordinator_attempts SET turn_id = ? WHERE id = ? AND state = 'active'").run(turnId, attemptId);
    if (this.active?.attemptId === attemptId) this.active = { ...this.active, turnId };
  }

  current(): ActiveCoordinatorContext | undefined { return this.active ? { ...this.active } : undefined; }

  handleTerminal(turnId: string, finalText?: string): void {
    const attempt = this.attempt(turnId);
    if (!attempt) return;
    this.db.prepare("UPDATE coordinator_attempts SET state = 'completed' WHERE turn_id = ?").run(turnId);
    if (attempt.triggerKind === "user" && finalText) {
      this.deliveries.prepare({ id: `coordinator:${turnId}`, kind: "coordinator_final", destination: this.options.destination, body: `[coordinator] ${finalText}`, mandatory: true });
    }
    if (this.active?.turnId === turnId) this.active = undefined;
  }

  failAttempt(turnId: string, error: unknown): SourceContext | undefined {
    const attempt = this.attempt(turnId);
    if (!attempt) return undefined;
    const effects = this.db.prepare("SELECT id, state, receipt_json FROM operations WHERE context_id = ? AND attempt_id = ? AND state IN ('dispatched','succeeded','uncertain')")
      .all(attempt.contextId, attempt.attemptId) as Array<Record<string, unknown>>;
    this.db.prepare("UPDATE coordinator_attempts SET state = 'failed' WHERE turn_id = ?").run(turnId);
    if (this.active?.turnId === turnId) this.active = undefined;
    if (effects.length === 0) return undefined;
    return this.operations.supersedeWithRecovery(attempt.contextId, effects.map((effect) => ({ operationId: String(effect.id), state: effect.state === "succeeded" ? "succeeded" : "uncertain", ...(effect.receipt_json ? { receipt: JSON.parse(String(effect.receipt_json)) } : {}), error: String(error) })));
  }

  private begin(contextId: string, attemptId: string, turnId: string, triggerKind: "user" | "internal"): void {
    this.prepareAttempt(contextId, attemptId, triggerKind);
    this.bindTurn(attemptId, turnId);
  }

  private attempt(turnId: string): ActiveCoordinatorContext | undefined {
    const row = this.db.prepare("SELECT context_id, id, turn_id, trigger_kind FROM coordinator_attempts WHERE turn_id = ?").get(turnId) as Record<string, unknown> | undefined;
    return row ? { contextId: String(row.context_id), attemptId: String(row.id), turnId: String(row.turn_id), triggerKind: String(row.trigger_kind) as "user" | "internal" } : undefined;
  }
}
