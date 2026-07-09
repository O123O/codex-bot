export type AssistantLifecycleMethod = "turn/started" | "turn/completed";

export interface AssistantLifecycleNotification {
  method: AssistantLifecycleMethod;
  params: { threadId: string; turn: { id: string; [key: string]: unknown }; [key: string]: unknown };
}

export function parseAssistantLifecycleNotification(method: string, params: unknown): AssistantLifecycleNotification | undefined {
  if (method !== "turn/started" && method !== "turn/completed") return undefined;
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const value = params as Record<string, unknown>;
  if (typeof value.threadId !== "string" || !value.turn || typeof value.turn !== "object" || Array.isArray(value.turn)) return undefined;
  const turn = value.turn as Record<string, unknown>;
  if (typeof turn.id !== "string") return undefined;
  return { method, params: structuredClone(params) as AssistantLifecycleNotification["params"] };
}

export class AssistantLifecycleBuffer {
  private readonly pending: AssistantLifecycleNotification[] = [];
  private ready = false;

  constructor(private readonly maxPending = 64) {
    if (!Number.isInteger(maxPending) || maxPending < 1) throw new Error("assistant lifecycle buffer limit must be positive");
  }

  async accept(notification: AssistantLifecycleNotification, handle: (notification: AssistantLifecycleNotification) => Promise<void>): Promise<void> {
    if (this.ready) {
      await handle(notification);
      return;
    }
    if (this.pending.length >= this.maxPending) throw new Error("assistant lifecycle notification buffer is full");
    this.pending.push(notification);
  }

  async activate(handle: (notification: AssistantLifecycleNotification) => Promise<void>): Promise<void> {
    while (this.pending.length > 0) await handle(this.pending.shift()!);
    this.ready = true;
  }

  clear(): void {
    this.pending.length = 0;
    this.ready = false;
  }

  get size(): number { return this.pending.length; }
}
