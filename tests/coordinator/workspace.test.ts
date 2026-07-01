import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { formatStartupError } from "../../src/cli.ts";
import { prepareCoordinatorWorkspace, type CoordinatorWorkspaceOptions } from "../../src/coordinator/workspace.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixtureWithTemplates(policy: string, options: { nestedInGit?: boolean } = {}): Promise<{
  workdir: string;
  policyTemplate: string;
  options: CoordinatorWorkspaceOptions;
}> {
  const root = await mkdtemp(join(tmpdir(), "codex-bot-workspace-"));
  const assets = join(root, "assets");
  const gitRoot = join(root, "project");
  const workdir = options.nestedInGit ? join(gitRoot, "manager") : join(root, "manager");
  await mkdir(assets, { recursive: true });
  if (options.nestedInGit) await mkdir(join(gitRoot, ".git"), { recursive: true });
  const policyTemplate = join(assets, "AGENTS.md");
  const notebookTemplate = join(assets, "session-status.example.json");
  const dataDir = join(root, "backend-data");
  const registryPath = join(root, "backend-registry", "sessions.json");
  await writeFile(policyTemplate, policy);
  await writeFile(notebookTemplate, '{"version":1,"sessions":{}}\n');
  return {
    workdir,
    policyTemplate,
    options: { workdir, dataDir, registryPath, policyTemplatePath: policyTemplate, notebookTemplatePath: notebookTemplate },
  };
}

test("installs the managed policy, digest, and notebook in a new workspace", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  const prepared = await prepareCoordinatorWorkspace(fixture.options);
  assert.equal(await readFile(join(prepared.root, "AGENTS.md"), "utf8"), "policy-v1\n");
  assert.equal((await readFile(join(prepared.root, ".codex-bot-agents.sha256"), "utf8")).trim(), sha256("policy-v1\n"));
  assert.deepEqual(prepared.notebook.snapshot(), { version: 1, sessions: {} });
});

test("upgrades an unmodified managed policy", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  await prepareCoordinatorWorkspace(fixture.options);
  await writeFile(fixture.policyTemplate, "policy-v2\n");
  await prepareCoordinatorWorkspace(fixture.options);
  assert.equal(await readFile(join(fixture.workdir, "AGENTS.md"), "utf8"), "policy-v2\n");
});

test("rejects a modified managed policy without overwriting it", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  await prepareCoordinatorWorkspace(fixture.options);
  await writeFile(join(fixture.workdir, "AGENTS.md"), "my edits\n");
  await assert.rejects(prepareCoordinatorWorkspace(fixture.options), /AGENTS\.md is managed.*AGENTS\.override\.md/);
  assert.equal(await readFile(join(fixture.workdir, "AGENTS.md"), "utf8"), "my edits\n");
});

test("adopts an unhashed policy only when it exactly matches the packaged policy", async () => {
  const matching = await fixtureWithTemplates("policy-v1\n");
  await mkdir(matching.workdir, { recursive: true });
  await writeFile(join(matching.workdir, "AGENTS.md"), "policy-v1\n");
  await prepareCoordinatorWorkspace(matching.options);
  assert.equal((await readFile(join(matching.workdir, ".codex-bot-agents.sha256"), "utf8")).trim(), sha256("policy-v1\n"));

  const differing = await fixtureWithTemplates("policy-v1\n");
  await mkdir(differing.workdir, { recursive: true });
  await writeFile(join(differing.workdir, "AGENTS.md"), "unknown\n");
  await assert.rejects(prepareCoordinatorWorkspace(differing.options), /has no bot digest/);
});

test("rejects a missing policy when its digest remains", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  await prepareCoordinatorWorkspace(fixture.options);
  await rm(join(fixture.workdir, "AGENTS.md"));
  await assert.rejects(prepareCoordinatorWorkspace(fixture.options), /digest exists but AGENTS\.md is missing/);
});

