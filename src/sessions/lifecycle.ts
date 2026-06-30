import { realpath } from "node:fs/promises";
import type { AppServerPool } from "../app-server/pool.ts";
import type { Clock } from "../core/clock.ts";
import { AppError } from "../core/errors.ts";
import type { SessionRegistry } from "../registry/session-registry.ts";
import type { RuntimeStore } from "../storage/runtime-store.ts";

interface ThreadView { id: string; cwd: string; status: { type: string }; turns: Array<{ id: string }> }
interface ThreadResponse { thread: ThreadView; cwd?: string }

export class SessionLifecycle {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly pool: AppServerPool,
    private readonly registry: SessionRegistry,
    private readonly runtime: RuntimeStore,
    private readonly clock: Clock,
  ) {}

  async create(nickname: string, endpointId: string, projectDir: string): Promise<void> {
    await this.lock(`${endpointId}:new:${nickname}`, async () => {
      const canonical = await realpath(projectDir);
      const response = await this.pool.request<ThreadResponse>(endpointId, "thread/start", {
        cwd: canonical, approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: false,
      });
      await this.verifyCwd(response.thread.cwd, canonical);
      this.requireIdle(response.thread);
      await this.registry.register(nickname, { endpoint: endpointId, thread_id: response.thread.id, project_dir: canonical });
      this.runtime.setSession(endpointId, response.thread.id, "managed", response.thread.status.type);
      this.runtime.beginEpoch(endpointId, response.thread.id, this.baseline(response.thread), this.clock.now());
    });
  }

  register(nickname: string, endpointId: string, threadId: string, projectDir: string): Promise<void> {
    return this.adopt(nickname, endpointId, threadId, projectDir);
  }

  async adopt(nickname: string, endpointId: string, threadId: string, projectDir: string): Promise<void> {
    await this.lock(`${endpointId}:${threadId}`, async () => {
      const canonical = await realpath(projectDir);
      const response = await this.read(endpointId, threadId);
      await this.verifyCwd(response.thread.cwd, canonical);
      this.requireIdle(response.thread);
      await this.registry.register(nickname, { endpoint: endpointId, thread_id: threadId, project_dir: canonical });
      this.runtime.setSession(endpointId, threadId, "managed", response.thread.status.type);
      this.runtime.beginEpoch(endpointId, threadId, this.baseline(response.thread), this.clock.now());
    });
  }

  async detach(nickname: string): Promise<void> {
    const session = this.required(nickname);
    await this.lock(`${session.endpoint}:${session.thread_id}`, async () => {
      const response = await this.read(session.endpoint, session.thread_id);
      this.requireIdle(response.thread);
      this.runtime.setSession(session.endpoint, session.thread_id, "detaching", "idle");
      await this.pool.request(session.endpoint, "thread/unsubscribe", { threadId: session.thread_id });
      this.runtime.endEpoch(session.endpoint, session.thread_id, this.clock.now());
      this.runtime.setSession(session.endpoint, session.thread_id, "detached", "notLoaded");
    });
  }

  async attach(nickname: string): Promise<void> {
    const session = this.required(nickname);
    await this.lock(`${session.endpoint}:${session.thread_id}`, async () => {
      const before = await this.read(session.endpoint, session.thread_id);
      this.requireIdle(before.thread);
      this.runtime.setSession(session.endpoint, session.thread_id, "attaching", "idle");
      try {
        const resumed = await this.pool.request<ThreadResponse>(session.endpoint, "thread/resume", {
          threadId: session.thread_id, cwd: session.project_dir, approvalPolicy: "never", sandbox: "danger-full-access",
        });
        await this.verifyCwd(resumed.thread.cwd, session.project_dir);
        const after = await this.read(session.endpoint, session.thread_id);
        this.requireIdle(after.thread);
        this.runtime.beginEpoch(session.endpoint, session.thread_id, this.baseline(after.thread), this.clock.now());
        this.runtime.setSession(session.endpoint, session.thread_id, "managed", "idle");
      } catch (error) {
        this.runtime.setSession(session.endpoint, session.thread_id, "detached", before.thread.status.type);
        throw error;
      }
    });
  }

  async archive(nickname: string): Promise<void> {
    const session = this.required(nickname);
    await this.lock(`${session.endpoint}:${session.thread_id}`, async () => {
      const response = await this.read(session.endpoint, session.thread_id);
      this.requireIdle(response.thread);
      await this.pool.request(session.endpoint, "thread/archive", { threadId: session.thread_id });
      this.runtime.endEpoch(session.endpoint, session.thread_id, this.clock.now());
      this.runtime.setSession(session.endpoint, session.thread_id, "archived", "notLoaded");
    });
  }

  async reconcileStartup(): Promise<void> {
    for (const entry of this.runtime.listSessions()) {
      if (entry.managementState === "detaching") {
        await this.pool.request(entry.endpointId, "thread/unsubscribe", { threadId: entry.threadId });
        this.runtime.endEpoch(entry.endpointId, entry.threadId, this.clock.now());
        this.runtime.setSession(entry.endpointId, entry.threadId, "detached", "notLoaded");
      } else if (entry.managementState === "attaching") {
        const nickname = this.nicknameFor(entry.endpointId, entry.threadId);
        this.runtime.setSession(entry.endpointId, entry.threadId, "detached", entry.nativeStatus);
        if (nickname) await this.attach(nickname);
      } else if (entry.managementState === "unavailable") {
        try {
          const response = await this.read(entry.endpointId, entry.threadId);
          this.runtime.setSession(entry.endpointId, entry.threadId, "managed", response.thread.status.type);
        } catch { /* remains unavailable */ }
      }
    }
  }

  private required(nickname: string) {
    const session = this.registry.get(nickname);
    if (!session) throw new AppError("UNKNOWN_SESSION", `unknown session: ${nickname}`);
    return session;
  }

  private nicknameFor(endpointId: string, threadId: string): string | undefined {
    return Object.entries(this.registry.snapshot().sessions).find(([, value]) => value.endpoint === endpointId && value.thread_id === threadId)?.[0];
  }

  private read(endpointId: string, threadId: string): Promise<ThreadResponse> {
    return this.pool.request(endpointId, "thread/read", { threadId, includeTurns: true });
  }

  private requireIdle(thread: ThreadView): void {
    if (thread.status.type !== "idle") throw new AppError("SESSION_BUSY", `thread ${thread.id} is ${thread.status.type}`);
  }

  private async verifyCwd(actual: string, expected: string): Promise<void> {
    let canonicalActual: string;
    try { canonicalActual = await realpath(actual); } catch { throw new AppError("CWD_MISMATCH", `thread cwd does not exist: ${actual}`); }
    if (canonicalActual !== expected) throw new AppError("CWD_MISMATCH", `thread cwd ${canonicalActual} does not match ${expected}`);
  }

  private baseline(thread: ThreadView): string | undefined { return thread.turns.at(-1)?.id; }

  private async lock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, current);
    await previous;
    try { return await action(); } finally { release(); if (this.tails.get(key) === current) this.tails.delete(key); }
  }
}
