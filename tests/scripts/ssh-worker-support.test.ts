import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  DEFAULT_CODEX_VERSION,
  DEFAULT_SSH_PORT,
  SSH_ALIAS,
  buildSshArgs,
  ensureFixtureState,
  formatSshConfig,
  resolveFixturePaths,
  writeSshConfig,
  type CommandRunner,
  type FixturePaths,
} from "../../scripts/ssh-worker-support.ts";

const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestFixtureKey";

async function temporaryRepository(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qiyan-ssh-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return realpath(root);
}

function successfulResult(stdout = "") {
  return { code: 0, signal: null, stdout, stderr: "" } as const;
}

function stagingRunner(calls: Array<{ command: string; args: readonly string[] }>, options: {
  createPublicKey?: boolean;
  derivedPublicKey?: string;
} = {}): CommandRunner {
  return async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command !== "ssh-keygen") return successfulResult();

    const outputPathIndex = args.indexOf("-f");
    assert.notEqual(outputPathIndex, -1);
    const keyPath = args[outputPathIndex + 1];
    assert.ok(keyPath);
    if (args.includes("-y")) return successfulResult(`${options.derivedPublicKey ?? PUBLIC_KEY}\n`);

    await writeFile(keyPath, "opaque-test-private-key", { mode: 0o600 });
    if (options.createPublicKey !== false) {
      await writeFile(`${keyPath}.pub`, `${PUBLIC_KEY} qiyan-ssh-worker\n`, { mode: 0o644 });
    }
    return successfulResult();
  };
}

async function installExistingPair(paths: FixturePaths, publicKey = PUBLIC_KEY): Promise<void> {
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  await chmod(paths.stateDir, 0o700);
  await writeFile(paths.privateKey, "opaque-test-private-key", { mode: 0o600 });
  await writeFile(paths.publicKey, `${publicKey} a comment that is ignored\n`, { mode: 0o600 });
}

test("resolves every fixture path beneath a canonical repository root", async (t) => {
  const root = await temporaryRepository(t);
  const stateDir = join(root, ".tmp", "ssh-worker");

  assert.equal(DEFAULT_SSH_PORT, 2222);
  assert.equal(DEFAULT_CODEX_VERSION, "0.142.5");
  assert.equal(SSH_ALIAS, "qiyan-ssh-worker");
  assert.deepEqual(resolveFixturePaths(root), {
    repositoryRoot: root,
    composeFile: join(root, "docker", "ssh-worker", "compose.yaml"),
    stateDir,
    privateKey: join(stateDir, "id_ed25519"),
    publicKey: join(stateDir, "id_ed25519.pub"),
    trustedHostKey: join(stateDir, "trusted-host-key.pub"),
    knownHosts: join(stateDir, "known_hosts"),
    sshConfig: join(stateDir, "config"),
  });
});

test("rejects relative, non-normalized, aliased, and config-hostile repository roots", async (t) => {
  const root = await temporaryRepository(t);
  assert.throws(() => resolveFixturePaths("relative/repository"), /absolute canonical repository root/u);
  assert.throws(() => resolveFixturePaths(`${root}/../${root.split("/").at(-1) ?? ""}`), /absolute canonical repository root/u);

  const alias = `${root}-alias`;
  await symlink(root, alias, "dir");
  t.after(() => rm(alias, { force: true }));
  assert.throws(() => resolveFixturePaths(alias), /absolute canonical repository root/u);

  const hostile = `${root}\nHost attacker`;
  await mkdir(hostile);
  t.after(() => rm(hostile, { recursive: true, force: true }));
  assert.throws(() => resolveFixturePaths(hostile), /SSH configuration characters/u);
});

test("formats one strict alias without ambient configuration or identities", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  assert.equal(formatSshConfig(paths, 2222), [
    "Host qiyan-ssh-worker",
    "  HostName 127.0.0.1",
    "  Port 2222",
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
  ].join("\n"));

  const config = formatSshConfig(paths, DEFAULT_SSH_PORT);
  assert.equal(config.match(/^Host /gmu)?.length, 1);
  assert.doesNotMatch(config, /StrictHostKeyChecking no|UserKnownHostsFile \/dev\/null|IdentityFile ~|Include /u);
});

test("rejects invalid ports and forged paths that could inject SSH configuration", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  for (const port of [0, 65_536, -1, 22.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => formatSshConfig(paths, port), /port must be an integer from 1 through 65535/u);
  }
  const forged = { ...paths, knownHosts: `${paths.knownHosts}\nStrictHostKeyChecking no` };
  assert.throws(() => formatSshConfig(forged, 2222), /fixture paths do not match/u);
});

