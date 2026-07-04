import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface FixturePaths {
  repositoryRoot: string;
  composeFile: string;
  stateDir: string;
  privateKey: string;
  publicKey: string;
  trustedHostKey: string;
  knownHosts: string;
  sshConfig: string;
}

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface CommandRunnerOptions {
  env?: NodeJS.ProcessEnv;
  inherit?: boolean;
  timeoutMs?: number;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: CommandRunnerOptions,
) => Promise<CommandResult>;

export interface FixtureOwnershipOptions {
  currentUid?: number;
}

export const DEFAULT_SSH_PORT = 2222;
export const DEFAULT_CODEX_VERSION = "0.142.5";
export const SSH_ALIAS = "qiyan-ssh-worker";

const CONFIG_UNSAFE = /[\u0000-\u0020\u007f#"'\\%]/u;
const OWNER_ONLY_FILE_MODE = 0o600;

function fixturePaths(repositoryRoot: string): FixturePaths {
  const stateDir = join(repositoryRoot, ".tmp", "ssh-worker");
  const privateKey = join(stateDir, "id_ed25519");
  return {
    repositoryRoot,
    composeFile: join(repositoryRoot, "docker", "ssh-worker", "compose.yaml"),
    stateDir,
    privateKey,
    publicKey: `${privateKey}.pub`,
    trustedHostKey: join(stateDir, "trusted-host-key.pub"),
    knownHosts: join(stateDir, "known_hosts"),
    sshConfig: join(stateDir, "config"),
  };
}

export function resolveFixturePaths(repositoryRoot: string): FixturePaths {
  if (!isAbsolute(repositoryRoot) || resolve(repositoryRoot) !== repositoryRoot || CONFIG_UNSAFE.test(repositoryRoot)) {
    if (CONFIG_UNSAFE.test(repositoryRoot)) {
      throw new Error("repository root contains unsafe SSH configuration characters");
    }
    throw new Error("repository root must be an absolute canonical repository root");
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync.native(repositoryRoot);
  } catch {
    throw new Error("repository root must be an absolute canonical repository root");
  }
  if (canonicalRoot !== repositoryRoot || !lstatSync(canonicalRoot).isDirectory()) {
    throw new Error("repository root must be an absolute canonical repository root");
  }
  return fixturePaths(canonicalRoot);
}

function validateFixturePaths(paths: FixturePaths): void {
  const expected = resolveFixturePaths(paths.repositoryRoot);
  for (const key of Object.keys(expected) as Array<keyof FixturePaths>) {
    if (paths[key] !== expected[key]) throw new Error("fixture paths do not match the canonical repository root");
  }
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SSH port must be an integer from 1 through 65535");
  }
}

function currentUid(options: FixtureOwnershipOptions): number {
  if (options.currentUid !== undefined) return options.currentUid;
  if (process.getuid === undefined) throw new Error("SSH fixture state requires a platform with user ownership metadata");
  return process.getuid();
}

