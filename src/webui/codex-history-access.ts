import { z } from "zod";
import { AppError } from "../core/errors.ts";
import type { RemoteRuntimeClient } from "../endpoints/ssh-runtime.ts";
import type { EndpointWorkLease } from "../endpoints/types.ts";
import { readCodexRolloutHistory, type CodexRolloutHistoryRequest } from "./codex-rollout-history.ts";
import type { WorkerHistoryPage } from "./worker-history-reader.ts";

const messageSchema = z.object({
  id: z.string().min(1).max(512),
  turnId: z.string().min(1).max(256),
  body: z.string().max(140 * 1024),
  completedAt: z.number().int().nonnegative().safe(),
  terminalStatus: z.string().max(64),
  turnOrder: z.number().int().nonnegative().safe(),
  itemOrder: z.number().int().nonnegative().safe(),
  role: z.literal("you").optional(),
  clientId: z.string().min(1).max(512).optional(),
  phase: z.string().min(1).max(128).optional(),
}).strict();
const pageSchema = z.object({
  messages: z.array(messageSchema).max(50),
  hasOlder: z.boolean(),
  nextCursor: z.string().min(1).max(4096).optional(),
  openTurnIds: z.array(z.string().min(1).max(256)).max(50),
  terminalTurnIds: z.array(z.string().min(1).max(256)).max(50),
}).strict();

export class CodexHistoryAccess {
  constructor(private readonly options: {
    remote(endpointId: string): { remote: RemoteRuntimeClient; helperPath: string } | undefined;
    isLocal(endpointId: string): boolean;
    validateLease?(endpointId: string, lease: EndpointWorkLease): boolean;
    readLocal?(request: CodexRolloutHistoryRequest): Promise<WorkerHistoryPage>;
  }) {}

  async read(
    endpointId: string,
    request: CodexRolloutHistoryRequest,
    lease?: EndpointWorkLease,
    signal?: AbortSignal,
  ): Promise<WorkerHistoryPage> {
    if (signal?.aborted) throw signal.reason;
    this.requireLease(endpointId, lease);
    if (this.options.isLocal(endpointId)) {
      const page = await (this.options.readLocal ?? readCodexRolloutHistory)(request);
      this.requireLease(endpointId, lease);
      return page;
    }
    const context = this.options.remote(endpointId);
    if (!context) throw new AppError("ENDPOINT_UNAVAILABLE", `SSH Codex history helper is unavailable: ${endpointId}`);
    const response = await context.remote.invoke("codex-history", [JSON.stringify(request)], context.helperPath, signal ? { signal } : undefined);
    this.requireLease(endpointId, lease);
    const parsed = pageSchema.safeParse(response);
    if (!parsed.success) throw new AppError("ENDPOINT_UNAVAILABLE", `SSH Codex history helper returned invalid data: ${endpointId}`);
    return {
      messages: parsed.data.messages.map((message) => ({
        id: message.id, turnId: message.turnId, body: message.body, completedAt: message.completedAt,
        terminalStatus: message.terminalStatus, turnOrder: message.turnOrder, itemOrder: message.itemOrder,
        ...(message.role ? { role: message.role } : {}),
        ...(message.clientId ? { clientId: message.clientId } : {}),
        ...(message.phase ? { phase: message.phase } : {}),
      })),
      hasOlder: parsed.data.hasOlder,
      ...(parsed.data.nextCursor ? { nextCursor: parsed.data.nextCursor } : {}),
      openTurnIds: parsed.data.openTurnIds,
      terminalTurnIds: parsed.data.terminalTurnIds,
    };
  }

  private requireLease(endpointId: string, lease?: EndpointWorkLease): void {
    if (lease && this.options.validateLease && !this.options.validateLease(endpointId, lease)) {
      throw new AppError("ENDPOINT_UNAVAILABLE", `endpoint work lease changed: ${endpointId}`);
    }
  }
}
