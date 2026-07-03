import type { ConversationBinding, JsonValue } from "./binding.ts";
import type { Database } from "../storage/database.ts";

export class OwnerRouteStore {
  private readonly fallback: ConversationBinding;

  constructor(private readonly db: Database, primary: ConversationBinding) {
    this.fallback = copyBinding(primary);
  }

  current(): ConversationBinding {
    const row = this.db.prepare("SELECT adapter_id, conversation_key, destination_json, reply_json FROM latest_owner_route WHERE singleton = 1")
      .get() as Record<string, unknown> | undefined;
    if (!row) return copyBinding(this.fallback);
    return {
      adapterId: String(row.adapter_id),
      conversationKey: String(row.conversation_key),
      destination: JSON.parse(String(row.destination_json)) as JsonValue,
      ...(row.reply_json ? { reply: JSON.parse(String(row.reply_json)) as JsonValue } : {}),
    };
  }
}

function copyBinding(binding: ConversationBinding): ConversationBinding {
  return {
    adapterId: binding.adapterId,
    conversationKey: binding.conversationKey,
    destination: structuredClone(binding.destination),
    ...(binding.reply === undefined ? {} : { reply: structuredClone(binding.reply) }),
  };
}
