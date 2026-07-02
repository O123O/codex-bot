export interface UserJob { id: string; payload: unknown }
export interface EventJob { id: string; sessionKey: string; payload: unknown; queuedAt?: number }
export type AssistantJob = UserJob | { id: string; events: EventJob[]; payload: unknown };

interface QueuedEvent { job: EventJob; queuedAt: number }

export interface EligibleEventBatch {
  batchId: string;
  eventIds: string[];
  payload: unknown;
  queuedAt: number;
  forced: boolean;
}

export class AssistantScheduler {
  private readonly users: UserJob[] = [];
  private readonly events: QueuedEvent[] = [];
  private readonly eventIds = new Set<string>();
  private running = false;
  private consecutiveUsers = 0;
  private readonly waiters: Array<() => void> = [];
  private eventTimer: ReturnType<typeof setTimeout> | undefined;
  private completedConversationPeriods = 0;
  private readonly execute: ((job: AssistantJob) => Promise<void>) | undefined;
  private readonly options: {
    maxBatchEvents?: number;
    maxBatchBytes?: number;
    batchWindowMs?: number;
    maxEventAgeMs?: number;
    now?: () => number;
    setTimeout?: typeof setTimeout;
    clearTimeout?: typeof clearTimeout;
    onError?: (job: AssistantJob, error: unknown) => Promise<void> | void;
  };

  constructor(options?: {
    maxBatchEvents?: number;
    maxBatchBytes?: number;
    batchWindowMs?: number;
    maxEventAgeMs?: number;
    now?: () => number;
    setTimeout?: typeof setTimeout;
    clearTimeout?: typeof clearTimeout;
  });
  constructor(execute: (job: AssistantJob) => Promise<void>, options?: {
      maxBatchEvents?: number;
      maxBatchBytes?: number;
      batchWindowMs?: number;
      maxEventAgeMs?: number;
      now?: () => number;
      setTimeout?: typeof setTimeout;
      clearTimeout?: typeof clearTimeout;
      onError?: (job: AssistantJob, error: unknown) => Promise<void> | void;
    });
  constructor(
    executeOrOptions: ((job: AssistantJob) => Promise<void>) | {
      maxBatchEvents?: number; maxBatchBytes?: number; batchWindowMs?: number; maxEventAgeMs?: number; now?: () => number;
      setTimeout?: typeof setTimeout; clearTimeout?: typeof clearTimeout;
    } = {},
    options: {
      maxBatchEvents?: number; maxBatchBytes?: number; batchWindowMs?: number; maxEventAgeMs?: number; now?: () => number;
      setTimeout?: typeof setTimeout; clearTimeout?: typeof clearTimeout; onError?: (job: AssistantJob, error: unknown) => Promise<void> | void;
    } = {},
  ) {
    this.execute = typeof executeOrOptions === "function" ? executeOrOptions : undefined;
    this.options = typeof executeOrOptions === "function" ? options : executeOrOptions;
  }

  enqueueUser(job: UserJob): void { this.users.push(job); if (this.execute) this.kick(); }

  enqueueEvent(job: EventJob): void {
    if (this.eventIds.has(job.id)) return;
    const transient = this.isTransient(job);
    if (transient) {
      const index = this.events.findIndex((item) => item.job.sessionKey === job.sessionKey && this.isTransient(item.job));
      if (index >= 0) {
        const queuedAt = this.events[index]!.queuedAt;
        this.eventIds.delete(this.events[index]!.job.id);
        this.events.splice(index, 1, { job, queuedAt });
        this.eventIds.add(job.id);
        if (this.execute) this.scheduleEventWindow();
        return;
      }
    }
    this.events.push({ job, queuedAt: job.queuedAt ?? this.now() });
    this.eventIds.add(job.id);
    if (this.execute) {
      this.scheduleEventWindow();
      if (this.users.length > 0 || this.consecutiveUsers >= 5) this.kick();
    }
  }

  noteConversationPeriodCompleted(): void { this.completedConversationPeriods += 1; }

  peekEligibleEventBatch(now = this.now()): EligibleEventBatch | undefined {
    if (this.events.length === 0) return undefined;
    const age = now - this.events[0]!.queuedAt;
    const forced = this.completedConversationPeriods >= 5 || age >= (this.options.maxEventAgeMs ?? 30_000);
    if (!forced && age < (this.options.batchWindowMs ?? 1_000)) return undefined;
    const jobs = this.peekEventJobs();
    return {
      batchId: `batch:${jobs.map((job) => job.id).join(",")}`,
      eventIds: jobs.map((job) => job.id),
      payload: jobs.map((job) => job.payload),
      queuedAt: this.events[0]!.queuedAt,
      forced,
    };
  }

