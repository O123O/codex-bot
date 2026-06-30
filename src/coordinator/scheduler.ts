export interface UserJob { id: string; payload: unknown }
export interface EventJob { id: string; sessionKey: string; payload: unknown }
export type CoordinatorJob = UserJob | { id: string; events: EventJob[]; payload: unknown };

export class CoordinatorScheduler {
  private readonly users: UserJob[] = [];
  private readonly events: EventJob[] = [];
  private running = false;
  private consecutiveUsers = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly execute: (job: CoordinatorJob) => Promise<void>,
    private readonly options: { maxBatchEvents?: number; maxBatchBytes?: number } = {},
  ) {}

  enqueueUser(job: UserJob): void { this.users.push(job); this.kick(); }

  enqueueEvent(job: EventJob): void {
    const transient = typeof job.payload === "object" && job.payload !== null && "status" in job.payload && !("final" in job.payload);
    if (transient) {
      const index = this.events.findIndex((item) => item.sessionKey === job.sessionKey && typeof item.payload === "object" && item.payload !== null && "status" in item.payload && !("final" in item.payload));
      if (index >= 0) this.events.splice(index, 1);
    }
    this.events.push(job); this.kick();
  }

  async idle(): Promise<void> {
    if (!this.running && this.users.length === 0 && this.events.length === 0) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private kick(): void {
    if (this.running) return;
    this.running = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      while (this.users.length > 0 || this.events.length > 0) {
        if (this.users.length > 0 && (this.events.length === 0 || this.consecutiveUsers < 5)) {
          const job = this.users.shift()!;
          this.consecutiveUsers += 1;
          await this.execute(job);
        } else {
          const events = this.takeEventBatch();
          this.consecutiveUsers = 0;
          await this.execute({ id: `batch:${events.map((item) => item.id).join(",")}`, events, payload: events.map((item) => item.payload) });
        }
      }
    } finally {
      this.running = false;
      for (const resolve of this.waiters.splice(0)) resolve();
      if (this.users.length > 0 || this.events.length > 0) this.kick();
    }
  }

  private takeEventBatch(): EventJob[] {
    const maxEvents = this.options.maxBatchEvents ?? 20;
    const maxBytes = this.options.maxBatchBytes ?? 8 * 1024;
    const batch: EventJob[] = [];
    let bytes = 0;
    while (this.events.length > 0 && batch.length < maxEvents) {
      const next = this.events[0]!;
      const size = Buffer.byteLength(JSON.stringify(next.payload));
      if (batch.length > 0 && bytes + size > maxBytes) break;
      batch.push(this.events.shift()!); bytes += size;
    }
    return batch;
  }
}

