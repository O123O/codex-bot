import { spawn } from "node:child_process";
import { AppError } from "../core/errors.ts";

export interface BoundedProcessResult { stdout: Buffer; stderr: Buffer }

export function runBoundedProcess(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; maxOutputBytes: number; input?: Uint8Array; signal?: AbortSignal },
): Promise<BoundedProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    };
    const stop = (error: Error) => {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 250);
      force.unref?.();
      finish(error);
    };
    const capture = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > options.maxOutputBytes) { stop(new AppError("ENDPOINT_UNAVAILABLE", "SSH process exceeded its output limit")); return; }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", () => finish(new AppError("ENDPOINT_UNAVAILABLE", "SSH process could not start")));
    child.once("exit", (code, signal) => {
      if (code === 0) finish();
      else finish(new AppError("ENDPOINT_UNAVAILABLE", `SSH process failed (${signal ? "signal" : `exit ${code ?? "unknown"}`})`));
    });
    const timeout = setTimeout(() => stop(new AppError("ENDPOINT_UNAVAILABLE", "SSH process timed out")), options.timeoutMs);
    timeout.unref?.();
    const abort = () => stop(options.signal?.reason instanceof Error ? options.signal.reason : new Error("SSH process aborted"));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}
