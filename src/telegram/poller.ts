import type { AttachmentStore } from "../attachments/store.ts";
import type { CanonicalChatSource } from "../core/types.ts";
import type { Database } from "../storage/database.ts";
import { classifyUpdate, toTelegramCanonicalSource } from "./adapter.ts";
import type { TelegramUpdate } from "./types.ts";

interface PollApi {
  getUpdates(offset: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  downloadFile(fileId: string): Promise<{ stream: AsyncIterable<Uint8Array | string>; size?: number }>;
}

export class TelegramPoller {
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly db: Database,
    private readonly api: PollApi,
    private readonly attachments: AttachmentStore,
    private readonly options: { ownerId: number; onMessage(source: CanonicalChatSource, commitNativeCheckpoint: () => void): Promise<void>; maxMessageBytes?: number },
  ) {}

  async pollOnce(signal?: AbortSignal): Promise<number> {
    let offset = this.offset();
    const updates = await this.api.getUpdates(offset, signal);
    for (const update of updates.sort((a, b) => a.update_id - b.update_id)) {
      if (update.update_id < offset) continue;
      const classified = classifyUpdate(update, this.options.ownerId);
      if (classified.kind === "ignored") {
        this.advance(update.update_id + 1);
        offset = update.update_id + 1;
        continue;
      }
      const contextId = classified.message.id;
      const parts = [];
      for (const pending of classified.pendingFiles) {
        const download = await this.api.downloadFile(pending.fileId);
        parts.push({ stream: download.stream, displayName: pending.fileName, mediaType: pending.mediaType, ...(pending.declaredSize === undefined ? {} : { declaredSize: pending.declaredSize }) });
      }
      const saved = await this.attachments.ingestMany(contextId, parts, this.options.maxMessageBytes ?? Number.MAX_SAFE_INTEGER);
      await this.options.onMessage(
        toTelegramCanonicalSource(classified.message, saved.map((item) => item.id)),
        () => this.advance(update.update_id + 1),
      );
      offset = update.update_id + 1;
    }
    return offset;
  }

  start(): void {
    if (this.running) return;
    this.controller = new AbortController();
    this.running = this.loop(this.controller.signal).finally(() => { this.running = undefined; });
  }

  async stop(): Promise<void> {
    this.controller?.abort(new Error("Telegram poller stopped"));
    await this.running?.catch(() => undefined);
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try { await this.pollOnce(signal); }
      catch (error) { if (signal.aborted) return; await new Promise((resolve) => setTimeout(resolve, 1_000)); }
    }
  }

  private offset(): number {
    return Number((this.db.prepare("SELECT next_update_id FROM telegram_state WHERE singleton = 1").get() as { next_update_id: number }).next_update_id);
  }

  private advance(offset: number): void {
    this.db.prepare("UPDATE telegram_state SET next_update_id = MAX(next_update_id, ?) WHERE singleton = 1").run(offset);
  }
}
