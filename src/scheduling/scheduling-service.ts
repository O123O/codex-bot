// Scheduling service (Phase 2 wiring) — ties the durable store, the idempotent send
// outbox, the trigger engine, and the worker-facing MCP server together, and manages
// per-session worker tokens + --mcp-config files. production-app constructs one and
// injects `send` (→ send_to_session) and `runCheck` (→ shell on the session's host).
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "../storage/database.ts";
import { ScheduleStore, type ScheduleRow } from "./schedule-store.ts";
import { ScheduledSendOutbox } from "./send-outbox.ts";
import { TriggerEngine } from "./trigger-engine.ts";
import { WorkerScheduleMcpServer, type WorkerScheduleSession } from "./worker-mcp.ts";

export interface SchedulingServiceDeps {
  db: Database;
  // Drive a turn on the target session (production-app wires this to the durable
  // send_to_session, passing singleFireKey as the clientUserMessageId).
  send(nickname: string, message: string, singleFireKey: string): Promise<void>;
  // Run a monitor's shell predicate on the session's endpoint; true iff exit 0.
  runCheck(row: ScheduleRow): Promise<boolean>;
  now(): number;
  // Directory for per-session worker --mcp-config files (0700).
  mcpConfigDir: string;
  pollIntervalMs?: number;
}

export class SchedulingService {
  readonly store: ScheduleStore;
  private readonly outbox: ScheduledSendOutbox;
  private readonly server: WorkerScheduleMcpServer;
  private readonly engine: TriggerEngine;
  private readonly tokenBySession = new Map<string, string>();   // `${endpointId}\0${threadId}` -> token
  private readonly sessionByToken = new Map<string, WorkerScheduleSession>();

  constructor(private readonly deps: SchedulingServiceDeps) {
    this.store = new ScheduleStore(deps.db);
    this.outbox = new ScheduledSendOutbox(deps.db);
    this.server = new WorkerScheduleMcpServer({ store: this.store, now: deps.now, resolveToken: (token) => this.sessionByToken.get(token) });
    this.engine = new TriggerEngine({
      store: this.store,
      now: deps.now,
      fire: (row, key) => this.fire(row, key),
      runCheck: deps.runCheck,
      ...(deps.pollIntervalMs === undefined ? {} : { pollIntervalMs: deps.pollIntervalMs }),
    });
  }

  async start(): Promise<void> {
    await mkdir(this.deps.mcpConfigDir, { recursive: true, mode: 0o700 });
    await this.server.start();
    // Recovery (2.5): the store is durable, so starting just resumes polling; armed
    // rows (including any missed while down) fire on the first tick.
    this.engine.start();
  }

  async stop(): Promise<void> {
    this.engine.stop();
    await this.server.stop();
  }

  // Idempotent fire: claim in the outbox (unique-constraint insert — at most once
  // across instances), then send; release on failure so the engine re-fires.
  private async fire(row: ScheduleRow, singleFireKey: string): Promise<void> {
    if (this.outbox.claim(singleFireKey, row.nickname, row.message, this.deps.now()) !== "claimed") return;
    try {
      await this.deps.send(row.nickname, row.message, singleFireKey);
      this.outbox.markSent(singleFireKey);
    } catch (error) {
      this.outbox.release(singleFireKey);
      throw error;
    }
  }

  // Claude steer: enqueue the message as an immediate one-shot so the engine delivers
  // it as the next turn (retrying while the session is busy). Durable + recovers.
  enqueueSteer(session: WorkerScheduleSession, message: string): void {
    this.store.create({ nickname: session.nickname, endpointId: session.endpointId, threadId: session.threadId, kind: "wakeup", spec: "steer", message, nextFireAt: this.deps.now() }, this.deps.now());
  }

  // Register a worker session so it can reach the scheduling tools; returns the stable
  // per-session --mcp-config path (byte-identical across the session's turns, so it
  // doesn't break the prompt cache). Idempotent per session.
  async workerMcpConfigPath(session: WorkerScheduleSession): Promise<string> {
    const sessionKey = `${session.endpointId}\0${session.threadId}`;
    let token = this.tokenBySession.get(sessionKey);
    if (!token) {
      token = randomUUID();
      this.tokenBySession.set(sessionKey, token);
      this.sessionByToken.set(token, session);
    }
    const path = join(this.deps.mcpConfigDir, `${session.threadId}.json`);
    await writeFile(path, JSON.stringify({
      mcpServers: { "qiyan-worker-scheduling": { type: "http", url: this.server.url, headers: { Authorization: `Bearer ${token}` } } },
    }), { mode: 0o600 });
    return path;
  }
}
