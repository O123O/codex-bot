import type { DeliveryStore } from "../storage/delivery-store.ts";

export function recordCoordinatorAuthenticationFailure(
  deliveries: DeliveryStore,
  destination: string,
  incident: number,
): void {
  deliveries.prepare({
    id: `coordinator-auth-required:${incident}`,
    kind: "system_warning",
    destination,
    body: "[system] coordinator Codex authentication is unavailable; run codex-bot coordinator-login with the configured DATA_DIR",
    mandatory: true,
  });
}
