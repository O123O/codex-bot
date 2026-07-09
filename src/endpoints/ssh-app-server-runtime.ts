import { randomBytes } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, unlink } from "node:fs/promises";
import type {
  AppServerConnection,
  AppServerConnectionIdentity,
  AppServerInitializeResult,
  AppServerRuntimeService,
} from "../app-server/managed-endpoint.ts";
import type { RpcWire } from "../app-server/rpc-client.ts";
import { AppError } from "../core/errors.ts";
import { localSshForwardSocketPath } from "./local-runtime.ts";
import { buildSshStreamForwardArgs, type SshConnectionPlan } from "./ssh-config.ts";
import type { SshRuntimeController } from "./ssh-runtime.ts";
import type { EndpointLossKind, RuntimeIdentity } from "./types.ts";

type Spawn = typeof nodeSpawn;
interface SocketIdentity { device: string; inode: string }

export class SshAppServerRuntime implements AppServerRuntimeService {
  private active?: SshForwardConnection;
  private opening?: symbol;

  constructor(private readonly options: {
    runtime: SshRuntimeController;
    plan: SshConnectionPlan;
    socketRoot: string;
    connectWire(socketPath: string): Promise<RpcWire>;
    sshBinary?: string;
    spawn?: Spawn;
    socketGeneration?: () => string;
    connectionTimeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
  }) {}

  async open(): Promise<AppServerConnection> {
    if (this.active || this.opening) throw new AppError("OPERATION_CONFLICT", "SSH App Server connection is already open");
    const opening = Symbol("ssh-forward-opening");
    this.opening = opening;
    let child: ChildProcessWithoutNullStreams | undefined;
    let monitor: ForwardProcessMonitor | undefined;
    let socketPath: string | undefined;
    let socketIdentity: SocketIdentity | undefined;
    let wire: RpcWire | undefined;
    let connection: SshForwardConnection | undefined;
    try {
      await attestSocketRoot(this.options.socketRoot);
      const expected = await this.options.runtime.ensureStarted();
      if (expected.kind !== "ssh") throw new AppError("ENDPOINT_UNAVAILABLE", "remote runtime returned a non-SSH identity");
      const generation = this.options.socketGeneration?.() ?? randomBytes(4).toString("hex");
      socketPath = localSshForwardSocketPath(this.options.socketRoot, generation);
      const spawn = this.options.spawn ?? nodeSpawn;
      child = spawn(this.options.sshBinary ?? "ssh", buildSshStreamForwardArgs(
        this.options.plan, socketPath, this.options.runtime.remoteSocketPath,
      ), { stdio: ["pipe", "pipe", "pipe"], shell: false }) as ChildProcessWithoutNullStreams;
      monitor = new ForwardProcessMonitor(child);
      child.stdin.end();
      child.stdout.on("data", () => { /* Drain unexpected SSH output without logging it. */ });
      child.stderr.on("data", () => { /* Drain potentially sensitive SSH diagnostics. */ });
      socketIdentity = await waitForSocket(monitor, socketPath, this.options.connectionTimeoutMs ?? 10_000, this.options.sleep);
      const connecting = this.options.connectWire(socketPath);
      try { wire = await monitor.race(connecting); }
      catch (error) {
        void connecting.then((lateWire) => { try { lateWire.close(); } catch { /* Preserve the opening failure. */ } }, () => undefined);
        throw error;
      }
      connection = new SshForwardConnection(this, child, monitor, wire, socketPath, socketIdentity, expected);
      this.active = connection;
      if (!connection.activate()) throw new AppError("ENDPOINT_UNAVAILABLE", "SSH forward exited during connection");
      return connection;
    } catch (error) {
      if (connection) await connection.close().catch(() => undefined);
      else {
        try { wire?.close(); } catch { /* Preserve the opening failure. */ }
        if (child) await stopForwardChild(child).catch(() => undefined);
        if (socketPath && !socketIdentity) socketIdentity = await ownedSocketIdentity(socketPath).catch(() => undefined);
        if (socketPath) await removeExactSocket(socketPath, socketIdentity).catch(() => undefined);
      }
      throw error;
    } finally {
      if (this.opening === opening) delete this.opening;
    }
  }

  runtimeIdentity(): Promise<RuntimeIdentity | undefined> { return this.options.runtime.runtimeIdentity(); }

  async classifyLoss(): Promise<EndpointLossKind> {
    if (this.options.runtime.classifyLoss) return this.options.runtime.classifyLoss();
    return await this.options.runtime.runtimeIdentity() === undefined ? "runtime-lost" : "connection-lost";
  }

  async shutdownRuntime(expected: RuntimeIdentity): Promise<void> {
    let cleanupError: unknown;
    try { await this.active?.close(); } catch (error) { cleanupError = error; }
    await this.options.runtime.stop(expected);
    if (cleanupError !== undefined) throw cleanupError;
  }

  async confirm(connection: SshForwardConnection, expected: RuntimeIdentity): Promise<AppServerConnectionIdentity> {
    if (this.active !== connection || connection.lost) throw new AppError("ENDPOINT_UNAVAILABLE", "SSH App Server connection changed during initialization");
    const actual = await this.options.runtime.runtimeIdentity();
    if (this.active !== connection || connection.lost || !sameSshIdentity(expected, actual)) {
      throw new AppError("ENDPOINT_UNAVAILABLE", "SSH runtime identity changed during connection");
    }
    return { runtime: expected };
  }

