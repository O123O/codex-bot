import { AppError } from "../core/errors.ts";
import type { AttachmentStore, FileHandleId } from "../attachments/store.ts";
import type { DeliveryStore } from "../storage/delivery-store.ts";
import { TelegramApiError } from "./api.ts";

interface DeliveryApi {
  sendMessage(chatId: string | number, body: string, replyTo?: number): Promise<{ message_id: number }>;
  sendDocument?(chatId: string | number, file: { stream: AsyncIterable<Uint8Array | string>; size: number; displayName: string; mediaType: string; caption?: string; replyTo?: number }): Promise<{ message_id: number }>;
}

export class DeliveryWorker {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly store: DeliveryStore, private readonly api: DeliveryApi, private readonly attachments?: AttachmentStore) {}

  async processOne(id: string): Promise<void> {
    const delivery = this.store.get(id);
    if (!delivery || delivery.state === "confirmed") return;
    if (delivery.state === "uncertain" && !delivery.mandatory) {
      throw new AppError("DELIVERY_UNCERTAIN", `optional delivery ${id} may already have been sent`);
    }
    const body = delivery.state === "uncertain" ? this.recoveryEnvelope(delivery.body, delivery.id) : delivery.body;
    let upload: Awaited<ReturnType<AttachmentStore["openForUpload"]>> | undefined;
    try {
      if (delivery.attachmentId) {
        if (!delivery.attachmentScopeId || !this.attachments || !this.api.sendDocument) throw new AppError("ATTACHMENT_INVALID", "attachment delivery is not configured");
        upload = await this.attachments.openForUpload(delivery.attachmentScopeId, delivery.attachmentId as FileHandleId);
      }
      this.store.markDispatched(id);
      const result = upload
        ? await this.api.sendDocument!(delivery.destination, { stream: upload.stream, size: upload.size, displayName: upload.displayName, mediaType: upload.mediaType, ...(body ? { caption: body } : {}), ...(delivery.replyTo === undefined ? {} : { replyTo: delivery.replyTo }) })
        : await this.api.sendMessage(delivery.destination, body, delivery.replyTo);
      this.store.confirm(id, String(result.message_id));
    } catch (error) {
      if (error instanceof TelegramApiError && error.deterministic) this.store.fail(id);
      else this.store.markUncertain(id);
      if (!delivery.mandatory) {
        this.store.prepare({
          id: `delivery-warning:${id}`,
          kind: "delivery_warning",
          destination: delivery.destination,
          body: `[system] delivery ${id} could not be confirmed and was not automatically retried`,
          mandatory: true,
        });
      }
      throw error;
    } finally {
      await upload?.close();
    }
  }

  async drain(): Promise<void> {
    for (const delivery of this.store.listReady()) {
      try { await this.processOne(delivery.id); }
      catch (error) { if (!(error instanceof AppError && error.code === "DELIVERY_UNCERTAIN")) throw error; }
    }
  }

  start(intervalMs = 250): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drain().catch(() => undefined), intervalMs);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  private recoveryEnvelope(body: string, id: string): string {
    const match = /^\[([^\]]+)\]\s?(.*)$/su.exec(body);
    return match ? `[${match[1]} · recovery retry ${id}] ${match[2]}` : `[recovery retry ${id}] ${body}`;
  }
}
