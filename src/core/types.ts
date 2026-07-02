import type { ConversationBinding } from "../chat/binding.ts";

export type SessionKey = `${string}:${string}`;
export type ManagementState =
  | "adopting"
  | "managed"
  | "unadopting"
  | "archiving"
  | "unavailable";
export type OperationState = "prepared" | "dispatched" | "succeeded" | "failed" | "uncertain";
export type DeliveryState = "prepared" | "dispatched" | "confirmed" | "failed" | "uncertain";

export interface SourceContext {
  id: string;
  kind: "telegram" | "event_batch" | "recovery";
  sourceId: string;
  rawText: string;
  attachmentIds: readonly string[];
  binding?: ConversationBinding;
  arrivalSequence?: number;
  queueNoticeRequired?: boolean;
}

export interface CanonicalChatSource {
  id: string;
  nativeSourceId: string;
  binding: ConversationBinding;
  rawText: string;
  attachmentIds: readonly string[];
  receivedAt: number;
}

export interface CanonicalAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
}

export interface CanonicalMessage {
  id: string;
  updateId: number;
  userId: number;
  chatId: number;
  rawText: string;
  attachments: readonly CanonicalAttachment[];
  receivedAt: number;
}
