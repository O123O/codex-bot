import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export interface WebFilesDeps {
  // The managed project directory for a session nickname (the ONLY roots the browser may reach).
  projectDir(nickname: string): string | undefined;
  maxFileBytes: number;
}

export type WebFilesResult =
  | { kind: "dir"; path: string; entries: Array<{ name: string; type: "dir" | "file" | "other" }> }
  | { kind: "file"; path: string; content: string; truncated: boolean; encoding: "utf-8" | "base64" }
  | { error: string };

// Resolve `relPath` under `root` and PROVE (via realpath) the result stays inside the real root —
// so no `..`, absolute path, or symlink can escape the session's project directory. There is no OS
// sandbox on this process, so this confinement is the whole security boundary for file browsing.
export async function confine(root: string, relPath: string): Promise<string | undefined> {
  if (isAbsolute(relPath) || relPath.split(/[\\/]+/u).includes("..")) return undefined;
  const realRoot = await realpath(root).catch(() => undefined);
  if (realRoot === undefined) return undefined;
  const realTarget = await realpath(resolve(realRoot, relPath)).catch(() => undefined);
  if (realTarget === undefined) return undefined;
  if (realTarget === realRoot) return realRoot;
  const rel = relative(realRoot, realTarget);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? undefined : realTarget;
}

// List a directory or read a file, confined to the named session's project directory.
export async function browse(deps: WebFilesDeps, nickname: string, relPath: string): Promise<WebFilesResult> {
  const root = deps.projectDir(nickname);
  if (root === undefined) return { error: "unknown session" };
  const target = await confine(root, relPath === "" ? "." : relPath);
  if (target === undefined) return { error: "path not allowed" };

  const info = await stat(target).catch(() => undefined);
  if (info === undefined) return { error: "not found" };

  if (info.isDirectory()) {
    const dirents = await readdir(target, { withFileTypes: true }).catch(() => []);
    const entries = dirents.map((entry) => ({
      name: entry.name,
      // Symlinks/sockets/etc. are "other" (never followed for listing) so the client doesn't
      // present them as traversable directories.
      type: entry.isDirectory() ? "dir" as const : entry.isFile() ? "file" as const : "other" as const,
    })).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return { kind: "dir", path: relPath, entries };
  }

  if (!info.isFile()) return { error: "not a regular file" };
  const linkInfo = await lstat(target).catch(() => undefined);
  if (linkInfo?.isSymbolicLink()) return { error: "path not allowed" };
  const truncated = info.size > deps.maxFileBytes;
  // Read at most maxFileBytes so a huge file in the project dir can't spike memory.
  const buffer = Buffer.alloc(Math.min(info.size, deps.maxFileBytes));
  const handle = await open(target, "r");
  try { await handle.read(buffer, 0, buffer.length, 0); } finally { await handle.close(); }
  const bytes = buffer;
  // A NUL byte marks the file as binary → base64; otherwise serve it as UTF-8 text.
  return bytes.includes(0)
    ? { kind: "file", path: relPath, content: bytes.toString("base64"), truncated, encoding: "base64" }
    : { kind: "file", path: relPath, content: bytes.toString("utf-8"), truncated, encoding: "utf-8" };
}