test("does not inspect or alter AGENTS.override.md", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  await mkdir(fixture.workdir, { recursive: true });
  await symlink("missing-user-owned-target", join(fixture.workdir, "AGENTS.override.md"));
  await prepareCoordinatorWorkspace(fixture.options);
  assert.equal(await readlink(join(fixture.workdir, "AGENTS.override.md")), "missing-user-owned-target");
});

test("preserves an existing valid manager notebook", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  await mkdir(fixture.workdir, { recursive: true });
  const notebook = '{"version":1,"sessions":{"project":{"thread_id":"t1","project_status":"working","updated_at":"now"}}}\n';
  await writeFile(join(fixture.workdir, "session-status.json"), notebook);
  await prepareCoordinatorWorkspace(fixture.options);
  assert.equal(await readFile(join(fixture.workdir, "session-status.json"), "utf8"), notebook);
});

test("warns when the workspace has a Git ancestor", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n", { nestedInGit: true });
  const prepared = await prepareCoordinatorWorkspace(fixture.options);
  assert.match(prepared.warnings.join("\n"), /Git worktree.*parent instructions/);
});

test("rejects direct, nested, and symlink-equivalent overlap with backend state", async () => {
  const direct = await fixtureWithTemplates("policy-v1\n");
  await assert.rejects(prepareCoordinatorWorkspace({ ...direct.options, dataDir: direct.workdir }), /must be separate from backend state/);

  const nested = await fixtureWithTemplates("policy-v1\n");
  await assert.rejects(prepareCoordinatorWorkspace({ ...nested.options, dataDir: join(nested.workdir, "data") }), /must be separate from backend state/);

  const aliased = await fixtureWithTemplates("policy-v1\n");
  const actualData = join(dirname(aliased.workdir), "actual-data");
  const dataAlias = join(dirname(aliased.workdir), "data-alias");
  await mkdir(actualData, { recursive: true });
  await symlink(actualData, dataAlias, "dir");
  await assert.rejects(prepareCoordinatorWorkspace({ ...aliased.options, workdir: join(actualData, "manager"), dataDir: dataAlias }), /must be separate from backend state/);
});

test("rejects a backend alias located inside the canonical coordinator tree", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  await mkdir(fixture.workdir, { recursive: true });
  const safeBackend = join(dirname(fixture.workdir), "safe-backend");
  await mkdir(safeBackend, { recursive: true });
  const mutableAlias = join(fixture.workdir, "data-link");
  await symlink(safeBackend, mutableAlias, "dir");
  await assert.rejects(prepareCoordinatorWorkspace({ ...fixture.options, dataDir: mutableAlias }), /configured data directory.*must be separate/);
});

test("returns canonical backend paths for exclusive production use", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  const safeBackend = join(dirname(fixture.workdir), "safe-backend");
  const externalAlias = join(dirname(fixture.workdir), "external-data-link");
  await mkdir(safeBackend, { recursive: true });
  await symlink(safeBackend, externalAlias, "dir");
  const prepared = await prepareCoordinatorWorkspace({ ...fixture.options, dataDir: externalAlias });
  assert.equal(prepared.dataRoot, await realpath(safeBackend));
  assert.notEqual(prepared.dataRoot, externalAlias);
});

test("rejects a registry path inside the coordinator workspace", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  await assert.rejects(prepareCoordinatorWorkspace({ ...fixture.options, registryPath: join(fixture.workdir, "sessions.json") }), /coordinator workdir.*registry/);
});

test("reports an unusable workdir without exposing the raw filesystem failure", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  const blockingFile = join(dirname(fixture.workdir), "not-a-directory");
  await writeFile(blockingFile, "private contents");
  let failure: unknown;
  try { await prepareCoordinatorWorkspace({ ...fixture.options, workdir: join(blockingFile, "manager") }); }
  catch (error) { failure = error; }
  assert.equal(formatStartupError(failure), `CONFIGURATION_ERROR: cannot prepare coordinator workdir ${join(blockingFile, "manager")}`);
  assert.doesNotMatch(formatStartupError(failure), /ENOTDIR|private contents/);
});
