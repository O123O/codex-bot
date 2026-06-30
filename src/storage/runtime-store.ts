import type { ManagementState } from "../core/types.ts";
import type { Database } from "./database.ts";

export class RuntimeStore {
  constructor(private readonly db: Database) {}

  setSession(endpointId: string, threadId: string, managementState: ManagementState, nativeStatus = "notLoaded"): void {
    this.db.prepare(`INSERT INTO session_runtime(endpoint_id, thread_id, management_state, native_status)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint_id, thread_id) DO UPDATE SET management_state = excluded.management_state, native_status = excluded.native_status`)
      .run(endpointId, threadId, managementState, nativeStatus);
  }

  getSession(endpointId: string, threadId: string): { managementState: ManagementState; nativeStatus: string; deliveryCursor?: string } | undefined {
    const row = this.db.prepare("SELECT * FROM session_runtime WHERE endpoint_id = ? AND thread_id = ?").get(endpointId, threadId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      managementState: String(row.management_state) as ManagementState,
      nativeStatus: String(row.native_status),
      ...(row.delivery_cursor ? { deliveryCursor: String(row.delivery_cursor) } : {}),
    };
  }
}