test("builds SSH arguments with only the dedicated config before the fixed alias", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  assert.deepEqual(buildSshArgs(paths, ["true"]), ["-F", paths.sshConfig, "qiyan-ssh-worker", "true"]);
  assert.deepEqual(buildSshArgs(paths, ["printf", "%s", "-oProxyCommand=attacker"]), [
    "-F", paths.sshConfig, "qiyan-ssh-worker", "printf", "%s", "-oProxyCommand=attacker",
  ]);
});

test("stages, validates, and installs a new owner-only keypair", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const runner = stagingRunner(calls);
  const inspectingRunner: CommandRunner = async (command, args, options) => {
    if (!args.includes("-y")) {
      await assert.rejects(lstat(paths.privateKey));
      await assert.rejects(lstat(paths.publicKey));
      const stagedPath = args[args.indexOf("-f") + 1];
      assert.ok(stagedPath);
      assert.notEqual(stagedPath, paths.privateKey);
      assert.equal(dirname(stagedPath).startsWith(`${paths.stateDir}/.keygen-`), true);
    }
    return runner(command, args, options);
  };

  await ensureFixtureState(paths, inspectingRunner);

  assert.equal((await lstat(paths.stateDir)).mode & 0o777, 0o700);
  for (const keyPath of [paths.privateKey, paths.publicKey]) {
    const metadata = await lstat(keyPath);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.nlink, 1);
    assert.equal(metadata.mode & 0o777, 0o600);
  }
  assert.equal((await lstat(paths.publicKey)).mode & 0o777, 0o600);
  const stagedPrivateKey = calls[0]?.args.at(-1);
  assert.ok(stagedPrivateKey);
  assert.deepEqual(calls, [
    {
      command: "ssh-keygen",
      args: ["-q", "-t", "ed25519", "-N", "", "-C", "qiyan-ssh-worker", "-f", stagedPrivateKey],
    },
    { command: "ssh-keygen", args: ["-y", "-f", stagedPrivateKey] },
  ]);
  assert.equal((await readFile(paths.publicKey, "utf8")).trim(), `${PUBLIC_KEY} qiyan-ssh-worker`);
  assert.deepEqual(await readdir(paths.stateDir), [
    "id_ed25519",
    "id_ed25519.pub",
  ]);
});

test("validates an existing pair by algorithm and blob while ignoring its comment", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  await installExistingPair(paths);
  const calls: Array<{ command: string; args: readonly string[] }> = [];

  await ensureFixtureState(paths, stagingRunner(calls));

  assert.deepEqual(calls, [{ command: "ssh-keygen", args: ["-y", "-f", paths.privateKey] }]);

  await writeFile(paths.publicKey, `${PUBLIC_KEY} first comment\n${PUBLIC_KEY} second key\n`, { mode: 0o600 });
  await assert.rejects(ensureFixtureState(paths, stagingRunner([])), /not a valid Ed25519 public key/u);
});

test("fails closed for missing or mismatched public keys without returning key material", async (t) => {
  const missing = resolveFixturePaths(await temporaryRepository(t));
  await mkdir(missing.stateDir, { recursive: true, mode: 0o700 });
  await writeFile(missing.privateKey, "opaque-test-private-key", { mode: 0o600 });
  await assert.rejects(ensureFixtureState(missing, stagingRunner([])), /keypair is incomplete/u);

  const generatedMissing = resolveFixturePaths(await temporaryRepository(t));
  await assert.rejects(
    ensureFixtureState(generatedMissing, stagingRunner([], { createPublicKey: false })),
    /generated SSH keypair is incomplete/u,
  );
  await assert.rejects(lstat(generatedMissing.privateKey));
  await assert.rejects(lstat(generatedMissing.publicKey));

  const mismatched = resolveFixturePaths(await temporaryRepository(t));
  await installExistingPair(mismatched);
  await assert.rejects(
    ensureFixtureState(mismatched, stagingRunner([], { derivedPublicKey: "ssh-ed25519 AAAADIFFERENT" })),
    (error: unknown) => {
      assert.doesNotMatch(String(error), /opaque-test-private-key|AAAAC3Nza|AAAADIFFERENT/u);
      return /does not match/u.test(String(error));
    },
  );
});

