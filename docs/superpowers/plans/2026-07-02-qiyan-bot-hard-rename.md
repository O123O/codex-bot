# QiYan Bot Hard-Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pre-user Codex Bot/coordinator product with QiYan Bot, a full-auto general assistant with protected delegated workspaces, untouched worker Codex configuration, fresh state, and a verified `v0.2.0` GitHub Release.

**Architecture:** Perform one hard, test-gated rename across runtime, schema, assets, package, and active docs; retain only `docs/superpowers` as historical engineering records. Keep the assistant on its private app-server/profile with `never` approval and danger-full-access by default, while worker app-servers inherit the runner environment/config minus QiYan/chat secrets and receive no per-thread security overrides. Centralize delegated-directory creation and protected-root validation in a filesystem policy used before every worker lifecycle dispatch.

**Tech Stack:** TypeScript, Node.js 24, Codex app-server JSON-RPC, SQLite, MCP, npm/esbuild, GitHub Actions, GitHub CLI

---

### Task 1: Establish and satisfy the hard-rename contract

**Files:**
- Create: `tests/rename-contract.test.ts`
- Rename: `src/coordinator/` to `src/assistant/`
- Rename: `tests/coordinator/` to `tests/assistant/`
- Rename: `assets/coordinator/` to `assets/assistant/`
- Rename: `tests/integration/mcp-coordinator.test.ts` to `tests/integration/mcp-assistant.test.ts`
- Modify: all files under `src`, `tests`, `assets`, `scripts`, `.github`, and active `docs`
- Modify: `.env.example`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write the failing active-surface rename test**

Create a test that recursively scans these exact roots/files and excludes only `docs/superpowers`: `src`, `assets`, `tests`, `scripts`, `.github`, `.env.example`, `package.json`, `package-lock.json`, `README.md`, `docs/installation.md`, `docs/setup.md`, and `docs/chat-apps`. Construct retired strings from fragments so the test file does not contain them literally:

```ts
const retired = [
  ["codex", "-chat-bot"].join(""),
  ["codex", "-bot"].join(""),
  [".", "codex", "-bot"].join(""),
  ["Codex", " Chat Bot"].join(""),
  ["codex", "_chat_bot"].join(""),
  ["COORDINATOR", "_"].join(""),
  ["CODEX", "_BOT_"].join(""),
  ["coordinator", "-local"].join(""),
  ["codex", "_bot_manager"].join(""),
];
```

Assert no scanned path or UTF-8 file bytes contains a retired token, no case-insensitive `coordinator` substring remains (including camelCase/prefixed forms), and no exact environment assignment/reference uses the retired standalone sandbox variable constructed as `["SAND", "BOX_MODE"].join("")` while canonical `ASSISTANT_SANDBOX_MODE` remains allowed. Recursively scan all `docs` except `docs/superpowers`, rather than a fixed guide list. Assert the manifest is exactly `name: "qiyan-bot"`, `version: "0.2.0"`, `bin: { "qiyan-bot": "dist/qiyan-bot" }`. Build an npm archive and apply the same path/content scan to every packed text file, including explicit UTF-8 inspection of `dist/qiyan-bot`.

- [ ] **Step 2: Run the test and confirm RED**

```bash
npm test -- tests/rename-contract.test.ts
```

Expected: failures identify the old package, executable, role directories, environment names, and active docs.

- [ ] **Step 3: Apply the exact mechanical rename**

Use `git mv` for the four path mappings above. Apply these case-sensitive mappings only to the active scan surface:

```text
Codex Chat Bot              -> QiYan Bot
codex-chat-bot              -> qiyan-bot
codex-bot                   -> qiyan-bot
.codex-bot                  -> .qiyan-bot
CODEX_BOT_                  -> QIYAN_BOT_
Coordinator                 -> Assistant
coordinator                 -> assistant
COORDINATOR_                -> ASSISTANT_
SANDBOX_MODE                -> ASSISTANT_SANDBOX_MODE
```

Rename imports, classes, test names, endpoint IDs, MCP server key, registry field, SQL table/index/column names, profile paths, asset paths, executable/build output, package metadata, release asset, and current documentation consistently. Set package and lockfile root versions to `0.2.0`. Do not rewrite OpenAI Codex engine names or historical `docs/superpowers` files.

