# External Coordinator Workdir Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the coordinator from an explicit external workdir, guard its bot-managed `AGENTS.md` with a stored digest, support a user-owned `AGENTS.override.md`, and replace the thin coordinator prompt with a complete management playbook.

**Architecture:** Parse `--workdir` before configuration loading and store the canonical requested path in `BotConfig`. A focused coordinator-workspace bootstrapper creates the directory, verifies or upgrades the managed policy using `.codex-bot-agents.sha256`, initializes the notebook, and reports Git-parent warnings before app-server startup. Production composition consumes that prepared workspace instead of deriving coordinator state from the source checkout; packaged policy/example assets remain read-only inputs.

**Tech Stack:** TypeScript 6, Node.js 24 (`node:test`, `node:fs/promises`, `node:crypto`), Zod 4, Codex app-server, existing SQLite/Telegram runtime.

---

## File structure

- Create `src/cli.ts`: strict `--workdir` parsing and safe startup-error formatting.
- Modify `src/config.ts`: environment fallback, CLI precedence, and `coordinatorWorkdir` configuration.
- Modify `src/main.ts`: parse arguments and print only sanitized fatal startup errors.
- Create `src/coordinator/workspace.ts`: canonicalization, managed policy/hash state machine, atomic writes, notebook initialization, and Git-parent warning.
- Create `assets/coordinator/AGENTS.md`: detailed bot-managed coordinator operating playbook.
- Create `assets/coordinator/session-status.example.json`: packaged notebook seed.
- Delete `coordinator/AGENTS.override.md` and `coordinator/session-status.example.json`: remove runtime assets from the source-owned coordinator cwd.
- Delete `coordinator/.gitignore`: the source checkout no longer owns a live coordinator notebook.
- Modify `.gitignore`: keep the existing ignored legacy notebook protected after deleting its nested ignore file.
- Modify `src/production-app.ts`: add workspace preparation as the first phase and use its canonical path/notebook/warnings.
- Create `tests/production-startup.test.ts`: prove the real production composition prepares the external workspace before endpoint startup and persists its canonical identity.
- Modify `src/coordinator/notebook.ts`: initialize only an absent notebook and preserve invalid existing bytes.
- Modify `.env.example` and `README.md`: document the external workdir, policy ownership, customization, backup, and repair workflow.
- Create `tests/cli.test.ts`, `tests/coordinator/workspace.test.ts`, and `tests/coordinator/policy.test.ts`; modify `tests/config.test.ts`.

### Task 1: CLI and configuration contract

**Files:**
- Create: `tests/cli.test.ts`
- Modify: `tests/config.test.ts`
- Create: `src/cli.ts`
- Modify: `src/config.ts`
- Modify: `src/main.ts`
- Modify: `src/core/errors.ts`

- [ ] **Step 1: Write failing CLI and configuration tests**

Create `tests/cli.test.ts` with focused cases:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { formatStartupError, parseCliArgs } from "../src/cli.ts";
import { AppError } from "../src/core/errors.ts";

test("parses an explicit coordinator workdir", () => {
  assert.deepEqual(parseCliArgs(["--workdir", "./manager"]), { coordinatorWorkdir: "./manager" });
});

test("rejects missing, repeated, and unknown CLI arguments", () => {
  assert.throws(() => parseCliArgs(["--workdir"]), /requires a path/);
  assert.throws(() => parseCliArgs(["--workdir", "one", "--workdir", "two"]), /only once/);
  assert.throws(() => parseCliArgs(["--unknown"]), /unknown argument/);
});

test("does not echo an unknown argument into a startup error", () => {
  let failure: unknown;
  try { parseCliArgs(["--unknown=secret-token"]); } catch (error) { failure = error; }
  assert.equal(formatStartupError(failure), "CONFIGURATION_ERROR: unknown argument");
  assert.doesNotMatch(formatStartupError(failure), /secret-token/);
});

