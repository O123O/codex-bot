import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute } from "node:path";
import { buildSshStreamArgs, parseSshConfig, planSshConnection, type SshConnectionPlan } from "../endpoints/ssh-config.ts";
import { runBoundedProcess } from "../endpoints/ssh-process.ts";
import { ONE_SHOT_ENV, rejectOneShotCommand, type ExecResult } from "./web-exec.ts";
import { validFileName, type WebFilesResult, type WebFileWriteResult } from "./web-files.ts";
import { parseGitStatus, type GitStatus } from "./web-git.ts";

// Remote file/git access for the web UI over ssh. REUSES the core's ssh-config machinery: the plan
// forces `-o ControlMaster=no` (ride the master the core established, never create one), and untrusted
// paths are POSIX-single-quoted into a `bash -c` command so the remote login shell can't reparse them.
// No edits to the core endpoint layer — web-UI-only.

export interface RemoteDeps { sshBinary: string; sshRuntimeRoot: string }

// POSIX single-quote: makes any bytes a literal in the remote shell (only `'` needs escaping).
const q = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

const PLAN_TTL_MS = 60_000;
const planCache = new Map<string, { plan: SshConnectionPlan; at: number }>();
async function planFor(deps: RemoteDeps, host: string): Promise<SshConnectionPlan> {
  const cached = planCache.get(host);
  if (cached && Date.now() - cached.at < PLAN_TTL_MS) return cached.plan;
  const probed = await runBoundedProcess(deps.sshBinary, ["-G", host], { timeoutMs: 15_000, maxOutputBytes: 1 << 20 });
  const plan = planSshConnection(host, parseSshConfig(probed.stdout.toString("utf8")), deps.sshRuntimeRoot);
  planCache.set(host, { plan, at: Date.now() });
  return plan;
}

// Confinement preamble on the remote: realpath the root (H3 — symlinked NFS homes) and the target
// (absolute path as-is, else root-relative), then prove containment. `"$root"` is quoted so glob chars
// in it are literal; only the trailing `/*` is a wildcard. Sets `$root` and `$t`.
function guard(root: string, path: string, absolute: boolean): string {
  return [
    `root=$(realpath -m -- ${q(root)}) || exit 3`,
    absolute ? `t=$(realpath -m -- ${q(path)}) || exit 3` : `t=$(realpath -m -- "$root/"${q(path)}) || exit 3`,
    `[ -n "$t" ] || exit 3`,
    `case "$t/" in "$root"/*) : ;; *) exit 4 ;; esac`,
  ].join("\n");
}

// The login shell only ever runs `exec bash -c '<script>'` — one argv element, sh- or csh-safe.
// Insert -T before the host so even a host-level RequestTTY=force cannot make Web UI jobs interactive.
const sshArgs = (plan: SshConnectionPlan, script: string): string[] => {
  const args = buildSshStreamArgs(plan, `exec bash -c ${q(script)}`);
  return [...args.slice(0, -2), "-T", ...args.slice(-2)];
};

interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }
async function run(
  deps: RemoteDeps,
  host: string,
  script: string,
  opts: { maxBytes: number; timeoutMs: number; input?: Buffer; killOnLimit?: boolean; supervised?: boolean },
): Promise<RunResult> {
  const plan = await planFor(deps, host);
  const child = spawn(deps.sshBinary, sshArgs(plan, script), { stdio: ["pipe", "pipe", "pipe"] });
  return new Promise((resolve) => {
    let stdout = "", stderr = "", size = 0, timedOut = false, truncated = false, done = false, stopping = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      if (opts.supervised) {
        // The remote supervisor owns SSH stdin while the command gets /dev/null. EOF asks it to kill
        // the remote process group; SIGKILL is only a backstop if the channel cannot drain.
        child.stdin.end();
        forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_500);
        forceTimer.unref?.();
      } else {
        child.kill("SIGKILL");
      }
    };
    const cap = (buf: Buffer, add: (s: string) => void): void => {
      if (size >= opts.maxBytes) {
        truncated = true;
        if (opts.killOnLimit) stop();
        return;
      }
      const c = buf.subarray(0, opts.maxBytes - size);
      size += c.length;
      add(c.toString("utf8"));
      if (size >= opts.maxBytes) {
        truncated = true;
        if (opts.killOnLimit) stop();
      }
    };
    child.stdout.on("data", (b: Buffer) => cap(b, (s) => { stdout += s; }));
    child.stderr.on("data", (b: Buffer) => cap(b, (s) => { stderr += s; }));
    const timer = setTimeout(() => { timedOut = true; stop(); }, opts.timeoutMs);
    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      child.stdin.destroy();
      resolve({ code, stdout, stderr, timedOut, truncated });
    };
    child.stdin.on("error", () => {});
    if (!opts.supervised) child.stdin.end(opts.input);
    child.on("close", (code) => finish(code));
    child.on("error", () => finish(null));
  });
}

