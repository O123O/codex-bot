import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { RpcWire } from "./rpc-client.ts";

export class JsonlWire implements RpcWire {
  private readonly messages = new Set<(message: string) => void>();
  private readonly closes = new Set<(error?: Error) => void>();
  private closed = false;

  constructor(input: Readable, private readonly output: Writable) {
    const lines = createInterface({ input });
    lines.on("line", (line) => { for (const listener of this.messages) listener(line); });
    lines.on("error", (error) => this.emitClose(error));
    input.on("error", (error) => this.emitClose(error));
    input.on("end", () => this.emitClose(new Error("app-server stream ended")));
    input.on("close", () => this.emitClose(new Error("app-server stream closed")));
  }

  send(message: string): void { this.output.write(`${message}\n`); }
  close(): void { this.emitClose(); }
  onMessage(listener: (message: string) => void): () => void { this.messages.add(listener); return () => this.messages.delete(listener); }
  onClose(listener: (error?: Error) => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }

  private emitClose(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closes) listener(error);
  }
}