async function optionalMetadata(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertOwned(metadata: Stats, uid: number, label: string): void {
  if (metadata.uid !== uid) throw new Error(`${label} must be owned by the current user`);
}

function assertOwnerOnlyFile(metadata: Stats, uid: number, label: string): void {
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  assertOwned(metadata, uid, label);
  if (metadata.nlink !== 1) throw new Error(`${label} must have exactly one link`);
  if ((metadata.mode & 0o077) !== 0) throw new Error(`${label} must not be group- or world-accessible`);
}

function assertPrivateKey(metadata: Stats, uid: number, label: string): void {
  assertOwnerOnlyFile(metadata, uid, label);
  if ((metadata.mode & 0o177) !== 0) throw new Error(`${label} must have mode 0600 or stricter`);
}

function assertConfigFile(metadata: Stats, uid: number): void {
  const label = "SSH config";
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  assertOwned(metadata, uid, label);
  if (metadata.nlink !== 1) throw new Error(`${label} must have exactly one link`);
  if ((metadata.mode & 0o777) !== OWNER_ONLY_FILE_MODE) throw new Error(`${label} must have mode 0600`);
}

async function ensureStateParent(paths: FixturePaths): Promise<void> {
  const parent = dirname(paths.stateDir);
  let metadata = await optionalMetadata(parent);
  if (metadata === undefined) {
    try {
      await mkdir(parent, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    metadata = await optionalMetadata(parent);
  }
  if (metadata?.isSymbolicLink()) throw new Error("SSH fixture state parent must not be a symbolic link");
  if (metadata === undefined || !metadata.isDirectory()) throw new Error("SSH fixture state parent must be a directory");
}

async function ensureStateDirectory(paths: FixturePaths, uid: number): Promise<void> {
  await ensureStateParent(paths);
  let metadata = await optionalMetadata(paths.stateDir);
  if (metadata === undefined) {
    try {
      await mkdir(paths.stateDir, { mode: 0o700 });
      await chmod(paths.stateDir, 0o700);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    metadata = await optionalMetadata(paths.stateDir);
  }
  if (metadata?.isSymbolicLink()) throw new Error("SSH fixture state directory must not be a symbolic link");
  if (metadata === undefined || !metadata.isDirectory()) throw new Error("SSH fixture state directory must be a directory");
  assertOwned(metadata, uid, "SSH fixture state directory");
  if ((metadata.mode & 0o777) !== 0o700) throw new Error("SSH fixture state directory must have mode 0700");
}

async function validateOptionalFixtureFiles(paths: FixturePaths, uid: number): Promise<void> {
  const optionalFiles: ReadonlyArray<readonly [string, string, "config" | "owner-only"]> = [
    [paths.trustedHostKey, "trusted host key", "owner-only"],
    [paths.knownHosts, "known hosts file", "owner-only"],
    [paths.sshConfig, "SSH config", "config"],
  ];
  for (const [path, label, kind] of optionalFiles) {
    const metadata = await optionalMetadata(path);
    if (metadata === undefined) continue;
    if (kind === "config") assertConfigFile(metadata, uid);
    else assertOwnerOnlyFile(metadata, uid, label);
  }
}

function parsePublicKey(value: string, label: string): readonly [string, string] {
  const publicKeyLine = value.trim();
  const fields = publicKeyLine.split(/[\t ]+/u);
  if (fields.length < 2 || fields[0] !== "ssh-ed25519" || fields[1] === undefined || fields[1].length === 0) {
    throw new Error(`${label} is not a valid Ed25519 public key`);
  }
  if (publicKeyLine.includes("\n") || publicKeyLine.includes("\r")) {
    throw new Error(`${label} is not a valid Ed25519 public key`);
  }
  return [fields[0], fields[1]];
}

async function derivePublicKey(privateKey: string, runner: CommandRunner): Promise<readonly [string, string]> {
  let result: CommandResult;
  try {
    result = await runner("ssh-keygen", ["-y", "-f", privateKey]);
  } catch {
    throw new Error("SSH private key validation failed");
  }
  if (result.code !== 0 || result.signal !== null) throw new Error("SSH private key validation failed");
  const fields = result.stdout.trim().split(/\s+/u);
  if (fields.length !== 2) throw new Error("SSH private key validation produced an invalid public key");
  return parsePublicKey(result.stdout, "derived SSH public key");
}

async function validateKeyPair(privateKey: string, publicKey: string, runner: CommandRunner, uid: number, generated: boolean): Promise<void> {
  const [privateMetadata, publicMetadata] = await Promise.all([
    optionalMetadata(privateKey),
    optionalMetadata(publicKey),
  ]);
  const prefix = generated ? "generated " : "";
  if (privateMetadata === undefined || publicMetadata === undefined) {
    throw new Error(`${prefix}SSH keypair is incomplete`);
  }
  assertPrivateKey(privateMetadata, uid, `${prefix}private key`);
  assertOwnerOnlyFile(publicMetadata, uid, `${prefix}public key`);

  const derived = await derivePublicKey(privateKey, runner);
  let stored: readonly [string, string];
  try {
    stored = parsePublicKey(await readFile(publicKey, "utf8"), `${prefix}public key`);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("public key")) throw error;
    throw new Error(`${prefix}public key could not be read`);
  }
  if (derived[0] !== stored[0] || derived[1] !== stored[1]) {
    throw new Error(`${prefix}SSH public key does not match its private key`);
  }
}

async function generateKeyPair(paths: FixturePaths, runner: CommandRunner, uid: number): Promise<void> {
  const stagingDirectory = await mkdtemp(join(paths.stateDir, ".keygen-"));
  await chmod(stagingDirectory, 0o700);
  const stagingMetadata = await lstat(stagingDirectory);
  assertOwned(stagingMetadata, uid, "SSH key staging directory");
  if (!stagingMetadata.isDirectory() || (stagingMetadata.mode & 0o777) !== 0o700) {
    throw new Error("SSH key staging directory must have mode 0700");
  }
  const stagedPrivateKey = join(stagingDirectory, "id_ed25519");
  const stagedPublicKey = `${stagedPrivateKey}.pub`;
  let installedPublicKey = false;
  let installedPrivateKey = false;
  try {
    let result: CommandResult;
    try {
      result = await runner("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        SSH_ALIAS,
        "-f",
        stagedPrivateKey,
      ]);
    } catch {
      throw new Error("SSH key generation failed");
    }
    if (result.code !== 0 || result.signal !== null) throw new Error("SSH key generation failed");
    await validateKeyPair(stagedPrivateKey, stagedPublicKey, runner, uid, true);

    try {
      await link(stagedPublicKey, paths.publicKey);
      installedPublicKey = true;
      await unlink(stagedPublicKey);
      await link(stagedPrivateKey, paths.privateKey);
      installedPrivateKey = true;
      await unlink(stagedPrivateKey);
    } catch {
      if (installedPrivateKey) await rm(paths.privateKey, { force: true });
      if (installedPublicKey) await rm(paths.publicKey, { force: true });
      throw new Error("SSH keypair could not be installed safely");
    }

    const [privateMetadata, publicMetadata] = await Promise.all([
      lstat(paths.privateKey),
      lstat(paths.publicKey),
    ]);
    assertPrivateKey(privateMetadata, uid, "private key");
    assertOwnerOnlyFile(publicMetadata, uid, "public key");
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

export async function ensureFixtureState(
  paths: FixturePaths,
  runner: CommandRunner,
  options: FixtureOwnershipOptions = {},
): Promise<void> {
  validateFixturePaths(paths);
  const uid = currentUid(options);
  await ensureStateDirectory(paths, uid);
  await validateOptionalFixtureFiles(paths, uid);

  const [privateMetadata, publicMetadata] = await Promise.all([
    optionalMetadata(paths.privateKey),
    optionalMetadata(paths.publicKey),
  ]);
  if ((privateMetadata === undefined) !== (publicMetadata === undefined)) {
    throw new Error("SSH keypair is incomplete");
  }
  if (privateMetadata === undefined) {
    await generateKeyPair(paths, runner, uid);
    return;
  }
  await validateKeyPair(paths.privateKey, paths.publicKey, runner, uid, false);
}

export function formatSshConfig(paths: FixturePaths, port = DEFAULT_SSH_PORT): string {
  validateFixturePaths(paths);
  validatePort(port);
  return [
    `Host ${SSH_ALIAS}`,
    "  HostName 127.0.0.1",
    `  Port ${port}`,
    "  User codex",
    `  IdentityFile ${paths.privateKey}`,
    "  IdentitiesOnly yes",
    `  UserKnownHostsFile ${paths.knownHosts}`,
    "  StrictHostKeyChecking yes",
    "  BatchMode yes",
    "  PasswordAuthentication no",
    "  KbdInteractiveAuthentication no",
    "  ForwardAgent no",
    "  ClearAllForwardings yes",
    "",
  ].join("\n");
}

export async function writeSshConfig(
  paths: FixturePaths,
  port = DEFAULT_SSH_PORT,
  options: FixtureOwnershipOptions = {},
): Promise<void> {
  validateFixturePaths(paths);
  validatePort(port);
  const uid = currentUid(options);
  await ensureStateDirectory(paths, uid);
  const existing = await optionalMetadata(paths.sshConfig);
  if (existing !== undefined) assertConfigFile(existing, uid);

  const temporaryPath = join(paths.stateDir, `.config-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", OWNER_ONLY_FILE_MODE);
    await handle.chmod(OWNER_ONLY_FILE_MODE);
    await handle.writeFile(formatSshConfig(paths, port), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    assertConfigFile(await lstat(temporaryPath), uid);
    await rename(temporaryPath, paths.sshConfig);
    assertConfigFile(await lstat(paths.sshConfig), uid);
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
}

export function buildSshArgs(paths: FixturePaths, remoteCommand: readonly string[]): string[] {
  validateFixturePaths(paths);
  return ["-F", paths.sshConfig, SSH_ALIAS, ...remoteCommand];
}
