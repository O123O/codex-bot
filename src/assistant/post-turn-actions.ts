import { AppError } from "../core/errors.ts";
import type { Database } from "../storage/database.ts";

export type AssistantPostTurnActionKind = "compact" | "restart";
export type AssistantPostTurnActionState = "pending" | "running" | "completed" | "failed";

export interface AssistantPostTurnAction {
  id: string;
  kind: AssistantPostTurnActionKind;
  payload: Record<string, unknown>;
  state: AssistantPostTurnActionState;
  error?: { message: string };
}

interface ActionContext {
  checkpoint(payload: Record<string, unknown>): void;
}

type ActionHandler = (action: AssistantPostTurnAction, context: ActionContext) => Promise<void>;

export class PostTurnActionRetry extends Error {
  constructor(message: string) { super(message); this.name = "PostTurnActionRetry"; }
}

export class AssistantPostTurnActions {
  private draining: Promise<{ completed: number; failed: number; pending: number }> | undefined;

  constructor(
    private readonly db: Database,
    private readonly handlers: Partial<Record<AssistantPostTurnActionKind, ActionHandler>>,
  ) {}

  schedule(id: string, kind: AssistantPostTurnActionKind, payload: Record<string, unknown>): boolean {
    const encoded = canonical(payload);
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO assistant_post_turn_actions
      (id, kind, payload_json, state, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)`)
      .run(id, kind, encoded, Date.now(), Date.now()).changes === 1;
    if (inserted) return true;
    const existing = this.db.prepare("SELECT kind, payload_json FROM assistant_post_turn_actions WHERE id = ?")
      .get(id) as { kind: string; payload_json: string } | undefined;
    if (!existing || existing.kind !== kind || existing.payload_json !== encoded) {
      throw new AppError("OPERATION_CONFLICT", `post-turn action ${id} changed kind or payload`);
    }
    return false;
  }

  get(id: string): AssistantPostTurnAction | undefined {
    const row = this.db.prepare("SELECT id, kind, payload_json, state, error_json FROM assistant_post_turn_actions WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? parseAction(row) : undefined;
  }

  hasPending(): boolean {
    return this.db.prepare("SELECT 1 FROM assistant_post_turn_actions WHERE state IN ('pending', 'running') LIMIT 1").get() !== undefined;
  }

  drain(): Promise<{ completed: number; failed: number; pending: number }> {
    if (this.draining) return this.draining;
    const running = this.drainOnce().finally(() => {
      if (this.draining === running) this.draining = undefined;
    });
    this.draining = running;
    return running;
  }

  private async drainOnce(): Promise<{ completed: number; failed: number; pending: number }> {
    const result = { completed: 0, failed: 0, pending: 0 };
    const ids = (this.db.prepare(`SELECT id FROM assistant_post_turn_actions
      WHERE state IN ('pending', 'running') ORDER BY created_at, id`).all() as Array<{ id: string }>).map((row) => row.id);
    for (const id of ids) {
      const action = this.get(id);
      if (!action || (action.state !== "pending" && action.state !== "running")) continue;
      const handler = this.handlers[action.kind];
      if (!handler) {
        this.fail(id, new Error(`post-turn action handler is not configured: ${action.kind}`));
        result.failed += 1;
        continue;
      }
      if (action.state === "pending") {
        this.db.prepare("UPDATE assistant_post_turn_actions SET state = 'running', error_json = NULL, updated_at = ? WHERE id = ? AND state = 'pending'")
          .run(Date.now(), id);
      }
      const running = this.get(id);
      if (!running || running.state !== "running") continue;
      try {
        await handler(running, {
          checkpoint: (payload) => {
            const changed = this.db.prepare(`UPDATE assistant_post_turn_actions SET payload_json = ?, updated_at = ?
              WHERE id = ? AND state = 'running'`).run(canonical(payload), Date.now(), id).changes;
            if (changed !== 1) throw new AppError("OPERATION_CONFLICT", `post-turn action ${id} is no longer running`);
          },
        });
        this.db.prepare("UPDATE assistant_post_turn_actions SET state = 'completed', error_json = NULL, updated_at = ? WHERE id = ? AND state = 'running'")
          .run(Date.now(), id);
        result.completed += 1;
      } catch (error) {
        if (error instanceof PostTurnActionRetry) {
          this.db.prepare("UPDATE assistant_post_turn_actions SET state = 'pending', error_json = ?, updated_at = ? WHERE id = ? AND state = 'running'")
            .run(JSON.stringify({ message: error.message }), Date.now(), id);
          result.pending += 1;
        } else {
          this.fail(id, error);
          result.failed += 1;
        }
      }
    }
    return result;
  }

  private fail(id: string, error: unknown): void {
    this.db.prepare("UPDATE assistant_post_turn_actions SET state = 'failed', error_json = ?, updated_at = ? WHERE id = ? AND state IN ('pending', 'running')")
      .run(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }), Date.now(), id);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function parseAction(row: Record<string, unknown>): AssistantPostTurnAction {
  return {
    id: String(row.id),
    kind: String(row.kind) as AssistantPostTurnActionKind,
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    state: String(row.state) as AssistantPostTurnActionState,
    ...(row.error_json ? { error: JSON.parse(String(row.error_json)) as { message: string } } : {}),
  };
}
