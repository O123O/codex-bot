import type { ConversationBinding } from "../chat-apps/shared/binding.ts";
import type { DeliveryStore } from "../storage/delivery-store.ts";

export function recordCompletedSystemAction(
  deliveries: Pick<DeliveryStore, "prepare">,
  operationId: string,
  notice?: { binding: ConversationBinding; body: string },
): void {
  if (notice) {
    deliveries.prepare({
      id: `tool-system:${operationId}`,
      kind: "system_notice",
      binding: notice.binding,
      body: notice.body,
      mandatory: true,
    });
  }
}