- [ ] **Step 4: Run rename, type, and package checks**

```bash
npm test -- tests/rename-contract.test.ts tests/bin.test.ts tests/distribution/package-info.test.ts
npm run typecheck
git diff --check
```

Expected: rename contract passes; any mechanical type/test mismatch is fixed without adding compatibility aliases.

- [ ] **Step 5: Commit the hard rename**

```bash
git add -A
git commit -m "refactor: rename product to QiYan Bot"
```

### Task 2: Implement fresh assistant identity, configuration, and state schema

**Files:**
- Modify: `src/config.ts`
- Modify: `src/cli.ts`
- Modify: `src/main.ts`
- Modify: `src/assistant/profile.ts`
- Modify: `src/assistant/login.ts`
- Modify: `src/assistant/identity.ts`
- Modify: `src/assistant/workspace.ts`
- Modify: `src/registry/session-registry.ts`
- Modify: `src/storage/migrations.ts`
- Modify: `src/storage/database.ts`
- Test: `tests/config.test.ts`
- Test: `tests/cli.test.ts`
- Test: `tests/assistant/profile.test.ts`
- Test: `tests/assistant/identity.test.ts`
- Test: `tests/assistant/workspace.test.ts`
- Test: `tests/registry/session-registry.test.ts`
- Test: `tests/storage/database.test.ts`

- [ ] **Step 1: Write failing configuration and fresh-schema tests**

Assert that, with `HOME=/home/user` and only Telegram owner/token values:

```ts
assert.equal(config.assistantWorkdir, "/home/user/.qiyan-bot/assistant");
assert.equal(config.dataDir, "/home/user/.qiyan-bot/data");
assert.equal(config.sessionRegistryPath, "/home/user/.qiyan-bot/data/sessions.json");
assert.equal(config.assistantSandboxMode, "danger-full-access");
```

Assert `ASSISTANT_WORKDIR`, `ASSISTANT_SANDBOX_MODE`, and `--workdir` override independently; the removed standalone worker sandbox variable is rejected/ignored rather than consumed. Assert `assistant-login` needs only `HOME`, optional `DATA_DIR`, and `CODEX_BINARY`.

Assert profiles use `<DATA_DIR>/assistant-profile/{home,codex}`, endpoint ID is `assistant-local`, registry version is `2` with an `assistant` field, and a version-1/old-field registry is rejected without migration. Add a fresh-database identity marker such as table `qiyan_state(product TEXT PRIMARY KEY, state_version INTEGER NOT NULL)` created by the initial schema; `openDatabase` must reject a pre-QiYan database lacking `product='qiyan-bot', state_version=1` before other stores run.

