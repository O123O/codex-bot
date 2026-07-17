import { ThreadHistoryReader } from "../app-server/thread-history.ts";
import type { EndpointWorkLease } from "../endpoints/types.ts";
import type { WorkerNativeHistoryPage } from "./worker-history-reader.ts";
import { openWorkerTurnIds, terminalWorkerTurnIds, workerConversationRows } from "./worker-conversation.ts";

export interface ReadyWorkerReadDeps {
  withReadyWorkLease<T>(endpointId: string, run: (lease: EndpointWorkLease) => Promise<T>): Promise<T>;
  request(endpointId: string, method: string, params: unknown, signal?: AbortSignal, lease?: EndpointWorkLease): Promise<unknown>;
}

// Claude's runtime implements the same native turn page contract. Codex history uses its bounded
// rollout reader instead, because legacy Codex does not expose item pagination and a full turn can
// exceed the remote App Server WebSocket frame.
export async function readReadyWorkerTurns(
  deps: ReadyWorkerReadDeps,
  endpointId: string,
  threadId: string,
  limit: number,
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<WorkerNativeHistoryPage> {
  return deps.withReadyWorkLease(endpointId, async (lease) => {
    const history = new ThreadHistoryReader((method, params) => deps.request(endpointId, method, params, signal, lease));
    const page = await history.turnsPage(threadId, {
      ...(cursor === undefined ? {} : { cursor }),
      limit: Math.max(1, Math.min(12, Math.trunc(limit) || 12)),
      sortDirection: "desc",
      itemsView: "full",
    });
    const turns = [...page.data].reverse();
    return {
      messages: workerConversationRows(turns).map((row) => ({
        id: row.id, turnId: row.turnId, body: row.body, completedAt: row.completedAt,
        terminalStatus: row.terminalStatus, turnOrder: row.turnOrder, itemOrder: row.itemOrder,
        ...(row.role === "you" ? { role: "you" as const } : {}),
        ...(row.clientId ? { clientId: row.clientId } : {}),
        ...(row.phase ? { phase: row.phase } : {}),
      })),
      hasOlder: page.nextCursor !== null,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      openTurnIds: openWorkerTurnIds(turns),
      terminalTurnIds: terminalWorkerTurnIds(turns).slice(-50),
    };
  });
}
