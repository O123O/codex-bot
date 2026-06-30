import { AppError } from "../core/errors.ts";

export interface AppServerEndpoint {
  readonly id: string;
  readonly state: "starting" | "ready" | "unavailable" | "stopped";
  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
}

interface TurnStartResponse { turn: { id: string } }

export class AppServerPool {
  private readonly endpoints = new Map<string, AppServerEndpoint>();
  private readonly active = new Set<string>();

  constructor(endpoints: readonly AppServerEndpoint[], private readonly options: { maxConcurrentTurns: number }) {
    for (const endpoint of endpoints) this.endpoints.set(endpoint.id, endpoint);
  }

  endpoint(id: string): AppServerEndpoint {
    const endpoint = this.endpoints.get(id);
    if (!endpoint || endpoint.state !== "ready") throw new AppError("ENDPOINT_UNAVAILABLE", `app-server endpoint is unavailable: ${id}`);
    return endpoint;
  }

  request<T>(endpointId: string, method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    return this.endpoint(endpointId).request<T>(method, params, signal);
  }

  async startTurn<T extends TurnStartResponse = TurnStartResponse>(endpointId: string, params: { threadId: string; [key: string]: unknown }): Promise<T> {
    if (this.active.size >= this.options.maxConcurrentTurns) {
      throw new AppError("CAPACITY_EXCEEDED", `at most ${this.options.maxConcurrentTurns} turns may run concurrently`);
    }
    const reservation = `${endpointId}:${params.threadId}:pending:${crypto.randomUUID()}`;
    this.active.add(reservation);
    try {
      const response = await this.request<T>(endpointId, "turn/start", params);
      this.active.delete(reservation);
      this.active.add(this.turnKey(endpointId, params.threadId, response.turn.id));
      return response;
    } catch (error) {
      this.active.delete(reservation);
      throw error;
    }
  }

  async interrupt(endpointId: string, threadId: string, turnId: string): Promise<void> {
    try {
      await this.request(endpointId, "turn/interrupt", { threadId, turnId });
    } finally {
      this.markTurnTerminal(endpointId, threadId, turnId);
    }
  }

  markTurnTerminal(endpointId: string, threadId: string, turnId: string): void {
    this.active.delete(this.turnKey(endpointId, threadId, turnId));
  }

  markEndpointUnavailable(endpointId: string): void {
    for (const key of this.active) if (key.startsWith(`${endpointId}:`)) this.active.delete(key);
  }

  get activeTurnCount(): number { return this.active.size; }

  private turnKey(endpointId: string, threadId: string, turnId: string): string {
    return `${endpointId}:${threadId}:${turnId}`;
  }
}