test("formats only known user-facing startup failures", () => {
  assert.equal(formatStartupError(new AppError("CONFIGURATION_ERROR", "managed file changed")), "CONFIGURATION_ERROR: managed file changed");
  assert.equal(formatStartupError(new Error("request contained secret-token")), "startup failed");
});
```

Refactor `tests/config.test.ts` around a helper that includes `COORDINATOR_WORKDIR`, then add:

```ts
test("loadConfig requires a coordinator workdir", () => {
  assert.throws(() => loadConfig(baseEnv({ COORDINATOR_WORKDIR: undefined })), /COORDINATOR_WORKDIR/);
});

test("CLI workdir overrides the environment and resolves from the launch directory", () => {
  const config = loadConfig(baseEnv({ COORDINATOR_WORKDIR: "from-env" }), { coordinatorWorkdir: "from-cli" });
  assert.equal(config.coordinatorWorkdir, resolve("from-cli"));
});
```

- [ ] **Step 2: Run the tests and verify the expected red state**

Run:

```bash
npm test -- tests/cli.test.ts tests/config.test.ts
```

Expected: FAIL because `src/cli.ts`, `CONFIGURATION_ERROR`, the override parameter, and `BotConfig.coordinatorWorkdir` do not exist.

- [ ] **Step 3: Implement strict parsing and configuration precedence**

Add `CONFIGURATION_ERROR` to `ErrorCode` in `src/core/errors.ts`.

Implement `src/cli.ts`:

```ts
import { z } from "zod";
import { AppError } from "./core/errors.ts";

export interface CliOptions { coordinatorWorkdir?: string }

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let coordinatorWorkdir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument !== "--workdir") throw new AppError("CONFIGURATION_ERROR", "unknown argument");
    if (coordinatorWorkdir !== undefined) throw new AppError("CONFIGURATION_ERROR", "--workdir may be specified only once");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new AppError("CONFIGURATION_ERROR", "--workdir requires a path");
    coordinatorWorkdir = value;
    index += 1;
  }
  return coordinatorWorkdir === undefined ? {} : { coordinatorWorkdir };
}

