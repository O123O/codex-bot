import type { ServerRequest as GeneratedServerRequest } from "./generated/ServerRequest.ts";
import type { ServerNotification as GeneratedServerNotification } from "./generated/ServerNotification.ts";

export const GENERATED_CODEX_PROTOCOL_VERSION = "0.144.4";
// Connection recovery uses the experimental `thread/resume.excludeTurns` and bounded
// `thread/turns/list` APIs introduced in Codex 0.144.4.
export const MINIMUM_SUPPORTED_CODEX_VERSION = "0.144.4";

export type ServerRequest = GeneratedServerRequest;
export type ServerNotification = GeneratedServerNotification;

export interface RpcRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
