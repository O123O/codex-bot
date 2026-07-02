import type { DeliveryStore } from "../storage/delivery-store.ts";

export function recordAssistantAuthenticationFailure(
  deliveries: DeliveryStore,
  destination: string,
  incident: number,
): void {
  deliveries.prepare({
    id: `assistant-auth-required:${incident}`,
    kind: "system_warning",
    destination,
    body: "[system] assistant Codex authentication is unavailable; run qiyan-bot assistant-login with the configured DATA_DIR",
    mandatory: true,
  });
}