  release(connection: SshForwardConnection): void {
    if (this.active === connection) delete this.active;
  }
}

class SshForwardConnection implements AppServerConnection {
  private readonly closes = new Set<(error?: Error) => void>();
  private readonly removeWireClose: () => void;
  private removeProcessFailure?: () => void;
  private intentional = false;
  private disposed = false;
  lost = false;

  constructor(
    private readonly runtime: SshAppServerRuntime,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly monitor: ForwardProcessMonitor,
    readonly wire: RpcWire,
    private readonly socketPath: string,
    private readonly socketIdentity: SocketIdentity,
    private readonly expected: RuntimeIdentity,
  ) {
    this.removeWireClose = wire.onClose((error) => this.fail(error ?? new Error("SSH App Server wire closed")));
  }

  activate(): boolean {
    this.removeProcessFailure = this.monitor.onFailure((error) => this.fail(error));
    return !this.lost;
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }

  confirmInitialized(_result: AppServerInitializeResult): Promise<AppServerConnectionIdentity> {
    return this.runtime.confirm(this, this.expected);
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.intentional = true;
    this.runtime.release(this);
    this.removeProcessFailure?.();
    this.removeWireClose();
    let firstError: unknown;
    try { this.wire.close(); } catch (error) { firstError = error; }
    try { await stopForwardChild(this.child); } catch (error) { firstError ??= error; }
    try { await removeExactSocket(this.socketPath, this.socketIdentity); } catch (error) { firstError ??= error; }
    if (firstError !== undefined) throw firstError;
  }

  private fail(error: Error): void {
    if (this.intentional || this.lost) return;
    this.lost = true;
    this.runtime.release(this);
    for (const listener of this.closes) listener(error);
  }
}

class ForwardProcessMonitor {
  private readonly listeners = new Set<(error: Error) => void>();
  private failure?: Error;

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.once("error", (error) => this.fail(error));
    child.once("exit", () => this.fail(new Error("SSH forward exited")));
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.listeners.add(listener);
    if (this.failure) listener(this.failure);
    return () => this.listeners.delete(listener);
  }

  race<T>(operation: Promise<T>): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<T>((resolve, reject) => {
      let settledByFailure = false;
      let remove: () => void = () => undefined;
      remove = this.onFailure((error) => { settledByFailure = true; remove(); reject(error); });
      if (settledByFailure) remove();
      operation.then(
        (value) => { remove(); resolve(value); },
        (error: unknown) => { remove(); reject(error); },
      );
    });
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const listener of this.listeners) listener(error);
  }
}

async function attestSocketRoot(path: string): Promise<void> {
  let state;
  try { state = await lstat(path); }
  catch { throw new AppError("CONFIGURATION_ERROR", "invalid private SSH socket root"); }
  const uid = process.getuid?.();
  if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077) !== 0 || (uid !== undefined && state.uid !== uid)) {
    throw new AppError("CONFIGURATION_ERROR", "invalid private SSH socket root");
  }
}

async function waitForSocket(
  monitor: ForwardProcessMonitor,
  path: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<SocketIdentity> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const identity = await ownedSocketIdentity(path);
      if (identity) return identity;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    await monitor.race(sleep(20));
  }
  throw new AppError("ENDPOINT_UNAVAILABLE", "SSH stream-local forward did not become ready");
}

async function ownedSocketIdentity(path: string): Promise<SocketIdentity | undefined> {
  const state = await lstat(path, { bigint: true });
  const uid = process.getuid?.();
  if (!state.isSocket() || state.isSymbolicLink() || (state.mode & 0o077n) !== 0n
    || (uid !== undefined && state.uid !== BigInt(uid))) return undefined;
  return { device: state.dev.toString(10), inode: state.ino.toString(10) };
}

async function removeExactSocket(path: string, expected?: SocketIdentity): Promise<void> {
  if (!expected) return;
  let state;
  try { state = await lstat(path, { bigint: true }); }
  catch (error) { if (isErrno(error, "ENOENT")) return; throw error; }
  if (!state.isSocket() || state.dev.toString(10) !== expected.device || state.ino.toString(10) !== expected.inode) return;
  await unlink(path);
}

async function stopForwardChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let hard: ReturnType<typeof setTimeout> | undefined;
    const force = setTimeout(() => {
      child.kill("SIGKILL");
      hard = setTimeout(resolve, 500);
      hard.unref?.();
    }, 2_000);
    force.unref?.();
    child.once("exit", () => { clearTimeout(force); if (hard) clearTimeout(hard); resolve(); });
    child.kill("SIGTERM");
  });
}

function sameSshIdentity(expected: RuntimeIdentity, actual: RuntimeIdentity | undefined): boolean {
  return expected.kind === "ssh" && actual?.kind === "ssh"
    && expected.token === actual.token && expected.pid === actual.pid
    && expected.linuxStartTime === actual.linuxStartTime && expected.processGroupId === actual.processGroupId;
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
