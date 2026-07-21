import { AppError } from "../core/errors.ts";
import type { WorkerNativeHistoryPage } from "../webui/worker-history-reader.ts";
import { boundLargeToolResult } from "./large-tool-result.ts";

export interface WorkerMessageMapping {
  endpoint: string;
  thread_id: string;
  mapping_id: string;
}

export interface WorkerMessageHistoryDeps {
  resolveSession(nickname: string): WorkerMessageMapping | undefined;
  writeResultFile(value: unknown): Promise<string>;
  readTurns(
    endpointId: string,
    threadId: string,
    mappingId: string,
    limit: number,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<WorkerNativeHistoryPage>;
}

export async function readWorkerMessages(
  deps: WorkerMessageHistoryDeps,
  args: { nickname: string; count: number; before?: string },
  signal: AbortSignal,
) {
  const session = deps.resolveSession(args.nickname);
  if (!session) throw new AppError("UNKNOWN_SESSION", `unknown session: ${args.nickname}`);
  const page = await deps.readTurns(
    session.endpoint, session.thread_id, session.mapping_id, args.count, args.before, signal,
  );
  const current = deps.resolveSession(args.nickname);
  if (!current || current.endpoint !== session.endpoint || current.thread_id !== session.thread_id
    || current.mapping_id !== session.mapping_id) {
    throw new AppError("OPERATION_CONFLICT", "worker mapping changed during message read");
  }
  const result = {
    messages: page.messages.map((message) => ({
      id: message.id,
      turnId: message.turnId,
      role: message.role === "you" ? "user" as const : "worker" as const,
      body: message.body,
      completedAt: message.completedAt,
      status: message.terminalStatus,
      ...(message.clientId ? { clientId: message.clientId } : {}),
      ...(message.phase ? { phase: message.phase } : {}),
    })),
    hasOlder: page.hasOlder,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    openTurnIds: page.openTurnIds,
    terminalTurnIds: page.terminalTurnIds,
  };
  return boundLargeToolResult(result, {
    writeResultFile: deps.writeResultFile,
    wordSources: result.messages.map((message) => message.body),
    metadata: {
    messageCount: result.messages.length,
    hasOlder: result.hasOlder,
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    openTurnIds: result.openTurnIds,
    terminalTurnIds: result.terminalTurnIds,
    },
  });
}
