import { Buffer } from "node:buffer";
import { AppError } from "../core/errors.ts";
import type { WorkerNativeHistoryPage } from "../webui/worker-history-reader.ts";

const MAX_INLINE_WORDS = 1_000;
const MAX_INLINE_BYTES = 16 * 1_024;
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

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
  let wordCount = 0;
  for (const message of result.messages) {
    for (const segment of wordSegmenter.segment(message.body)) if (segment.isWordLike) wordCount += 1;
  }
  const inlineByteCount = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (wordCount <= MAX_INLINE_WORDS && inlineByteCount <= MAX_INLINE_BYTES) return result;
  const path = await deps.writeResultFile(result);
  return {
    storage: "file" as const,
    path,
    format: "json" as const,
    messageCount: result.messages.length,
    wordCount,
    inlineByteCount,
    hasOlder: result.hasOlder,
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    openTurnIds: result.openTurnIds,
    terminalTurnIds: result.terminalTurnIds,
  };
}
