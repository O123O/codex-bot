import { JsonRpcResponseError } from "./json-rpc-client.ts";

export function isExactThreadNotLoaded(error: unknown, threadId: string): boolean {
  return error instanceof JsonRpcResponseError
    && error.code === -32600
    && error.rpcMessage === `thread not loaded: ${threadId}`;
}
