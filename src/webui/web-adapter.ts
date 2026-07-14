import type { ChatAdapter } from "../chat-apps/shared/contracts.ts";
import type { ConversationBinding } from "../chat-apps/shared/binding.ts";
import type { JsonValue } from "../chat-apps/shared/binding.ts";
import type { WebBus } from "./web-bus.ts";

export const WEB_ADAPTER_ID = "web";
// A stable single-owner conversation for the browser surface. Web input is routed through this
// binding so the assistant treats the browser as one conversation (co-tenant of the owner route).
export const WEB_BINDING: ConversationBinding = {
  adapterId: WEB_ADAPTER_ID,
  conversationKey: "web:owner",
  destination: { surface: "web" },
};

// The `web` ChatAdapter. Inbound (browser → assistant) is driven by the HTTP server calling
// `acceptChat` with a WEB_BINDING source (not this object). Outbound (assistant reply → browser)
// arrives here via the DeliveryWorker → `sendMessage`, which we fan out to connected sockets.
export function createWebAdapter(bus: WebBus): ChatAdapter {
  return {
    primaryBinding: WEB_BINDING,
    delivery: {
      id: WEB_ADAPTER_ID,
      sendMessage: async (_destination: JsonValue, body: string): Promise<JsonValue> => {
        bus.broadcast({ type: "message", body, at: Date.now() });
        return { delivered: true };
      },
      isSafeToRetry: () => true,
    },
    async initialize() {},
    start() {},
    async stop() {},
    async close() {},
  };
}