const remoteError = (r: RunResult, fallback: string): string =>
  r.timedOut ? "remote timed out" : r.code === 255 ? "remote host not connected (ssh master down?)" : (r.stderr.trim() || fallback);

// --- File tree ---
export async function remoteBrowse(deps: RemoteDeps, host: string, root: string, rel: string): Promise<WebFilesResult> {
  const script = `${guard(root, rel === "" ? "." : rel, false)}\n[ -d "$t" ] || exit 6\nfind "$t" -maxdepth 1 -mindepth 1 -printf '%y\\t%P\\0'`;
  const r = await run(deps, host, script, { maxBytes: 4 << 20, timeoutMs: 15_000 });
  if (r.code === 4) return { error: "path not allowed" };
  if (r.code === 6) return { error: "not a directory" };
  if (r.code !== 0) return { error: remoteError(r, "browse failed") };
  const entries = r.stdout.split("\0").filter(Boolean).map((rec) => {
    const tab = rec.indexOf("\t");
    const kind = rec.slice(0, tab), name = rec.slice(tab + 1);
    return { name, type: kind === "d" ? "dir" as const : kind === "f" ? "file" as const : "other" as const };
  }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { kind: "dir", path: rel, entries };
}

export async function remoteUploadFile(
  deps: RemoteDeps,
  host: string,
  root: string,
  relPath: string,
  bytes: Buffer,
): Promise<WebFileWriteResult> {
  if (isAbsolute(relPath) || relPath.split(/[\\/]+/u).includes("..")) return { error: "path not allowed" };
  const name = basename(relPath);
  if (!validFileName(name)) return { error: "invalid name" };
  const parent = dirname(relPath);
  const temporary = `.qiyan-upload-${randomUUID()}`;
  const script = `${guard(root, parent === "." ? "." : parent, false)}
[ -d "$t" ] || exit 6
target="$t/"${q(name)}
temporary="$t/"${q(temporary)}
trap 'rm -f -- "$temporary"' EXIT HUP INT TERM
if [ -e "$target" ] || [ -L "$target" ]; then exit 7; fi
umask 077
set -o noclobber
cat > "$temporary" || exit 8
ln -- "$temporary" "$target" || { if [ -e "$target" ] || [ -L "$target" ]; then exit 7; fi; exit 8; }
rm -f -- "$temporary"
trap - EXIT HUP INT TERM`;
  const result = await run(deps, host, script, { input: bytes, maxBytes: 64 << 10, timeoutMs: 60_000 });
  if (result.code === 0) return { ok: true, path: relPath };
  if (result.code === 4) return { error: "path not allowed" };
  if (result.code === 6) return { error: "destination is not a directory" };
  if (result.code === 7) return { error: "already exists" };
  return { error: remoteError(result, "upload failed") };
}

export async function remoteCreateEntry(
  deps: RemoteDeps,
  host: string,
  root: string,
  relPath: string,
  kind: "file" | "dir",
): Promise<WebFileWriteResult> {
  if (kind === "file") return remoteUploadFile(deps, host, root, relPath, Buffer.alloc(0));
  if (isAbsolute(relPath) || relPath.split(/[\\/]+/u).includes("..")) return { error: "path not allowed" };
  const name = basename(relPath);
  if (!validFileName(name)) return { error: "invalid name" };
  const parent = dirname(relPath);
  const script = `${guard(root, parent === "." ? "." : parent, false)}
[ -d "$t" ] || exit 6
target="$t/"${q(name)}
if [ -e "$target" ] || [ -L "$target" ]; then exit 7; fi
mkdir -- "$target" || { if [ -e "$target" ] || [ -L "$target" ]; then exit 7; fi; exit 8; }`;
  const result = await run(deps, host, script, { maxBytes: 64 << 10, timeoutMs: 15_000 });
  if (result.code === 0) return { ok: true, path: relPath };
  if (result.code === 4) return { error: "path not allowed" };
  if (result.code === 6) return { error: "destination is not a directory" };
  if (result.code === 7) return { error: "already exists" };
  return { error: remoteError(result, "create failed") };
}

export async function remoteRunCommand(
  deps: RemoteDeps,
  host: string,
  root: string,
  command: string,
  opts: { maxBytes: number; timeoutMs: number },
): Promise<ExecResult> {
  const rejected = rejectOneShotCommand(command);
  if (rejected) return rejected;
  const environment = Object.entries(ONE_SHOT_ENV).map(([name, value]) => `export ${name}=${q(value)}`).join("\n");
  const completionNonce = randomUUID();
  // The held SSH channel normally stops the remote group first. This remote-side deadline is the
  // backstop when a broken transport cannot deliver EOF; it intentionally trails the local deadline.
  const remoteDeadlineSeconds = ((opts.timeoutMs + 3_000) / 1_000).toFixed(3);
  const script = `${guard(root, ".", false)}
[ -d "$t" ] || { printf 'project directory not found\\n' >&2; exit 125; }
cd -- "$t" || { printf 'project directory not accessible\\n' >&2; exit 125; }
${environment}
command -v setsid >/dev/null 2>&1 || { printf 'remote process supervision unavailable\\n' >&2; exit 126; }
exec 3<&0
cmd_pid=
watch_pid=
cleanup_group() {
  [ -n "$cmd_pid" ] || return
  kill -TERM -- "-$cmd_pid" 2>/dev/null || :
  n=0
  while kill -0 -- "-$cmd_pid" 2>/dev/null && [ "$n" -lt 20 ]; do
    sleep 0.1
    n=$((n + 1))
  done
  kill -KILL -- "-$cmd_pid" 2>/dev/null || :
}
shutdown() {
  trap - HUP INT TERM
  cleanup_group
  exit 143
}
trap shutdown HUP INT TERM
setsid bash -lc ${q(command)} </dev/null 3<&- &
cmd_pid=$!
(
  IFS= read -r -t ${remoteDeadlineSeconds} _ <&3 || :
  kill -TERM "$$" 2>/dev/null || :
) &
watch_pid=$!
wait "$cmd_pid"
status=$?
cleanup_group
kill "$watch_pid" 2>/dev/null || :
wait "$watch_pid" 2>/dev/null || :
exec 3<&-
trap - HUP INT TERM
printf '\\036qiyan-exec:%s:%s\\037' ${q(completionNonce)} "$status" >&2
exit 0`;
  const result = await run(deps, host, script, { ...opts, killOnLimit: true, supervised: true });
  const prefix = `\u001eqiyan-exec:${completionNonce}:`;
  const markerStart = result.stderr.lastIndexOf(prefix);
  const markerEnd = markerStart < 0 ? -1 : result.stderr.indexOf("\u001f", markerStart + prefix.length);
  const rawStatus = markerEnd < 0 ? "" : result.stderr.slice(markerStart + prefix.length, markerEnd);
  const completed = /^\d{1,3}$/u.test(rawStatus) && Number(rawStatus) <= 255;
  const stderr = completed
    ? result.stderr.slice(0, markerStart) + result.stderr.slice(markerEnd + 1)
    : result.stderr;
  const error = !completed && !result.timedOut && !result.truncated
    ? remoteError(result, "remote command failed")
    : undefined;
  return {
    stdout: result.stdout,
    stderr,
    exitCode: completed ? Number(rawStatus) : result.timedOut || result.truncated ? null : result.code,
    timedOut: result.timedOut,
    truncated: result.truncated,
    ...(error ? { error } : {}),
  };
}

// --- Streaming read (for /api/raw) ---
// The owner-only preview streams ANY file the remote user can read (a worker references files outside
// its project dir) — so, unlike browse/git, this is NOT confined to the project root. The remote OS's
// own read permission is the boundary: an absent/unreadable path exits non-zero → the caller returns
// 404. An absolute path is used as-is; a relative one is joined under the project root. `[ -f "$t" ]`
// guarantees a REGULAR file (not a dir/FIFO/device), so `cat` always makes progress and never blocks
// idle — it streams then exits, and on a client disconnect the caller kills this ssh child, which
// SIGPIPEs the remote `cat` on its next write. `q()` single-quotes the (untrusted) path so the remote
// shell can't reparse it; `cat --` blocks option injection. Caller pipes `.stdout`, kills on close, caps.
export async function remoteReadStream(deps: RemoteDeps, host: string, root: string, path: string): Promise<ChildProcessWithoutNullStreams> {
  const plan = await planFor(deps, host);
  const target = isAbsolute(path) ? path : `${root}/${path}`;
  const script = `t=${q(target)}\n[ -f "$t" ] || exit 5\nexec cat -- "$t"`;
  return spawn(deps.sshBinary, sshArgs(plan, script), { stdio: ["pipe", "pipe", "pipe"] });
}

// --- Git (mirrors web-git.ts over ssh) ---
// Run git in the confined repo dir (root/repo). git args are fixed flags + single-quoted paths, all
// `--`-separated by the callers, so a filename can't act as a git option.
async function gitRun(deps: RemoteDeps, host: string, root: string, repo: string, args: string[], timeoutMs = 20_000): Promise<RunResult> {
  const gitCmd = ["git", "-C", '"$t"', "-c", "core.quotePath=false", ...args].join(" ");
  const script = `${guard(root, repo === "" ? "." : repo, false)}\n[ -d "$t" ] || exit 6\n${gitCmd}`;
  return run(deps, host, script, { maxBytes: 8 << 20, timeoutMs });
}

export async function remoteGitStatus(deps: RemoteDeps, host: string, root: string, repo: string): Promise<GitStatus | { error: string }> {
  const inside = await gitRun(deps, host, root, repo, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code === 4) return { error: "path not allowed" };
  if (inside.stdout.trim() !== "true") return { error: inside.code === 255 ? remoteError(inside, "") : "not a git repository" };
  const r = await gitRun(deps, host, root, repo, ["status", "--porcelain=v1", "--branch"]);
  if (r.code !== 0 && !r.stdout) return { error: remoteError(r, "git status failed") };
  return parseGitStatus(r.stdout);
}

export async function remoteGitDiff(deps: RemoteDeps, host: string, root: string, repo: string, path: string, staged: boolean): Promise<{ diff: string } | { error: string }> {
  if (isAbsolute(path) || path.split(/[\\/]+/u).includes("..")) return { error: "path not allowed" };
  const primary = await gitRun(deps, host, root, repo, staged ? ["diff", "--cached", "--", q(path)] : ["diff", "--", q(path)]);
  if (primary.code === 4 || primary.code === 6) return { error: "repo not found" };
  if (primary.code === 255 || primary.timedOut) return { error: remoteError(primary, "diff failed") }; // ssh down ≠ "(no changes)"
  if (primary.stdout.trim()) return { diff: primary.stdout };
  if (!staged) {
    // Untracked whole-file diff: confine the FILE to the repo on the remote (realpath catches symlinks),
    // mirroring the local --no-index guard.
    const script = `${guard(root, repo === "" ? "." : repo, false)}\n[ -d "$t" ] || exit 6\nf=$(realpath -m -- "$t/"${q(path)}) || exit 4\ncase "$f/" in "$t"/*) : ;; *) exit 4 ;; esac\ngit -C "$t" diff --no-index -- /dev/null "$f"`;
    const untracked = await run(deps, host, script, { maxBytes: 8 << 20, timeoutMs: 20_000 });
    if (untracked.stdout.trim()) return { diff: untracked.stdout };
  }
  return { diff: primary.stdout || "(no changes)" };
}

export async function remoteGitStage(deps: RemoteDeps, host: string, root: string, repo: string, path: string): Promise<{ ok: true } | { error: string }> {
  const r = await gitRun(deps, host, root, repo, ["add", "--", q(path)]);
  return r.code === 0 ? { ok: true } : { error: remoteError(r, "stage failed") };
}
export async function remoteGitUnstage(deps: RemoteDeps, host: string, root: string, repo: string, path: string): Promise<{ ok: true } | { error: string }> {
  const r = await gitRun(deps, host, root, repo, ["reset", "-q", "HEAD", "--", q(path)]);
  return r.code === 0 ? { ok: true } : { error: remoteError(r, "unstage failed") };
}
export async function remoteGitCommit(deps: RemoteDeps, host: string, root: string, repo: string, message: string): Promise<{ ok: true; output: string } | { error: string }> {
  if (!message.trim()) return { error: "commit message required" };
  const r = await gitRun(deps, host, root, repo, ["commit", "-m", q(message)]);
  return r.code === 0 ? { ok: true, output: r.stdout.trim() } : { error: remoteError(r, "commit failed") };
}

// Bounded remote repo discovery: dirs containing `.git` under root, relative to root ("" = root repo).
export async function remoteDiscover(deps: RemoteDeps, host: string, root: string): Promise<string[]> {
  const script = `${guard(root, ".", false)}\ncd "$root" || exit 3\nfind . -maxdepth 5 \\( -name node_modules -o -name .venv -o -name dist -o -name build \\) -prune -o -name .git -printf '%h\\0' 2>/dev/null`;
  const r = await run(deps, host, script, { maxBytes: 256 << 10, timeoutMs: 20_000 });
  if (r.code !== 0 && !r.stdout) return [];
  const seen = new Set<string>();
  for (const parent of r.stdout.split("\0").filter(Boolean)) seen.add(parent === "." ? "" : parent.replace(/^\.\//, ""));
  return [...seen].slice(0, 50);
}
