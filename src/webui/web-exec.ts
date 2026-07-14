import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  error?: string;
}

// One-shot commands only — reject interactive/pager programs that would hang without a TTY.
const BLOCKED = /^\s*(sudo\s+)?(vi|vim|nvim|nano|emacs|less|more|man|top|htop|watch|ssh|telnet|ftp|sftp|python|python3|node|irb|ipython|psql|mysql|sqlite3|ncdu|fzf)\b/;

// Run `command` via `bash -lc` in `cwd`, non-interactively, with an output-byte cap and a timeout that
// escalates SIGTERM → SIGKILL. Output is not persisted by the caller; this is an ephemeral `!`-command.
export function runCommand(cwd: string, command: string, opts: { maxBytes: number; timeoutMs: number }): Promise<ExecResult> {
  if (BLOCKED.test(command)) return Promise.resolve({ stdout: "", stderr: "interactive commands aren't supported here", exitCode: null, timedOut: false, truncated: false, error: "blocked" });
  return new Promise((resolveResult) => {
    const child = spawn("bash", ["-lc", command], { cwd, env: { ...process.env, TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat" } });
    let stdout = "", stderr = "", size = 0, truncated = false, timedOut = false;
    const append = (buf: Buffer, add: (s: string) => void): void => {
      if (size >= opts.maxBytes) return;
      const chunk = buf.subarray(0, opts.maxBytes - size);
      size += chunk.length; add(chunk.toString("utf-8"));
      if (size >= opts.maxBytes) { truncated = true; child.kill("SIGKILL"); }
    };
    child.stdout.on("data", (b: Buffer) => append(b, (s) => { stdout += s; }));
    child.stderr.on("data", (b: Buffer) => append(b, (s) => { stderr += s; }));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 2000).unref?.(); }, opts.timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolveResult({ stdout, stderr, exitCode: code, timedOut, truncated }); });
    child.on("error", (e) => { clearTimeout(timer); resolveResult({ stdout, stderr, exitCode: null, timedOut, truncated, error: e.message }); });
    child.stdin.end();
  });
}
