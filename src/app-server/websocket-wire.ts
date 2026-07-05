import { isAbsolute } from "node:path";
import WebSocket from "ws";
import type { RpcWire } from "./rpc-client.ts";

const MAX_FRAME_BYTES = 1024 * 1024;

export class WebSocketWire implements RpcWire {
  private readonly messages = new Set<(message: string) => void>();
  private readonly closes = new Set<(error?: Error) => void>();
  private closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data, isBinary) => {
      const size = Array.isArray(data) ? data.reduce((total, item) => total + item.byteLength, 0) : data.byteLength;
      if (isBinary || size > MAX_FRAME_BYTES) {
        this.fail(new Error("invalid App Server WebSocket frame"));
        socket.terminate();
        return;
      }
      const value = Array.isArray(data) ? Buffer.concat(data).toString() : data.toString();
      for (const listener of this.messages) listener(value);
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail());
  }

  static async connect(socketPath: string, options: { timeoutMs: number }): Promise<WebSocketWire> {
    if (!isAbsolute(socketPath)) throw new Error("App Server requires an absolute Unix socket path");
    const socket = new WebSocket(`ws+unix://${socketPath}:/`, {
      handshakeTimeout: options.timeoutMs,
      maxPayload: MAX_FRAME_BYTES,
      followRedirects: false,
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { socket.terminate(); reject(new Error("App Server WebSocket handshake timed out")); }, options.timeoutMs);
      const cleanup = () => { clearTimeout(timeout); socket.off("open", opened); socket.off("error", failed); socket.off("unexpected-response", unexpected); };
      const opened = () => { cleanup(); if (socket.protocol) { socket.terminate(); reject(new Error("unexpected App Server WebSocket protocol")); } else resolve(); };
      const failed = () => { cleanup(); reject(new Error("App Server WebSocket handshake failed")); };
      const unexpected = () => { cleanup(); socket.terminate(); reject(new Error("unexpected App Server WebSocket response")); };
      socket.once("open", opened);
      socket.once("error", failed);
      socket.once("unexpected-response", unexpected);
    });
    return new WebSocketWire(socket);
  }

  send(message: string): void { this.socket.send(message); }
  close(): void { if (!this.closed) this.socket.close(); }
  onMessage(listener: (message: string) => void): () => void { this.messages.add(listener); return () => this.messages.delete(listener); }
  onClose(listener: (error?: Error) => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }

  private fail(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closes) listener(error);
  }
}
