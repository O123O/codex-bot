import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { AppError } from "../core/errors.ts";
import { CoordinatorNotebook } from "./notebook.ts";

const POLICY_FILE = "AGENTS.md";
const DIGEST_FILE = ".codex-bot-agents.sha256";

export interface CoordinatorWorkspaceOptions {
  workdir: string;
  dataDir: string;
  registryPath: string;
  policyTemplatePath: string;
  notebookTemplatePath: string;
}

export interface PreparedCoordinatorWorkspace {
  root: string;
  dataRoot: string;
  registryPath: string;
  notebook: CoordinatorNotebook;
  warnings: string[];
}

export async function prepareCoordinatorWorkspace(options: CoordinatorWorkspaceOptions): Promise<PreparedCoordinatorWorkspace> {
  try {
    const requestedRoot = resolve(options.workdir);
    const requestedDataRoot = resolve(options.dataDir);
    const requestedRegistryPath = resolve(options.registryPath);
    assertSeparated(requestedRoot, requestedDataRoot, "configured data directory");
    assertSeparated(requestedRoot, requestedRegistryPath, "configured registry path");

    await mkdir(options.workdir, { recursive: true, mode: 0o700 });
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    await mkdir(dirname(options.registryPath), { recursive: true, mode: 0o700 });

    const root = await realpath(options.workdir);
    const dataRoot = await realpath(options.dataDir);
    const registryPath = await canonicalFilePath(options.registryPath);
    assertSeparated(root, requestedDataRoot, "configured data directory");
    assertSeparated(root, requestedRegistryPath, "configured registry path");
    assertSeparated(requestedRoot, dataRoot, "canonical data directory");
    assertSeparated(requestedRoot, registryPath, "canonical registry path");
    assertSeparated(root, dataRoot, "data directory");
    assertSeparated(root, registryPath, "registry path");

    const policyPath = join(root, POLICY_FILE);
    const digestPath = join(root, DIGEST_FILE);
    const packagedPolicy = await readFile(options.policyTemplatePath);
    const packagedDigest = digest(packagedPolicy);
    const policyState = await regularFileState(policyPath);
    const digestState = await regularFileState(digestPath);

    if (policyState === "missing" && digestState === "missing") {
      await atomicWrite(policyPath, packagedPolicy);
      await atomicWrite(digestPath, Buffer.from(`${packagedDigest}\n`));
    } else if (policyState === "file" && digestState === "missing") {
      const installed = await readFile(policyPath);
      if (digest(installed) !== packagedDigest) throw managedError(`${policyPath} has no bot digest and does not match the packaged policy`);
      await atomicWrite(digestPath, Buffer.from(`${packagedDigest}\n`));
    } else if (policyState === "missing" && digestState === "file") {
      throw managedError(`digest exists but AGENTS.md is missing at ${policyPath}`);
    } else {
      const installed = await readFile(policyPath);
      const recorded = (await readFile(digestPath, "utf8")).trim();
      if (!/^[a-f0-9]{64}$/u.test(recorded) || digest(installed) !== recorded) {
        throw managedError(`${policyPath} is managed by codex-bot and was modified; put custom instructions in AGENTS.override.md`);
      }
      if (recorded !== packagedDigest) {
        await atomicWrite(policyPath, packagedPolicy);
        await atomicWrite(digestPath, Buffer.from(`${packagedDigest}\n`));
      }
    }

    const notebook = await CoordinatorNotebook.bootstrap(join(root, "session-status.json"), options.notebookTemplatePath);
    const gitRoot = await findGitAncestor(root);
    const warnings = gitRoot ? [`Coordinator workdir ${root} is inside Git worktree ${gitRoot}; Codex may inherit parent instructions.`] : [];
    return { root, dataRoot, registryPath, notebook, warnings };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw managedError(`cannot prepare coordinator workdir ${options.workdir}`);
  }
}

type FileState = "missing" | "file";

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function managedError(message: string): AppError {
  return new AppError("CONFIGURATION_ERROR", message);
}

async function regularFileState(path: string): Promise<FileState> {
  try {
    const value = await lstat(path);
    if (!value.isFile() || value.isSymbolicLink()) throw managedError(`${path} must be a regular file`);
    return "file";
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "missing";
    throw error;
  }
}

async function atomicWrite(path: string, value: Uint8Array): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, value, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (!isErrno(error, "ENOENT")) throw error;
    });
  }
}

async function canonicalFilePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    return join(await realpath(dirname(path)), basename(path));
  }
}

function assertSeparated(workdir: string, protectedPath: string, label: string): void {
  if (contains(workdir, protectedPath) || contains(protectedPath, workdir)) {
    throw managedError(`coordinator workdir ${workdir} and backend ${label} ${protectedPath} must be separate from backend state`);
  }
}

function contains(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate === "" || (!candidate.startsWith(`..${sep}`) && candidate !== ".." && !isAbsolute(candidate));
}

async function findGitAncestor(start: string): Promise<string | undefined> {
  const filesystemRoot = parse(start).root;
  let current = start;
  while (true) {
    try {
      await lstat(join(current, ".git"));
      return current;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    if (current === filesystemRoot) return undefined;
    current = dirname(current);
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
