import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { AppError } from "../core/errors.ts";

const privateDirectoryMode = 0o700;

interface LocalRuntimeOptions {
  runtimeBase?: string;
  expectedUid?: number;
  xdgRuntimeDir?: string | null;
  temporaryDirectory?: string;
}

export async function prepareLocalSshRuntimeRoot(
  dataDir: string,
  options: LocalRuntimeOptions = {},
): Promise<string> {
  if (!isAbsolute(dataDir)) throw runtimeDirectoryError();
  const expectedUid = options.expectedUid ?? process.geteuid?.() ?? process.getuid?.();
  const runtimeBase = options.runtimeBase ?? defaultRuntimeBase(expectedUid, options);
  if (!isAbsolute(runtimeBase)) throw runtimeDirectoryError();

  await ensurePrivateOwnerDirectory(runtimeBase, expectedUid, options.runtimeBase === undefined);
  const productRoot = join(runtimeBase, "qiyan");
  await ensurePrivateOwnerDirectory(productRoot, expectedUid, true);
  const namespace = createHash("sha256").update(dataDir).digest("hex").slice(0, 16);
  const namespaceRoot = join(productRoot, namespace);
  await ensurePrivateOwnerDirectory(namespaceRoot, expectedUid, true);
  return namespaceRoot;
}

function defaultRuntimeBase(uid: number | undefined, options: LocalRuntimeOptions): string {
  const configured = options.xdgRuntimeDir === undefined ? process.env.XDG_RUNTIME_DIR : options.xdgRuntimeDir ?? undefined;
  if (configured && isAbsolute(configured)) return configured;
  if (uid === undefined) throw runtimeDirectoryError();
  return join(options.temporaryDirectory ?? tmpdir(), `qiyan-${uid}`);
}

async function ensurePrivateOwnerDirectory(path: string, expectedUid: number | undefined, create: boolean): Promise<void> {
  if (create) {
    try { await mkdir(path, { mode: privateDirectoryMode }); }
    catch (error) { if (!isErrno(error, "EEXIST")) throw runtimeDirectoryError(); }
  }
  let directory;
  try { directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch { throw runtimeDirectoryError(); }
  try {
    let state = await directory.stat();
    if (!state.isDirectory() || (expectedUid !== undefined && state.uid !== expectedUid)) throw runtimeDirectoryError();
    if ((state.mode & 0o777) !== privateDirectoryMode) {
      await directory.chmod(privateDirectoryMode);
      state = await directory.stat();
    }
    if (!state.isDirectory() || (state.mode & 0o777) !== privateDirectoryMode
      || (expectedUid !== undefined && state.uid !== expectedUid)) throw runtimeDirectoryError();
  } finally { await directory.close(); }
}

function runtimeDirectoryError(message = "local SSH runtime must be a private owner directory"): AppError {
  return new AppError("CONFIGURATION_ERROR", message);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