Parse `.env.example` and assert it contains no repository-relative data/registry setting and does not lower the assistant sandbox below `danger-full-access`; prefer omitting those optional defaults entirely so canonical HOME-based behavior is exercised.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
npm test -- tests/config.test.ts tests/cli.test.ts tests/assistant/profile.test.ts tests/assistant/identity.test.ts tests/assistant/workspace.test.ts tests/registry/session-registry.test.ts tests/storage/database.test.ts
```

Expected: defaults, schema version, profile paths, and assistant security mode fail against mechanically renamed behavior.

- [ ] **Step 3: Implement canonical defaults and assistant-only security**

Resolve defaults from the supplied `HOME` rather than process cwd:

```ts
const home = z.string().min(1).parse(env.HOME);
const defaultRoot = resolve(home, ".qiyan-bot");
const dataDir = resolve(env.DATA_DIR ?? join(defaultRoot, "data"));
const registryPath = resolve(env.SESSION_REGISTRY_PATH ?? join(dataDir, "sessions.json"));
const assistantWorkdir = resolve(cliWorkdir ?? env.ASSISTANT_WORKDIR ?? join(defaultRoot, "assistant"));
const assistantSandboxMode = sandboxSchema.parse(env.ASSISTANT_SANDBOX_MODE ?? "danger-full-access");
```

Pass only `assistantSandboxMode` to assistant identity start/resume with `approvalPolicy: "never"`. Rename the login/profile APIs and CLI command with no aliases. Write registry version 2 `{ version: 2, assistant, sessions }`.

Before setting WAL mode or running any migration, inspect whether the database path existed and whether it is a zero-byte/new file. A genuinely absent/empty database may initialize the QiYan marker and schema. An existing nonempty database lacking the valid marker must fail through a read-only inspection path without changing its bytes, schema, sidecar files, journal mode, or timestamps. Add a regression fixture that snapshots the old database bytes/stat/schema and proves no `-wal`/`-shm` appears after rejection.

- [ ] **Step 4: Add and test the full-auto startup warning**

When `assistantSandboxMode === "danger-full-access"`, emit one structural startup warning stating that the assistant has non-interactive full filesystem access. Do not include filesystem paths or secrets. Assert lower sandbox modes do not emit that warning.

- [ ] **Step 5: Run focused and full checks**

```bash
npm test -- tests/config.test.ts tests/cli.test.ts tests/assistant/*.test.ts tests/registry/session-registry.test.ts tests/storage/database.test.ts tests/production-startup.test.ts
npm run typecheck
```

Expected: all assistant identity/config/state tests pass.

- [ ] **Step 6: Commit assistant identity**

```bash
git add src tests .env.example
git commit -m "feat: establish fresh QiYan assistant identity"
```

### Task 3: Preserve worker home configuration and management MCP isolation

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `src/assistant/profile.ts`
- Modify: `src/sessions/lifecycle.ts`
- Modify: `src/sessions/service.ts`
- Modify: `src/production-app.ts`
- Test: `tests/mcp/server.test.ts`
- Test: `tests/sessions/lifecycle.test.ts`
- Test: `tests/sessions/service.test.ts`
- Test: `tests/production-app.test.ts`
- Test: `tests/integration/mcp-assistant.test.ts`

- [ ] **Step 1: Write failing worker-environment and RPC-shape tests**

Define the desired builders:

```ts
buildWorkerChildEnvironment(host: NodeJS.ProcessEnv): NodeJS.ProcessEnv
buildAssistantChildEnvironment(host: NodeJS.ProcessEnv, profile: AssistantProfile, token?: string): NodeJS.ProcessEnv
assistantTurnConfig(mcpUrl: string): Record<string, unknown>
```

Assert worker output retains arbitrary `USER_MCP_TOKEN`, `CUSTOM_TOOL_HOME`, provider credentials, locale, proxies, `HOME`, `CODEX_HOME`, and a noncredential sentinel `TELEGRAM_THEME`. Remove only the exact chat credentials `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`, `TELEGRAM_DESTINATION_CHAT_ID`, plus `QIYAN_BOT_MCP_TOKEN` and explicitly enumerated assistant-only internal credential keys. Assert the assistant builder remains allowlisted, replaces HOME/CODEX_HOME, and receives the MCP token only when requested.

Capture every worker `thread/start`, `thread/resume`, attach recovery, uncertain recovery, and `turn/start` request. Assert none has own properties `approvalPolicy`, `sandbox`, or `config`; creation retains only `cwd` and lifecycle fields such as `ephemeral`.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
npm test -- tests/mcp/server.test.ts tests/sessions/lifecycle.test.ts tests/sessions/service.test.ts tests/production-app.test.ts
```

Expected: arbitrary environment values are currently dropped and worker RPCs contain forced security settings.

- [ ] **Step 3: Split worker and assistant environment construction**

Implement worker inheritance by cloning all defined host entries and deleting only the exact enumerated QiYan/chat credential denylist; do not use prefix filtering. Keep assistant inheritance as the current auth/proxy/locale/CA allowlist plus private profile overrides. Rename token and MCP key to `QIYAN_BOT_MCP_TOKEN` and `qiyan_bot_manager`. Keep shell policy on assistant turns solely to exclude the management token and exact Telegram credentials from model-launched shells.

- [ ] **Step 4: Remove every worker per-thread override**

Remove `secureShellConfig`, configured sandbox, and approval policy from worker lifecycle and recovery payloads. Do not remove assistant `never`/sandbox/config. Delete the worker execution policy constructor option from `SessionLifecycle` if no longer used.

- [ ] **Step 5: Re-prove exact-process MCP authorization**

Run and, where renamed, extend tests proving loopback-only binding, bearer requirement, exact PID/start-time/socket tuple, endpoint replacement invalidation, ordinary-worker rejection, and token-bearing assistant-child rejection. The real integration test must prove only the assistant can list management tools.

- [ ] **Step 6: Verify and commit**

```bash
npm test -- tests/mcp/server.test.ts tests/sessions/lifecycle.test.ts tests/sessions/service.test.ts tests/production-app.test.ts
npm run typecheck
git diff --check
git add src tests
git commit -m "feat: honor worker Codex configuration"
```

### Task 4: Add protected delegated-workspace policy and assistant context

**Files:**
- Create: `src/sessions/project-workspace.ts`
- Create: `tests/sessions/project-workspace.test.ts`
- Modify: `src/sessions/lifecycle.ts`
- Modify: `src/assistant/workspace.ts`
- Modify: `src/assistant/tools.ts`
- Modify: `src/production-app.ts`
- Test: `tests/sessions/lifecycle.test.ts`
- Test: `tests/assistant/workspace.test.ts`
- Test: `tests/assistant/tools.test.ts`
- Test: `tests/production-startup.test.ts`

- [ ] **Step 1: Write failing project-workspace policy tests**

Specify this API:

```ts
class ProjectWorkspacePolicy {
  constructor(options: {
    userHome: string;
    assistantWorkdir: string;
    dataDir: string;
    registryPath: string;
    defaultProjectsRoot?: string;
  });
  prepareCreate(nickname: string, requested?: string): Promise<PreparedProjectWorkspace>;
  prepareExisting(requested: string): Promise<PreparedProjectWorkspace>;
  assertDispatchable(prepared: PreparedProjectWorkspace): Promise<void>;
}

interface PreparedProjectWorkspace {
  path: string;
  created: boolean;
  fallback: boolean;
  identity: { device: string; inode: string };
}
```

Test real-home `~/` expansion, absolute paths, rejection of other relative paths, recursive explicit creation with final mode 0700, existing explicit-path reuse, default root creation, exclusive fallback leaf, collision rejection, safe nickname pattern `^[a-z0-9][a-z0-9_-]{0,63}$`, and no deletion after a simulated later failure.

With QiYan state both inside and outside home, test rejection of `/`, exact real home, every parent of real home, exact/parent/child assistant/data/registry directories, lexical traversal, pre-existing symlink aliases, and a symlink introduced between projected validation and final revalidation. Assert no app-server request occurs on rejection.

- [ ] **Step 2: Run workspace tests and confirm RED**

```bash
npm test -- tests/sessions/project-workspace.test.ts tests/sessions/lifecycle.test.ts tests/assistant/tools.test.ts
```

Expected: module missing, create requires `project_dir`, and nickname/path guards are absent.

- [ ] **Step 3: Implement projected and final canonical validation**

Resolve explicit `~/` against canonical `userHome`; reject nonabsolute remaining input. For a missing path, walk to the nearest existing ancestor, canonicalize it, append missing segments, and run overlap/broad-root checks. For explicit paths, `mkdir({ recursive: true, mode: 0o700 })`, record whether the leaf was created, `chmod` only a newly created leaf to 0700, canonicalize, and validate again.

For fallback, prepare the default root safely, then call nonrecursive `mkdir(leaf, { mode: 0o700 })`; translate `EEXIST` to a proven-no-effect configuration error. After final canonical validation, read bigint device/inode values and immediately serialize each as an unsigned decimal string. Checkpoints contain only those JSON-safe strings. Recovery validates them with `^[0-9]+$`, reconstructs losslessly with `BigInt`, and rejects malformed/out-of-range identities. `assertDispatchable` repeats no-follow type checks, canonical protected-root checks, and exact device/inode comparison; replacement or symlink insertion fails before an app-server request.

- [ ] **Step 4: Integrate optional project directories and checkpointing**

Make `create_session.project_dir` optional and tighten the shared nickname schema. In the production action, call `prepareCreate`, checkpoint `{ projectDir, projectDirCreated, projectDirFallback, projectDirDevice, projectDirInode }`, then pass the prepared object into lifecycle creation. `SessionLifecycle.create` invokes `assertDispatchable(prepared)` immediately before `thread/start`, after the checkpoint, so asynchronous persistence cannot leave an unchecked replacement window. Use `prepareExisting` plus the same immediate assertion for register/adopt, including inferred adopt cwd.

Update uncertain create-session reconciliation to use the checkpointed canonical `projectDir` and pinned identity whenever original `args.project_dir` was omitted. Add regression tests for: lost response after fallback directory/thread creation is adopted exactly once; crash after directory checkpoint but before dispatch is proven no thread/no automatic leaf reuse; and changed checkpoint identity remains uncertain rather than adopting a thread from a replacement directory.

- [ ] **Step 5: Materialize the read-only assistant context**

During assistant workspace preparation atomically write mode-0400 `assistant-context.json`:

```json
{
  "version": 1,
  "user_home": "/canonical/runner/home",
  "default_projects_root": "/canonical/runner/home/qiyan-bot-projects"
}
```

Manage it with the same no-symlink, atomic, bot-owned rules as the dashboard. Reject manual replacement/special files and update an unchanged generated context when canonical configuration changes.

- [ ] **Step 6: Verify and commit**

```bash
npm test -- tests/sessions/project-workspace.test.ts tests/sessions/lifecycle.test.ts tests/assistant/workspace.test.ts tests/assistant/tools.test.ts tests/production-startup.test.ts
npm run typecheck
git diff --check
git add src tests assets
git commit -m "feat: protect delegated project workspaces"
```

### Task 5: Reframe the managed assistant policy and active documentation

**Files:**
- Modify: `assets/assistant/AGENTS.md`
- Modify: `tests/assistant/policy.test.ts`
- Modify: `README.md`
- Modify: `docs/installation.md`
- Modify: `docs/setup.md`
- Modify: `docs/chat-apps/telegram.md`
- Modify: `docs/chat-apps/slack.md`
- Modify: `docs/chat-apps/wechat.md`
- Modify: `tests/docs.test.ts`

- [ ] **Step 1: Write failing policy and documentation contracts**

Require the policy to say QiYan is primarily a general assistant, direct work is preferred for small/personal/cross-project tasks, delegation is deliberate, user-facing home paths come from read-only `assistant-context.json`, bare shell `~` is forbidden, project sessions never use assistant/bot state, semantic directories are preferred, and omitted `project_dir` uses the backend fallback. Preserve all exact-directive, automatic-delivery, supervision, goal, read-only dashboard/registry/context, and attachment assertions.

Require README opening text to contain “general-purpose personal assistant” before Telegram, describe direct filesystem work and resumable delegated Codex sessions, and label Telegram as one adapter. Require both warnings—assistant danger-full-access/never approvals and workers needing auto/non-interactive user configuration because chat approvals are unsupported—to appear before the first installation command and again before the first launch command across README/setup/installation surfaces.

- [ ] **Step 2: Run contracts and confirm RED**

```bash
npm test -- tests/assistant/policy.test.ts tests/docs.test.ts tests/rename-contract.test.ts
```

Expected: the policy still leads with session management and active docs retain old product positioning/paths.

- [ ] **Step 3: Rewrite the concise managed policy**

Keep the policy below its existing 7,000-byte budget. Add a `## Direct work and delegation` section before routing. Instruct the assistant to read both generated JSON files at startup/compaction, translate user-home language through `assistant-context.json`, use absolute direct-work paths, choose direct versus delegated work deliberately, and never edit managed files. Keep only `/pass` and `/collect` examples.

- [ ] **Step 4: Rewrite active user documentation**

Update every command, path, package, URL, state name, backup item, and troubleshooting entry. Lead with the general-assistant use case. State GitHub-Release-only distribution and forbid bare npm-registry installation. Document fresh setup only—no compatibility procedure. Keep Slack/WeChat planned and Telegram implemented.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- tests/assistant/policy.test.ts tests/docs.test.ts tests/rename-contract.test.ts
git diff --check
git add assets README.md docs tests
git commit -m "docs: position QiYan as a general assistant"
```

### Task 6: Complete QiYan packaging, updater, and release automation

**Files:**
- Modify: `scripts/build.mjs`
- Modify: `src/distribution/package-info.ts`
- Modify: `src/distribution/update.ts`
- Modify: `tests/distribution/package-info.test.ts`
- Modify: `tests/distribution/update.test.ts`
- Modify: `tests/distribution/release-workflow.test.ts`
- Modify: `tests/bin.test.ts`
- Modify: `.github/workflows/release.yml`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing distribution tests**

Assert package discovery accepts only `qiyan-bot`; updater only accepts `<prefix>/lib/node_modules/qiyan-bot`; latest URL is `https://github.com/O123O/qiyan-bot/releases/latest/download/qiyan-bot.tgz`; output names QiYan; build emits executable `dist/qiyan-bot`; installed `.bin/qiyan-bot --version` returns `0.2.0`; and packed files are exactly README, `assets/assistant/AGENTS.md`, `assets/assistant/session-status.example.json`, `dist/qiyan-bot`, and the manifest. `assistant-context.json` is generated from canonical runtime paths and is not a package template.

Assert the workflow verifies tag/package/lock version, runs the full check, packs and normalizes `qiyan-bot.tgz`, rejects retired identifiers in archive names/text bytes, and uses GitHub CLI to create/upload the release. Assert docs/tests require a nonempty GitHub asset digest before install.

- [ ] **Step 2: Run distribution tests and confirm RED**

```bash
npm test -- tests/distribution/*.test.ts tests/bin.test.ts tests/rename-contract.test.ts
```

Expected: old package/executable/release names or incomplete archive validation fail.

- [ ] **Step 3: Implement QiYan distribution behavior**

Update build output, package files/bin/name/version, package discovery, prefix derivation, updater URL/output, fake-npm integration test, and release workflow asset checks. Keep update child environment restricted and shell-free. Do not add npm publication.

- [ ] **Step 4: Exercise both local distribution paths**

Pack/install the runtime-only artifact in a temporary global prefix and run `qiyan-bot --version`. Build a Git source archive without `.git`, `node_modules`, or `dist`; extract, `npm ci`, `npm pack`, install to a second prefix, and prove identical installed file sets and version `0.2.0`.

- [ ] **Step 5: Verify and commit**

```bash
npm run check
git diff --check
git add scripts src/distribution tests/distribution tests/bin.test.ts .github package.json package-lock.json
git commit -m "build: distribute QiYan Bot v0.2.0"
```

### Task 7: Independent implementation review and complete integration verification

**Files:**
- Modify only files required by review findings, with a failing regression test first

- [ ] **Step 1: Run independent spec-compliance review**

Provide reviewers the approved spec, implementation plan, `git diff` from the plan base, and fresh test output. Require separate reviews for security/correctness and rename/distribution completeness. Reviewers do not edit the worktree.

- [ ] **Step 2: Validate every finding before changing code**

For each Critical/Important finding, reproduce it or inspect the exact code path, write a failing test, implement the minimal fix, and rerun the focused suite. Record reasoned rejection for suggestions that conflict with the approved hard-cutover or user-config requirements.

- [ ] **Step 3: Run the full local verification matrix**

```bash
npm run check
RUN_CODEX_INTEGRATION=1 npm test -- tests/integration/app-server.test.ts
RUN_CODEX_INTEGRATION=1 npm test -- tests/integration/mcp-assistant.test.ts
npm test -- tests/integration/recovery.test.ts
npm pack --dry-run
git diff --check
```

Expected: zero failures; real app-server tests prove assistant identity/tool access and unchanged worker configuration semantics.

- [ ] **Step 4: Self-review against every design section**

Check identity, access warnings, worker fidelity, MCP exact-process boundary, direct/delegated policy, path semantics, fallback collision, protected roots, fresh schema, active rename scan, packaging, docs, and deployment rollback. Fix any gap test-first.

### Task 8: Merge, remote rename, release, and fresh development deployment

**Files/external state:**
- Local `main` and Git worktrees
- GitHub repository `O123O/codex-bot` renamed to `O123O/qiyan-bot`
- Git tag/Release `v0.2.0`
- User-local npm prefix and QiYan state/launcher

- [ ] **Step 1: Merge only after a fresh clean check**

Fast-forward the reviewed feature branch into `main`, run `npm run check` again on merged `main`, remove the owned worktree, prune, and delete the merged feature branch. Resolve/remove the stale project-owned `.worktrees/isolated-coordinator-profile` only after proving its branch is already merged or preserving any unique commits.

- [ ] **Step 2: Preflight remote cutover**

Verify clean local `main`, authenticated `gh` owner `O123O`, target slug absence, no local/remote/release `v0.2.0`, no conflicting workflow run, and record the reviewed commit SHA. Do not rename the local checkout directory.

- [ ] **Step 3: Rename the GitHub repository and publish reviewed main**

```bash
gh repo rename qiyan-bot --repo O123O/codex-bot --yes
git remote set-url origin git@github.com:O123O/qiyan-bot.git
git push origin main
```

Verify `gh repo view O123O/qiyan-bot`, remote main SHA, and local origin URL all match.

- [ ] **Step 4: Tag, watch, and accept the public release**

```bash
git tag -a v0.2.0 -m "QiYan Bot v0.2.0"
git push origin v0.2.0
```

Watch the exact Release run to success. Verify main, tag, workflow head, and release target equal the reviewed SHA. Query the `qiyan-bot.tgz` asset digest, download through `/releases/latest/download/qiyan-bot.tgz`, compare SHA-256, install the verified local file to a temporary global prefix, check exact runtime files/manifest, and run `qiyan-bot --version`.

- [ ] **Step 5: Capture live launcher metadata, then stop the old deployment**

Inspect the existing process without printing values. Under a new mode-0700 timestamped backup root, capture only immutable/process-dependent rollback material while it is live: launcher command/cwd/service definition, referenced environment files, raw live environment as mode 0600, canonical state paths, installed package/bin locations, and process-tree identity. Then gracefully stop exactly one old process and its two app-server wrappers. If shutdown fails, restart/leave the unchanged old launcher and abort before copying state, uninstalling, or creating QiYan state.

- [ ] **Step 6: Snapshot consistent stopped state and verify rollback**

With every old process stopped, copy old data/workdir/registry, installed package tree/bin link, and launcher files without dereferencing links. Preserve modes/link targets, write hashes/counts/canonical paths to the manifest, and verify every entry plus the backed-up old binary version. On backup failure, restore/restart the still-installed unchanged old launcher and abort before uninstall/state creation.

- [ ] **Step 7: Install QiYan and rewrite the persistent launcher**

Disable the old autostart entry. Uninstall `codex-chat-bot`, verify its package directory and executable are absent from the owning prefix and effective `PATH`, then install the digest-verified `qiyan-bot.tgz` in `$HOME/.local`. Create fresh `$HOME/.qiyan-bot/data` plus `$HOME/.qiyan-bot/assistant` without opening old state. Rewrite the actual service/environment/launcher definition with executable `qiyan-bot`, intended working directory, `ASSISTANT_WORKDIR`, `ASSISTANT_SANDBOX_MODE=danger-full-access`, fresh `DATA_DIR`/`SESSION_REGISTRY_PATH`, existing chat credentials by reference, and no retired variables. Keep the new launcher disabled until authentication succeeds.

- [ ] **Step 8: Pause for user-controlled authentication**

Run:

```bash
qiyan-bot assistant-login
```

The user completes device authentication. Do not copy or symlink the old auth file. Continue only after `account/read` preflight succeeds in the fresh assistant profile.

- [ ] **Step 9: Enable, start, and verify the fresh bot**

After authentication preflight, enable the rewritten persistent launcher and start one `qiyan-bot --workdir "$HOME/.qiyan-bot/assistant"` process through it. Verify the enabled definition points only to the new executable/working directory/variables, one QiYan process and two app-server wrappers exist, fresh registry version 2 contains `assistant`, the fresh database marker and mode-0400 assistant context/dashboard exist, the danger-full-access warning was emitted, no old executable/package/process/autostart remains, and a Telegram reply works. Retain and report the rollback bundle path.
