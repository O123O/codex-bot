import type { Readable, Writable } from "node:stream";
import { JsonlWire } from "./jsonl-wire.ts";
import { RpcClient } from "./rpc-client.ts";

export { JsonRpcResponseError } from "./rpc-client.ts";

export class JsonRpcClient extends RpcClient {
  constructor(input: Readable, output: Writable, options: { requestTimeoutMs: number }) {
    super(new JsonlWire(input, output), options);
  }
}
