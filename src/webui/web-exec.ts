import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  error?: string;
}

export const ONE_SHOT_ENV = {
  TERM: "dumb",
  PAGER: "cat",
  GIT_PAGER: "cat",
  SYSTEMD_PAGER: "cat",
  MANPAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
  SSH_ASKPASS: "/bin/false",
  SSH_ASKPASS_REQUIRE: "force",
} as const;

// Fast UX rejection for obvious editor/pager commands. This is not a security boundary: no TTY,
// closed stdin, noninteractive environment, timeout, output cap, and process-group cleanup are.
const BLOCKED = /^\s*(sudo\s+)?(vi|vim|nvim|nano|emacs|less|more|man|top|htop|watch|ncdu|fzf)\b/;

export function rejectOneShotCommand(command: string): ExecResult | undefined {
  if (command.includes("\0")) return { stdout: "", stderr: "command contains a null byte", exitCode: null, timedOut: false, truncated: false, error: "invalid" };
  if (BLOCKED.test(command)) return { stdout: "", stderr: "interactive commands aren't supported here", exitCode: null, timedOut: false, truncated: false, error: "blocked" };
  return undefined;
}

// Run `command` via `bash -lc` in `cwd`, non-interactively, with an output-byte cap and a timeout that
// escalates SIGTERM → SIGKILL. Output is not persisted by the caller; this is an ephemeral `!`-command.
export function runCommand(cwd: string, command: string, opts: { maxBytes: number; timeoutMs: number }): Promise<ExecResult> {
  const rejected = rejectOneShotCommand(command);
  if (rejected) return Promise.resolve(rejected);
  return new Promise((resolveResult) => {
    // `detached` makes bash a process-group leader so we can kill the WHOLE group — a backgrounded
    // grandchild (`sleep 300 &`) would otherwise orphan, hold the stdout pipe, and hang the response.
    const child = spawn("bash", ["-lc", command], { cwd, detached: true, env: { ...process.env, ...ONE_SHOT_ENV } });
    let stdout = "", stderr = "", size = 0, truncated = false, timedOut = false, settled = false;
    let exitCode: number | null = null, errorMsg: string | undefined;
    const killGroup = (sig: NodeJS.Signals): void => { try { if (child.pid) process.kill(-child.pid, sig); } catch { /* already gone */ } };
    const append = (buf: Buffer, add: (s: string) => void): void => {
      if (size >= opts.maxBytes) return;
      const chunk = buf.subarray(0, opts.maxBytes - size);
      size += chunk.length; add(chunk.toString("utf-8"));
      if (size >= opts.maxBytes) { truncated = true; killGroup("SIGKILL"); }
    };
    child.stdout.on("data", (b: Buffer) => append(b, (s) => { stdout += s; }));
    child.stderr.on("data", (b: Buffer) => append(b, (s) => { stderr += s; }));
    const timer = setTimeout(() => { timedOut = true; killGroup("SIGTERM"); setTimeout(() => killGroup("SIGKILL"), 2000).unref?.(); }, opts.timeoutMs);
    // Backstop: resolve even if `close` never fires (a detached grandchild holding the pipe).
    const hard = setTimeout(() => { killGroup("SIGKILL"); finish(); }, opts.timeoutMs + 5000); hard.unref?.();
    const finish = (): void => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(hard); resolveResult({ stdout, stderr, exitCode, timedOut, truncated, ...(errorMsg ? { error: errorMsg } : {}) }); };
    child.on("close", (code) => { exitCode = code; finish(); });
    child.on("error", (e) => { errorMsg = e.message; finish(); });
    child.stdin.end();
  });
}
