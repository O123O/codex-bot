import { resolve } from "node:path";
import { z } from "zod";

const positiveInt = z.coerce.number().int().positive();

const configSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_OWNER_ID: z.coerce.number().int(),
  TELEGRAM_DESTINATION_CHAT_ID: z.coerce.number().int(),
  DATA_DIR: z.string().default("data"),
  SESSION_REGISTRY_PATH: z.string().default("data/sessions.json"),
  CODEX_BINARY: z.string().default("codex"),
  MAX_CONCURRENT_TURNS: positiveInt.default(4),
  MAX_COLLECT_COUNT: positiveInt.max(100).default(20),
  MCP_HOST: z.literal("127.0.0.1").default("127.0.0.1"),
  MCP_PORT: z.coerce.number().int().min(0).max(65_535).default(43_721),
  ATTACHMENT_MAX_BYTES: positiveInt.default(20 * 1024 * 1024),
  ATTACHMENT_STORE_MAX_BYTES: positiveInt.default(1024 * 1024 * 1024),
  SANDBOX_MODE: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
}).refine((value) => value.TELEGRAM_DESTINATION_CHAT_ID === value.TELEGRAM_OWNER_ID, {
  path: ["TELEGRAM_DESTINATION_CHAT_ID"],
  message: "must equal TELEGRAM_OWNER_ID for the single-user private-chat MVP",
});

export interface BotConfig {
  telegramBotToken: string;
  telegramOwnerId: number;
  telegramDestinationChatId: number;
  dataDir: string;
  sessionRegistryPath: string;
  codexBinary: string;
  maxConcurrentTurns: number;
  maxCollectCount: number;
  mcpHost: "127.0.0.1";
  mcpPort: number;
  attachmentMaxBytes: number;
  attachmentStoreMaxBytes: number;
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
}

export function loadConfig(env: Record<string, string | undefined>): BotConfig {
  const parsed = configSchema.parse(env);
  return {
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    telegramOwnerId: parsed.TELEGRAM_OWNER_ID,
    telegramDestinationChatId: parsed.TELEGRAM_DESTINATION_CHAT_ID,
    dataDir: resolve(parsed.DATA_DIR),
    sessionRegistryPath: resolve(parsed.SESSION_REGISTRY_PATH),
    codexBinary: parsed.CODEX_BINARY,
    maxConcurrentTurns: parsed.MAX_CONCURRENT_TURNS,
    maxCollectCount: parsed.MAX_COLLECT_COUNT,
    mcpHost: parsed.MCP_HOST,
    mcpPort: parsed.MCP_PORT,
    attachmentMaxBytes: parsed.ATTACHMENT_MAX_BYTES,
    attachmentStoreMaxBytes: parsed.ATTACHMENT_STORE_MAX_BYTES,
    sandboxMode: parsed.SANDBOX_MODE,
  };
}
