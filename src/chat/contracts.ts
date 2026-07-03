import type { JsonValue } from "./binding.ts";

export interface ChatDeliveryAdapter {
  readonly id: string;
  sendMessage(destination: JsonValue, body: string, reply?: JsonValue, options?: { deliveryId: string }): Promise<JsonValue>;
  sendDocument?(destination: JsonValue, file: {
    stream: AsyncIterable<Uint8Array | string>;
    size: number;
    displayName: string;
    mediaType: string;
    deliveryId: string;
    caption?: string;
    reply?: JsonValue;
  }): Promise<JsonValue>;
  isSafeToRetry?(error: unknown): boolean;
}

export interface ChatAdapter {
  readonly delivery: ChatDeliveryAdapter;
  start(): void;
  stop(): Promise<void>;
  close(): Promise<void>;
}