test("rejects symlinked, incorrectly owned, accessible, special, and hard-linked fixture state", async (t) => {
  const symlinkPaths = resolveFixturePaths(await temporaryRepository(t));
  const external = await mkdtemp(join(tmpdir(), "qiyan-ssh-external-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await mkdir(dirname(symlinkPaths.stateDir), { recursive: true });
  await symlink(external, symlinkPaths.stateDir, "dir");
  await assert.rejects(ensureFixtureState(symlinkPaths, stagingRunner([])), /state directory must not be a symbolic link/u);

  const modePaths = resolveFixturePaths(await temporaryRepository(t));
  await mkdir(modePaths.stateDir, { recursive: true, mode: 0o755 });
  await chmod(modePaths.stateDir, 0o755);
  await assert.rejects(ensureFixtureState(modePaths, stagingRunner([])), /state directory must have mode 0700/u);

  const uidPaths = resolveFixturePaths(await temporaryRepository(t));
  await mkdir(uidPaths.stateDir, { recursive: true, mode: 0o700 });
  const actualUid = (await lstat(uidPaths.stateDir)).uid;
  await assert.rejects(
    ensureFixtureState(uidPaths, stagingRunner([]), { currentUid: actualUid + 1 }),
    /state directory must be owned by the current user/u,
  );

  const specialPaths = resolveFixturePaths(await temporaryRepository(t));
  await mkdir(specialPaths.stateDir, { recursive: true, mode: 0o700 });
  await mkdir(specialPaths.privateKey, { mode: 0o700 });
  await writeFile(specialPaths.publicKey, `${PUBLIC_KEY}\n`, { mode: 0o600 });
  await assert.rejects(ensureFixtureState(specialPaths, stagingRunner([])), /private key must be a regular file/u);

  const accessiblePaths = resolveFixturePaths(await temporaryRepository(t));
  await installExistingPair(accessiblePaths);
  await chmod(accessiblePaths.privateKey, 0o640);
  await assert.rejects(ensureFixtureState(accessiblePaths, stagingRunner([])), /private key must not be group- or world-accessible/u);

  const hardLinkPaths = resolveFixturePaths(await temporaryRepository(t));
  await installExistingPair(hardLinkPaths);
  await link(hardLinkPaths.publicKey, join(hardLinkPaths.stateDir, "second-public-link"));
  await assert.rejects(ensureFixtureState(hardLinkPaths, stagingRunner([])), /public key must have exactly one link/u);
});

test("rejects a symlink in the state directory parent", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  const external = await mkdtemp(join(tmpdir(), "qiyan-ssh-parent-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await symlink(external, dirname(paths.stateDir), "dir");
  await assert.rejects(ensureFixtureState(paths, stagingRunner([])), /state parent must not be a symbolic link/u);
});

test("writes and replaces the SSH config atomically as an owner-only regular file", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  await ensureFixtureState(paths, stagingRunner([]));

  await writeSshConfig(paths, 2222);
  assert.equal(await readFile(paths.sshConfig, "utf8"), formatSshConfig(paths, 2222));
  let metadata = await lstat(paths.sshConfig);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.nlink, 1);
  assert.equal(metadata.mode & 0o777, 0o600);

  await writeSshConfig(paths, 2200);
  assert.match(await readFile(paths.sshConfig, "utf8"), /^  Port 2200$/mu);
  metadata = await lstat(paths.sshConfig);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.deepEqual(await readdir(paths.stateDir), [
    "config",
    "id_ed25519",
    "id_ed25519.pub",
  ]);
});

test("config replacement rejects symlinks, special files, hard links, wrong modes, and wrong owners", async (t) => {
  const symlinkPaths = resolveFixturePaths(await temporaryRepository(t));
  await ensureFixtureState(symlinkPaths, stagingRunner([]));
  await symlink("missing", symlinkPaths.sshConfig);
  await assert.rejects(writeSshConfig(symlinkPaths), /SSH config must be a regular file/u);

  const specialPaths = resolveFixturePaths(await temporaryRepository(t));
  await ensureFixtureState(specialPaths, stagingRunner([]));
  await mkdir(specialPaths.sshConfig, { mode: 0o700 });
  await assert.rejects(writeSshConfig(specialPaths), /SSH config must be a regular file/u);

  const hardLinkPaths = resolveFixturePaths(await temporaryRepository(t));
  await ensureFixtureState(hardLinkPaths, stagingRunner([]));
  await writeFile(hardLinkPaths.sshConfig, "old", { mode: 0o600 });
  await link(hardLinkPaths.sshConfig, join(hardLinkPaths.stateDir, "config-link"));
  await assert.rejects(writeSshConfig(hardLinkPaths), /SSH config must have exactly one link/u);

  const modePaths = resolveFixturePaths(await temporaryRepository(t));
  await ensureFixtureState(modePaths, stagingRunner([]));
  await writeFile(modePaths.sshConfig, "old", { mode: 0o644 });
  await assert.rejects(writeSshConfig(modePaths), /SSH config must have mode 0600/u);

  const ownerPaths = resolveFixturePaths(await temporaryRepository(t));
  await ensureFixtureState(ownerPaths, stagingRunner([]));
  await writeFile(ownerPaths.sshConfig, "old", { mode: 0o600 });
  const actualUid = (await lstat(ownerPaths.sshConfig)).uid;
  await assert.rejects(
    writeSshConfig(ownerPaths, 2222, { currentUid: actualUid + 1 }),
    /must be owned by the current user/u,
  );
});
