const clientMarkerPattern = /<!--\s*qiyan-cid:([A-Za-z0-9:_.-]{1,256})\s*-->/u;

// Claude does not expose Codex-style item ids. QiYan includes its client id in the
// submitted prompt so the native transcript reader can correlate the echoed user row.
export function encodeClaudeClientMarker(clientId: string): string {
  return `<!-- qiyan-cid:${clientId} -->`;
}

export function extractClaudeClientMarker(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const content = (message as Record<string, unknown>).content;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string") {
        text += `${(block as Record<string, unknown>).text as string}\n`;
      }
    }
  }
  return clientMarkerPattern.exec(text)?.[1];
}
