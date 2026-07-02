import { AppError } from "../core/errors.ts";
import type { ChatDeliveryAdapter } from "./contracts.ts";

export class ChatAdapterRegistry {
  private readonly adapters = new Map<string, ChatDeliveryAdapter>();

  constructor(adapters: readonly ChatDeliveryAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.id)) throw new AppError("CONFIGURATION_ERROR", `duplicate chat adapter: ${adapter.id}`);
      this.adapters.set(adapter.id, adapter);
    }
  }

  delivery(id: string): ChatDeliveryAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new AppError("CONFIGURATION_ERROR", `unknown chat adapter: ${id}`);
    return adapter;
  }
}
