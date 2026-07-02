import type { JsonValue } from "./binding.ts";

export interface ChatDeliveryAdapter {
  readonly id: string;
  sendMessage(destination: JsonValue, body: string, reply?: JsonValue): Promise<JsonValue>;
  sendDocument?(destination: JsonValue, file: {
    stream: AsyncIterable<Uint8Array | string>;
    size: number;
    displayName: string;
    mediaType: string;
    caption?: string;
    reply?: JsonValue;
  }): Promise<JsonValue>;
}

export interface ChatAdapter {
  readonly delivery: ChatDeliveryAdapter;
  start(): void;
  stop(): Promise<void>;
  close(): Promise<void>;
}
