import type { ConversationStore } from "../storage/conversation-store.ts";

export function recordAssistantSystemAwareness(
  conversations: Pick<ConversationStore, "createInternalSource">,
  operationId: string,
  body: string,
  receivedAt = Date.now(),
): string {
  return conversations.createInternalSource({
    id: `assistant-system:${operationId}`,
    kind: "system_notice",
    sourceId: operationId,
    rawText: `[system] ${body}`,
    attachmentIds: [],
    receivedAt,
  });
}