  commitEventBatch(batchId: string, eventIds: readonly string[]): void {
    const candidate = this.peekEligibleEventBatch();
    if (!candidate || candidate.batchId !== batchId || candidate.eventIds.length !== eventIds.length
      || candidate.eventIds.some((id, index) => id !== eventIds[index])) throw new Error("event batch candidate changed before commit");
    this.events.splice(0, eventIds.length);
    for (const id of eventIds) this.eventIds.delete(id);
    this.completedConversationPeriods = 0;
  }

  nextWakeAt(): number | undefined {
    const first = this.events[0];
    if (!first) return undefined;
    if (this.completedConversationPeriods >= 5) return this.now();
    return Math.min(first.queuedAt + (this.options.batchWindowMs ?? 1_000), first.queuedAt + (this.options.maxEventAgeMs ?? 30_000));
  }

  async idle(): Promise<void> {
    if (!this.running && this.users.length === 0 && this.events.length === 0) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private kick(): void {
    if (this.running) return;
    this.running = true;
    void this.pump().catch(() => undefined);
  }

  private async pump(): Promise<void> {
    try {
      while (this.users.length > 0 || this.events.length > 0) {
        if (this.shouldServiceEvents()) {
          const events = this.takeEventBatch();
          this.consecutiveUsers = 0;
          await this.executeSafely({ id: `batch:${events.map((item) => item.id).join(",")}`, events, payload: events.map((item) => item.payload) });
          continue;
        }
        if (this.users.length > 0) {
          const job = this.users.shift()!;
          this.consecutiveUsers += 1;
          await this.executeSafely(job);
          continue;
        }
        this.scheduleEventWindow();
        break;
      }
    } finally {
      this.running = false;
      if (this.users.length === 0 && this.events.length === 0) {
        this.cancelEventTimer();
        for (const resolve of this.waiters.splice(0)) resolve();
      } else if (this.users.length > 0 || this.shouldServiceEvents()) {
        this.kick();
      }
    }
  }

  private async executeSafely(job: AssistantJob): Promise<void> {
    if (!this.execute) return;
    try { await this.execute(job); }
    catch (error) {
      try { await this.options.onError?.(job, error); }
      catch { /* scheduler failure reporting must not stop later durable jobs */ }
    }
  }

  private shouldServiceEvents(): boolean {
    if (this.events.length === 0) return false;
    if (this.consecutiveUsers >= 5) return true;
    const age = this.now() - this.events[0]!.queuedAt;
    if (age >= (this.options.maxEventAgeMs ?? 30_000)) return true;
    return this.users.length === 0 && age >= (this.options.batchWindowMs ?? 1_000);
  }

  private scheduleEventWindow(): void {
    if (this.events.length === 0 || this.eventTimer) return;
    const first = this.events[0]!;
    const windowAt = first.queuedAt + (this.options.batchWindowMs ?? 1_000);
    const starvationAt = first.queuedAt + (this.options.maxEventAgeMs ?? 30_000);
    const delay = Math.max(0, Math.min(windowAt, starvationAt) - this.now());
    const schedule = this.options.setTimeout ?? setTimeout;
    this.eventTimer = schedule(() => {
      this.eventTimer = undefined;
      this.kick();
    }, delay);
    this.eventTimer.unref?.();
  }

  private cancelEventTimer(): void {
    if (!this.eventTimer) return;
    (this.options.clearTimeout ?? clearTimeout)(this.eventTimer);
    this.eventTimer = undefined;
  }

  private takeEventBatch(): EventJob[] {
    this.cancelEventTimer();
    const maxEvents = this.options.maxBatchEvents ?? 20;
    const maxBytes = this.options.maxBatchBytes ?? 8 * 1024;
    const batch: EventJob[] = [];
    let bytes = 0;
    while (this.events.length > 0 && batch.length < maxEvents) {
      const next = this.events[0]!.job;
      const size = Buffer.byteLength(JSON.stringify(next.payload));
      if (batch.length > 0 && bytes + size > maxBytes) break;
      const shifted = this.events.shift()!.job;
      this.eventIds.delete(shifted.id);
      batch.push(shifted); bytes += size;
    }
    this.scheduleEventWindow();
    return batch;
  }

  private peekEventJobs(): EventJob[] {
    const maxEvents = this.options.maxBatchEvents ?? 20;
    const maxBytes = this.options.maxBatchBytes ?? 8 * 1024;
    const batch: EventJob[] = [];
    let bytes = 0;
    for (const queued of this.events) {
      if (batch.length >= maxEvents) break;
      const size = Buffer.byteLength(JSON.stringify(queued.job.payload));
      if (batch.length > 0 && bytes + size > maxBytes) break;
      batch.push(queued.job);
      bytes += size;
    }
    return batch;
  }

  private isTransient(job: EventJob): boolean {
    return typeof job.payload === "object" && job.payload !== null && "status" in job.payload && !("final" in job.payload);
  }

  private now(): number { return (this.options.now ?? Date.now)(); }
}