export function formatStartupError(error: unknown): string {
  if (error instanceof AppError && error.code === "CONFIGURATION_ERROR") return `${error.code}: ${error.message}`;
  if (error instanceof z.ZodError) {
    const issues = error.issues.map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`).join("; ");
    return `CONFIGURATION_ERROR: ${issues}`;
  }
  return "startup failed";
}
```

In `src/config.ts`, add optional `COORDINATOR_WORKDIR` to the Zod input, add `coordinatorWorkdir` to `BotConfig`, and change the API to:

```ts
export interface ConfigOverrides { coordinatorWorkdir?: string }

export function loadConfig(
  env: Record<string, string | undefined>,
  overrides: ConfigOverrides = {},
): BotConfig {
  const parsed = configSchema.parse(env);
  const workdir = overrides.coordinatorWorkdir ?? parsed.COORDINATOR_WORKDIR;
  if (!workdir) throw new AppError("CONFIGURATION_ERROR", "COORDINATOR_WORKDIR or --workdir is required");
  return {
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    telegramOwnerId: parsed.TELEGRAM_OWNER_ID,
    telegramDestinationChatId: parsed.TELEGRAM_DESTINATION_CHAT_ID,
    coordinatorWorkdir: resolve(workdir),
    dataDir: resolve(parsed.DATA_DIR),
    sessionRegistryPath: resolve(parsed.SESSION_REGISTRY_PATH),
    codexBinary: parsed.CODEX_BINARY,
    maxConcurrentTurns: parsed.MAX_CONCURRENT_TURNS,
    maxCollectCount: parsed.MAX_COLLECT_COUNT,
    mcpHost: parsed.MCP_HOST,
    mcpPort: parsed.MCP_PORT,
    attachmentMaxBytes: parsed.ATTACHMENT_MAX_BYTES,
    attachmentStoreMaxBytes: parsed.ATTACHMENT_STORE_MAX_BYTES,
    sandboxMode: parsed.SANDBOX_MODE,
  };
}
```

Update `src/main.ts` to pass `process.argv.slice(2)` through the parser and report only formatted failures:

```ts
export async function main(env = process.env, argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const app = await createApp(loadConfig(env, parseCliArgs(argv)));
  await app.start();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void app.stop().catch(() => { process.exitCode = 1; });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    process.stderr.write(`codex-bot: ${formatStartupError(error)}\n`);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Verify the CLI/config tests pass**

Run:

```bash
npm test -- tests/cli.test.ts tests/config.test.ts
npm run typecheck
```

Expected: both commands PASS.

- [ ] **Step 5: Commit the CLI/config slice**

```bash
git add src/cli.ts src/config.ts src/main.ts src/core/errors.ts tests/cli.test.ts tests/config.test.ts
git commit -m "feat: configure external coordinator workdir"
```

### Task 2: Hash-guarded coordinator workspace

**Files:**
- Create: `tests/coordinator/workspace.test.ts`
- Create: `src/coordinator/workspace.ts`
- Modify: `tests/coordinator/notebook.test.ts`
- Modify: `src/coordinator/notebook.ts`

- [ ] **Step 1: Write the workspace state-machine tests**

Use temporary directories and temporary template files to cover these independent behaviors:

```ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
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

test("rejects a registry path inside the coordinator workspace", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  await assert.rejects(prepareCoordinatorWorkspace({ ...fixture.options, registryPath: join(fixture.workdir, "sessions.json") }), /registry.*coordinator workdir/);
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
```

The fixture must create a policy template and `session-status.example.json` outside the target workdir. Add a separate restart assertion proving an existing valid notebook is not replaced. Replace the current notebook quarantine test with a regression that writes invalid bytes, expects `CoordinatorNotebook.bootstrap` to reject with the notebook path, and proves those bytes remain unchanged and no `.invalid-*` file is created.

- [ ] **Step 2: Run the workspace tests and verify they fail**

Run:

```bash
npm test -- tests/coordinator/workspace.test.ts
```

Expected: FAIL because `prepareCoordinatorWorkspace` does not exist.

- [ ] **Step 3: Implement the managed workspace state machine**

Create `src/coordinator/workspace.ts` with:

```ts
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, sep } from "node:path";
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
  notebook: CoordinatorNotebook;
  warnings: string[];
}

export async function prepareCoordinatorWorkspace(options: CoordinatorWorkspaceOptions): Promise<PreparedCoordinatorWorkspace> {
  try {
    await mkdir(options.workdir, { recursive: true, mode: 0o700 });
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    await mkdir(dirname(options.registryPath), { recursive: true, mode: 0o700 });
    const root = await realpath(options.workdir);
    const dataRoot = await realpath(options.dataDir);
    const registryPath = await canonicalFilePath(options.registryPath);
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
    throw managedError(`${digestPath} exists but AGENTS.md is missing`);
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
  return { root, notebook, warnings };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw managedError(`cannot prepare coordinator workdir ${options.workdir}`);
  }
}
```

Keep the implementation body indented inside the `try`. Add canonical containment helpers:

```ts
async function canonicalFilePath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
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
```

The error message for the registry check must contain both “registry” and “coordinator workdir”; the generic data message must contain “must be separate from backend state.”

Implement the helpers as:

```ts
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
```

Change `CoordinatorNotebook.bootstrap` so only `ENOENT` initializes from the example. Parse existing bytes outside the `ENOENT` handler. Wrap unreadable/invalid existing notebooks in `AppError("CONFIGURATION_ERROR", `invalid coordinator notebook ${path}`)` without renaming or writing the live file. Initialize a missing notebook through the existing atomic JSON writer so its mode is 0600.

- [ ] **Step 4: Verify workspace behavior and types**

Run:

```bash
npm test -- tests/coordinator/workspace.test.ts tests/coordinator/notebook.test.ts
npm run typecheck
```

Expected: PASS with no warnings or leaked temporary files.

- [ ] **Step 5: Commit the workspace bootstrapper**

```bash
git add src/coordinator/workspace.ts tests/coordinator/workspace.test.ts src/coordinator/notebook.ts tests/coordinator/notebook.test.ts
git commit -m "feat: guard coordinator workspace policy"
```

### Task 3: Package the detailed coordinator policy

**Files:**
- Create: `tests/coordinator/policy.test.ts`
- Create: `assets/coordinator/AGENTS.md`
- Create: `assets/coordinator/session-status.example.json`
- Delete: `coordinator/AGENTS.override.md`
- Delete: `coordinator/session-status.example.json`
- Delete: `coordinator/.gitignore`
- Modify: `.gitignore`

- [ ] **Step 1: Write a failing policy contract test**

Create `tests/coordinator/policy.test.ts`. Read `assets/coordinator/AGENTS.md` and assert that it:

- contains the section headings `Routing`, `Live state and lifecycle`, `Worker results and supervision`, `Exact directives`, `Models, effort, goals, and interruption`, `Attachments and failures`, and `Manager notebook`;
- names all coordinator MCP tools from `TOOL_NAMES` at least once, either individually or in an explicit catalog;
- states that worker finals are automatically delivered and must not be duplicated;
- states that `/pass` payload and attachments are exact and `/collect` is directly delivered;
- states that `set_goal` replaces the current goal and the coordinator never completes a goal;
- states that tool receipts, not assumptions, prove side effects;
- contains neither `codex-bot:managed` nor `codex-bot:user` marker comments; and
- is longer and materially more detailed than the old short policy (minimum 2,500 UTF-8 bytes).

- [ ] **Step 2: Run the policy test and verify it fails**

Run:

```bash
npm test -- tests/coordinator/policy.test.ts
```

Expected: FAIL because the packaged `assets/coordinator/AGENTS.md` does not exist.

- [ ] **Step 3: Create the packaged policy and notebook seed**

Write `assets/coordinator/AGENTS.md` with the following complete structure and rules:

```md
# Coordinator role

You are the user's general assistant and the manager of ordinary Codex project sessions. Keep management updates concise, make project routing explicit, and rely on backend receipts and live app-server state rather than assumptions.

## Routing

- Answer general questions directly when no project execution is needed.
- For project work, prefer an explicit nickname. Otherwise use managed project metadata, recent context, and live status. Ask the user when more than one target remains plausible.
- Use `list_managed_sessions` for registered projects and `discover_sessions` for ordinary Codex threads not yet managed. Use `create_session` only for new work; use `adopt_session` or `register_session` when continuity with an existing thread is requested.
- Assign short unique nicknames, tell the user when assigning one, and never silently repoint a nickname to another thread, endpoint, or directory. Use `rename_session` only when the requested identity remains unambiguous.

## Live state and lifecycle

- Backend registry and app-server state are authoritative. Check `get_session_status` before state-changing actions.
- Use `attach_session`, `detach_session`, and `archive_session` only when their live-state preconditions are satisfied. Explain a blocked transition instead of pretending it occurred.
- In `send_to_session`, use `start` to begin work from idle and `steer` only to add guidance to the currently active turn. Do not use steering as a generic send mode.
- Use `interrupt_session` only on explicit user intent or when required by an already-authorized supervision objective.
- A state change happened only when its tool receipt proves it. If an operation is uncertain, reconcile status before retrying because it may already have taken effect.

## Worker results and supervision

- Eligible worker final messages are automatically delivered to the user with the session nickname. Do not repeat, paraphrase, or announce an automatically delivered result unless asked.
- Worker notifications sent to you contain metadata, not bodies. Use `read_worker_message` only when the user asks, a supervision decision needs the result, or compacted context must be recovered. Use ordinary `collect_messages` when inspection or summarization is requested without `/collect`.
- There is no watch tool. When asked to monitor work until completion, record the objective and pending decision in `session-status.json`; react to each worker event; inspect a body only when needed; send justified follow-up; and stop only when the requested supervision outcome is genuinely resolved.

## Exact directives

- `/pass` constrains ordinary `send_to_session`. Forward the immutable payload and attachment IDs exactly. Do not translate, normalize, quote, prefix, or reconstruct them. You still choose the target and `start` or `steer`, asking when ambiguous.
- `/collect` constrains ordinary `collect_messages`. Use the exact count; the backend delivers the selected final bodies directly. Do not repeat or summarize directly collected bodies.
- Without these directives, you may compose, inspect, and summarize according to the user's request.

## Models, effort, goals, and interruption

- Use `list_models` before choosing an uncertain model. Use `set_session_model` and `set_reasoning_effort` rather than sending simulated CLI commands. Explain that changes apply according to app-server turn state.
- Use `get_goal` before a goal mutation when current intent is unclear. `set_goal` replaces the current goal. You may set, replace, pause with `pause_goal`, resume with `resume_goal`, or cancel with `cancel_goal`; never declare or mark a worker goal complete.
- Report which nickname and active turn are affected by interruption or goal cancellation.

## Attachments and failures

- Preserve inbound attachment IDs and order for `/pass`. Use `prepare_chat_attachment` with a verified owner and relative path, then `send_chat_attachment`; never invent backend paths or expose attachment-store internals.
- Use `send_chat_message` only for an additional manager message that the user actually needs. Internal event acknowledgements are otherwise suppressed.
- Permission blocks, detached sessions, cwd mismatches, unavailable endpoints, capacity limits, and worker failures are real states. Explain the blocker and take only recovery actions authorized by the user's request.
- Auto-approval mode does not guarantee success. Never fabricate permission, delivery, tool, worker, or goal completion.

## Manager notebook

- Read `session-status.json` at startup and after compaction when context is insufficient.
- Update it after create, adopt, register, or rename; after every instruction sent; after each relevant worker event; and after every supervision decision. Keep one concise record per stable thread and remove completed follow-ups.
- The notebook is management memory, not authoritative status and not a transcript. Confirm live state with tools before acting.

## Tool catalog

Session discovery and lifecycle: `list_managed_sessions`, `discover_sessions`, `get_session_status`, `create_session`, `register_session`, `adopt_session`, `rename_session`, `detach_session`, `attach_session`, `archive_session`.

Work and results: `send_to_session`, `read_worker_message`, `collect_messages`, `interrupt_session`.

Model and goal control: `list_models`, `set_session_model`, `set_reasoning_effort`, `get_goal`, `set_goal`, `pause_goal`, `resume_goal`, `cancel_goal`.

User output and attachments: `send_chat_message`, `prepare_chat_attachment`, `send_chat_attachment`.

Tool schemas define exact arguments. Backend validation is authoritative for authorization, canonical paths, exact directives, idempotency, and delivery. Never expose tokens, hidden message bodies, internal tool chatter, or backend-only identifiers unless needed for diagnosis.
```

Create `assets/coordinator/session-status.example.json` with the existing `{ "version": 1, "sessions": {} }` structure. Before removing `coordinator/.gitignore`, add these exact legacy protections to the root `.gitignore`:

```gitignore
coordinator/session-status.json
coordinator/session-status.json.invalid-*
```

Then remove the tracked source-runtime assets under `coordinator/`; do not touch the ignored live `coordinator/session-status.json` in the developer checkout.

- [ ] **Step 4: Verify the policy contract**

Run:

```bash
npm test -- tests/coordinator/policy.test.ts
git diff --check
```

Expected: PASS; the test proves the detailed policy and absence of default marker noise.

- [ ] **Step 5: Commit the packaged assets**

```bash
git add .gitignore assets/coordinator tests/coordinator/policy.test.ts coordinator/AGENTS.override.md coordinator/session-status.example.json coordinator/.gitignore
git commit -m "feat: package coordinator management playbook"
```

### Task 4: Wire the prepared workspace into production startup

**Files:**
- Modify: `src/production-app.ts`
- Create: `tests/production-startup.test.ts`
- Modify: `tests/coordinator/identity.test.ts`

- [ ] **Step 1: Write a failing production-startup test and extend identity error coverage**

Create `tests/production-startup.test.ts` with a temporary external coordinator directory, data directory, and registry path. Build a complete `BotConfig` with `mcpPort: 0` and a definitely missing `codexBinary`, start the real production app, and expect endpoint startup to fail:

```ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import type { BotConfig } from "../src/config.ts";
import { buildProductionApp } from "../src/production-app.ts";

test("production prepares the configured coordinator workdir before endpoint startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-bot-production-workdir-"));
  const workdir = join(root, "external-coordinator");
  const dataDir = join(root, "backend-data");
  const registryPath = join(root, "backend-registry", "sessions.json");
  const policyAsset = fileURLToPath(new URL("../assets/coordinator/AGENTS.md", import.meta.url));
  const config: BotConfig = {
    telegramBotToken: "test-token",
    telegramOwnerId: 42,
    telegramDestinationChatId: 42,
    coordinatorWorkdir: workdir,
    dataDir,
    sessionRegistryPath: registryPath,
    codexBinary: join(root, "missing-codex"),
    maxConcurrentTurns: 1,
    maxCollectCount: 20,
    mcpHost: "127.0.0.1",
    mcpPort: 0,
    attachmentMaxBytes: 1024,
    attachmentStoreMaxBytes: 4096,
    sandboxMode: "workspace-write",
  };
  const app = await buildProductionApp(config);
  await assert.rejects(app.start());
  await app.stop();

  assert.equal(await readFile(join(workdir, "AGENTS.md"), "utf8"), await readFile(policyAsset, "utf8"));
  assert.match(await readFile(join(workdir, ".codex-bot-agents.sha256"), "utf8"), /^[a-f0-9]{64}\n$/u);
  assert.deepEqual(JSON.parse(await readFile(join(workdir, "session-status.json"), "utf8")), { version: 1, sessions: {} });
  assert.equal(JSON.parse(await readFile(registryPath, "utf8")).coordinator.project_dir, await realpath(workdir));
});
```

This test must use a workdir outside the source checkout. It proves workspace preparation and registry initialization happen before the deliberately failing endpoint phase; under the current implementation it fails because production ignores `BotConfig.coordinatorWorkdir` and uses the source-relative directory.

In `tests/coordinator/identity.test.ts`, add one case where the registry coordinator directory differs from the configured external workdir. Assert `resumeCoordinatorIdentity` rejects with `AppError` code `CONFIGURATION_ERROR`, the formatted message names the configured path, and no app-server request occurs. Retain the existing exact-cwd tests.

- [ ] **Step 2: Run the production and identity tests and verify the red state**

Run:

```bash
npm test -- tests/production-startup.test.ts tests/coordinator/identity.test.ts
```

Expected: FAIL because production still derives the coordinator directory from the source checkout and identity mismatches are not sanitized configuration errors.

- [ ] **Step 3: Replace the source-relative coordinator directory with a preparation phase**

In `src/production-app.ts`:

- replace `repositoryRoot` and `join(repositoryRoot, "coordinator")` with a read-only asset root derived from `import.meta.url` as `../assets/coordinator`;
- declare `let coordinatorDir = config.coordinatorWorkdir`, `let notebook`, and `let coordinatorWarnings: string[] = []`;
- insert a first phase named `coordinator-workspace` that calls `prepareCoordinatorWorkspace({ workdir: config.coordinatorWorkdir, dataDir: config.dataDir, registryPath: config.sessionRegistryPath, policyTemplatePath: join(assetRoot, "AGENTS.md"), notebookTemplatePath: join(assetRoot, "session-status.example.json") })`, then assigns its canonical root, notebook, and warnings;
- remove coordinator-directory creation from the storage phase;
- remove `CoordinatorNotebook.bootstrap` from the registry phase;
- initialize the registry's default coordinator mapping with the prepared canonical directory;
- enqueue each preparation warning as a mandatory `system_warning` delivery once storage and registry state are available; and
- leave `startOrResumeCoordinator` passing the prepared canonical directory into `resumeCoordinatorIdentity`.

Change coordinator identity path mismatches in `src/coordinator/identity.ts` to `AppError("CONFIGURATION_ERROR", ...)` messages that include the configured coordinator path but do not echo an unexpected app-server path. This makes the existing safe startup formatter useful without exposing arbitrary external values.

Do not move the backend DB, registry, or attachments into the coordinator workdir. Do not add relocation or silently rewrite an existing coordinator mapping.

- [ ] **Step 4: Verify startup composition and coordinator identity**

Run:

```bash
npm test -- tests/production-startup.test.ts tests/app.test.ts tests/coordinator/workspace.test.ts tests/coordinator/identity.test.ts tests/coordinator/notebook.test.ts
npm run typecheck
```

Expected: PASS. Inspect `src/production-app.ts` with `rg 'repositoryRoot|join\(.*"coordinator"'` and confirm there is no runtime coordinator path derived from the installation checkout.

- [ ] **Step 5: Commit production wiring**

```bash
git add src/production-app.ts src/coordinator/identity.ts tests/production-startup.test.ts tests/coordinator/identity.test.ts
git commit -m "feat: start coordinator from prepared workdir"
```

### Task 5: Document operation and customization

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Add the external workdir to example configuration**

Add:

```dotenv
COORDINATOR_WORKDIR=/home/you/.codex-bot/coordinator
```

Keep it outside `DATA_DIR` and explain that relative values resolve from the shell launch directory.

- [ ] **Step 2: Rewrite coordinator setup, behavior, state, and troubleshooting docs**

Update `README.md` so setup and run examples include either:

```bash
npm start -- --workdir "$HOME/.codex-bot/coordinator"
```

or `COORDINATOR_WORKDIR`, with CLI precedence documented. Replace every `coordinator/session-status.json` source-relative reference with `<coordinator-workdir>/session-status.json`.

Add an “Coordinator instructions” subsection stating:

- `AGENTS.md` and `.codex-bot-agents.sha256` are bot-managed and must not be edited;
- an unchanged policy is automatically upgraded when the packaged policy changes;
- complete customization belongs in `AGENTS.override.md`, which Codex gives precedence and the bot never reads or modifies;
- the safest starting point for customization is `cp AGENTS.md AGENTS.override.md`, followed by editing the override;
- a full override must retain any desired routing, automatic-delivery, notebook, directive, goal, and safety behavior;
- recovery from a guard failure is either restoring the exact managed file or moving custom content to the override and deleting both managed file and digest together; and
- placing the workdir inside a Git worktree can cause parent instruction inheritance.

Do not remove the root `.gitignore` patterns `coordinator/session-status.json` and `coordinator/session-status.json.invalid-*`; they protect the legacy live notebook that is intentionally not migrated or deleted by this change.

- [ ] **Step 3: Verify documentation has no obsolete runtime paths**

Run:

```bash
rg -n 'coordinator/AGENTS\.override|coordinator/session-status|dedicated directory inside the repository' README.md .env.example
git check-ignore coordinator/session-status.json
git diff --check
```

Expected: no obsolete README/setup matches, `coordinator/session-status.json` remains ignored by the root rule, and there are no whitespace errors.

- [ ] **Step 4: Commit documentation**

```bash
git add .env.example README.md
git commit -m "docs: explain coordinator workdir ownership"
```

### Task 6: Full verification and live-test preparation

**Files:**
- Modify only if a verification failure exposes a defect in the scoped implementation.

- [ ] **Step 1: Run the complete local verification suite**

```bash
npm run check
```

Expected: typecheck PASS and all non-live tests PASS.

- [ ] **Step 2: Run real app-server integration tests**

```bash
RUN_CODEX_INTEGRATION=1 npm test -- tests/integration/app-server.test.ts
RUN_CODEX_INTEGRATION=1 npm test -- tests/integration/mcp-coordinator.test.ts
npm test -- tests/integration/recovery.test.ts
```

Expected: all PASS with the pinned supported Codex version.

- [ ] **Step 3: Exercise startup guards without Telegram polling**

Use the workspace unit test fixtures rather than the user's live coordinator home to verify first install, upgrade, manual edit rejection, override preservation, and repair. Confirm no test writes under the repository's old `coordinator/` runtime directory.

- [ ] **Step 4: Prepare, but do not silently perform, live coordinator relocation**

Inspect the current `.env` and registry without printing secrets. If their coordinator path differs from the requested external workdir, stop and report the explicit migration choices; do not rewrite the registry, delete the old thread, or start with a new data directory without the user's decision.

- [ ] **Step 5: Review the final diff and commit any verification-only fixes**

```bash
git status --short
git diff --check
git log --oneline --decorate -8
```

Expected: only intentional commits and no uncommitted production changes. If verification required a scoped fix, commit it with a specific `fix:` message after its regression test passes.
