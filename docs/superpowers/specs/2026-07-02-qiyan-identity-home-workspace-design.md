# QiYan Identity, Home, and Workspace Safety Design

## Summary

QiYan should identify itself by name in its managed instructions without adding a label to its own chat replies. Only delegated worker finals need a visible `[nickname]` prefix; backend warnings retain `[system]`.

QiYan also needs one configurable application home, native private `.env` loading, a dedicated assistant workdir, a neutral user-project fallback, and an application-level prohibition against using QiYan-owned paths as worker project roots. The default layout becomes:

```text
~/.qiyan-bot/
  .env
  data/
  qiyan-workdir/

~/qiyan-projects/
  <project-name>/
```

The application home and project fallback serve different trust domains. `QIYAN_HOME` contains bot secrets, assistant identity, and runtime state. `~/qiyan-projects` contains user work and may be used either directly by QiYan or by resumable Codex workers.

## Goals

- Remove the `[assistant]` prefix from QiYan's ordinary final replies.
- Tell the managed assistant unambiguously that its name is QiYan.
- Make Documents one possible semantic destination rather than a universal default.
- Keep small or one-off work in the assistant when a worker transcript adds no value.
- Put otherwise unplaced user work under `~/qiyan-projects/<project-name>`, never in the assistant workdir.
- Introduce a configurable `QIYAN_HOME` with safe defaults derived from it.
- Load chat credentials and ordinary bot settings from a private `<QIYAN_HOME>/.env` file.
- Prevent worker sessions from using `QIYAN_HOME`, anything inside it, or a broad parent containing it.
- Apply the same project-path protection throughout worker creation, adoption, internal resume, dispatch, and recovery.
- Replace the current live state with a fresh layout and assistant thread while preserving only the assistant authentication cache.

## Non-goals

- Migrating a pre-change registry, database, assistant thread, managed policy, or workdir.
- Providing compatibility aliases for the previous project-fallback directory name.
- Building a general secrets vault or claiming OS isolation from a full-access assistant running as the same user.
- Restricting worker projects to an allowlist such as Documents.
- Adding a backend guard for every direct filesystem command the full-access assistant can execute.
- Changing worker final prefixes or system-warning prefixes.

## Chat identity and delivery labels

The assistant runtime currently persists ordinary user-triggered finals as `[assistant] ${finalText}`. It will instead persist `finalText` unchanged. This applies only to the automatic final delivery for a user-triggered QiYan turn.

The other delivery identities remain distinct:

- QiYan ordinary final: `finalText`, with no prefix;
- worker final: `[nickname] finalText`, including the existing status suffix when applicable;
- backend warning: `[system] warning`;
- worker permission or failure message: the existing `[nickname] ...` form.

The managed policy begins by saying that the assistant's name is QiYan. It must not tell the model to add its own textual prefix, because labeling is a transport/backend responsibility and duplicate labels would be possible.

## Direct work and delegation policy

QiYan remains a general-purpose personal assistant, not merely a session manager. It should answer questions and perform small, personal, one-off, or cross-project work directly when a separate Codex transcript and lifecycle would add no value. It should delegate sustained coding, project-local work, long-running execution, or work that benefits from an independently resumable context.

When direct or delegated work needs a filesystem location, QiYan uses this order:

1. Reuse an existing task-related project or location established by the user.
2. Use an explicit user-requested location.
3. Select a semantically appropriate location under the real user home. Documents is one example, not the default for all work.
4. If no natural location exists, create a concise project directory under `assistant-context.json.default_projects_root`, which defaults to `~/qiyan-projects`.

This placement order applies to direct generated files as well as worker projects. QiYan must not use its isolated `HOME`, `QIYAN_HOME`, its assistant workdir, or a process launch directory as convenient storage for user deliverables.

When `create_session` receives no `project_dir`, the backend exclusively creates `<default_projects_root>/<nickname>`. A direct task does not use `create_session`; QiYan may create an appropriately named directory under the same root with ordinary filesystem tools. A later worker may deliberately use that directory only through an explicit project path.

## Managed session lifecycle

The public lifecycle is deliberately small:

- `create_session` creates and adopts a new Codex thread;
- `adopt_session` begins managing an existing Codex thread;
- `unadopt_session` stops QiYan management without changing the Codex thread;
- `archive_session` archives the native Codex thread and then removes it from QiYan management;
- `rename_session` changes only the QiYan nickname.

`register_session`, `attach_session`, and `detach_session` are removed from the tool surface. `register_session` duplicated adoption with a caller-supplied cwd. `attach_session` duplicated rediscovery plus adoption. The old detach name did not communicate that the managed mapping should be removed.

Each managed registry entry carries an immutable random `mapping_id` in addition to endpoint, thread ID, canonical project directory, and nickname. Renaming retains `mapping_id`; adoption of the same native thread after unadoption creates a new mapping generation. Registry schema advances for this fresh-state release and has no compatibility parser.

All lifecycle changes and execution-starting actions share one per-thread gate keyed by stable endpoint and thread ID. The gate serializes adoption, rename, unadoption, archive, turn start/steer, and execution-activating goal changes. Durable management states include `adopting`, `managed`, `unadopting`, and `archiving`; only `managed` may begin or steer execution. The idle read and transition into a removal state occur inside the same gate, so a turn or goal cannot start between them.

`adopt_session` accepts a nickname, thread ID, and optional endpoint, but no project directory. Inside the per-thread gate, QiYan first requires that both the nickname and endpoint/thread identity have no current or transitional mapping. It reads the thread, treats its native cwd as authoritative, canonicalizes and safety-checks that directory, and requires idle. Before any resume, the registry compare-and-creates a new `mapping_id` reservation in durable `adopting` state; the reservation is hidden from the managed dashboard and makes duplicate identity or nickname adoption fail before subscription changes.

The reserved attempt calls native `thread/resume` without a cwd override to restore this app-server connection's subscription, reads the thread again, and requires the cwd to be unchanged, safe, canonical, pinned, and idle. A compare-and-promote operation revalidates the same reserved `mapping_id`, endpoint/thread identity, and nickname before changing the state to `managed` and beginning an epoch. If a proven resume from this attempt must be rolled back, only this reservation may request unsubscribe and compare-and-delete itself. An uncertain resume or rollback remains durably `adopting` for recovery; it is never converted into absence that a second adoption could race. QiYan never supplies a different cwd. A thread whose native cwd equals, is inside, or contains `QIYAN_HOME` cannot be adopted.

`unadopt_session` requires an idle managed thread. Before any native mutation, it checkpoints endpoint, thread ID, canonical cwd, `mapping_id`, and completed step, then durably enters `unadopting`. It unsubscribes the bot connection, ends the managed epoch, compare-and-deletes only that exact mapping generation, removes the active dashboard entry, and frees the nickname. It does not archive or delete the Codex thread, transcript, cwd, or project files. Operational audit/idempotency rows may remain keyed by stable identity but are not rendered as a managed session. The ordinary thread can later be found by `discover_sessions` and adopted again, which restores subscription and creates a new mapping generation.

`archive_session` follows the same gate and stable checkpoint rules with state `archiving`. It requires idle, invokes native app-server `thread/archive`, proves native archived state, ends QiYan management, compare-and-deletes only the checkpointed mapping generation, removes the dashboard entry, and frees the nickname. Archiving is not deletion: Codex retains the thread and project files, and an ordinary Codex client can unarchive it. QiYan does not expose native thread deletion or unarchive in this version.

Both removal operations are crash-recoverable using only their checkpointed stable identity, never a current nickname lookup. A replay after registry deletion returns the original operation receipt and cannot touch a newly reused nickname. A recovered unadopt repeats or proves the connection-local unsubscribe before compare-and-delete; a recovered archive reads native archived state before compare-and-delete or classifying no effect. Neither operation reports success while native effect or exact mapping removal is ambiguous.

Startup reconciles every `adopting`, `unadopting`, and `archiving` checkpoint before considering managed-session resume. It resumes only entries whose durable runtime state and exact `mapping_id` are still `managed`. A crash during adoption therefore promotes or rolls back only its reservation; a crash between native unsubscribe/archive and registry deletion completes removal instead of silently resubscribing or resuming the thread. Once removal deletes a mapping, startup cannot recreate it.

There is no public reattach operation. Startup and endpoint reconnection may internally resume mappings that remain durably managed; this implementation mechanism uses the same native-cwd and path checks and is not an assistant tool. Users must unadopt before concurrently resuming a managed thread in another Codex client. QiYan treats later native-cwd drift as a conflict and refuses execution rather than correcting or overriding it.

## QiYan home resolution

QiYan adds one bootstrap setting named `QIYAN_HOME`. Its resolution order is:

1. `--home <path>` for commands that load runtime configuration;
2. the host process environment variable `QIYAN_HOME`;
3. `$HOME/.qiyan-bot`.

`QIYAN_HOME` cannot be defined inside its own `.env` file because the home must already be known to locate that file. If it appears there, startup fails with a configuration error explaining the bootstrap rule.

The resolved path must be absolute or use a leading `~/` relative to the real host `HOME`; arbitrary relative paths are rejected so a launch-directory change cannot redirect secrets or state. The home is created as an owner-only real directory when absent. An existing home must be a real, current-user-owned directory without group or world permissions. Symlinks are rejected.

The projected/canonical QiYan home is validated before creating it. It must not equal or contain the real user home, and it must be fully disjoint in both directions from the projected default user-project root `~/qiyan-projects`. Configurations such as `--home ~`, `--home ~/qiyan-projects`, or `--home ~/qiyan-projects/private` fail before either trust-domain directory is created. Missing paths and symlink aliases receive the same projected-canonical comparison.

The default paths are derived from the resolved canonical QiYan home:

- assistant workdir: `<QIYAN_HOME>/qiyan-workdir`;
- data and isolated assistant profile: `<QIYAN_HOME>/data`;
- registry: `<QIYAN_HOME>/data/sessions.json`;
- dotenv file: `<QIYAN_HOME>/.env`.

`ASSISTANT_WORKDIR`, `DATA_DIR`, and `SESSION_REGISTRY_PATH` remain supported and may independently override those defaults. Their values are resolved before the process changes its working directory.

`assistant-context.json` advances to a new version and records the canonical real user home, canonical QiYan home, and canonical/projected default projects root. It remains backend-generated and read-only.

## CLI and process working directory

The run command accepts `--home <path>` together with the existing `--workdir <path>`. `assistant-login` also accepts `--home <path>` so authentication always targets the same isolated profile as the service. Duplicate or missing option values are rejected. `--version` and `--update` remain configuration-independent and reject unrelated arguments.

For a normal run, QiYan resolves all bootstrap and application paths, prepares the assistant workdir, and makes the canonical assistant workdir the process working directory before starting long-lived runtime phases. The app-server assistant thread continues to receive that same directory explicitly as its cwd. This makes manual and service launches behave consistently without using the caller's arbitrary current directory.

The default managed service starts in `~/.qiyan-bot/qiyan-workdir`, invokes `qiyan-bot` without a service `EnvironmentFile`, and lets the executable read `.env`. A custom home service invokes `qiyan-bot --home /absolute/path` and uses the corresponding workdir. Setup creates the workdir before systemd starts the unit.

The managed unit explicitly removes inherited QiYan configuration and chat-secret keys with `UnsetEnvironment`; a custom home is expressed in `ExecStart` through `--home`, not through a manager-global secret environment. Manual and non-systemd launches retain the documented process-environment override behavior.

## Private `.env` loading

QiYan supports an optional `<QIYAN_HOME>/.env`. When present, it is opened with no-follow semantics and validated through the opened file descriptor before parsing. It must be:

- a regular file, not a symlink or special file;
- owned by the current effective user;
- inaccessible to group and other users;
- bounded to a small configuration-file size;
- parseable using Node's dotenv syntax without shell evaluation.

Documentation recommends mode `0600`. Comments and ordinary quoted dotenv values are accepted. Shell command substitution and sourcing are never used.

Configuration precedence is:

1. CLI overrides;
2. host process environment;
3. parsed `.env` values;
4. application defaults.

Only supported QiYan configuration keys are consumed. A `QIYAN_HOME` entry in `.env` is an explicit error rather than a silently ignored value. Telegram credentials, limits, endpoint settings, assistant paths, Codex binary selection, and assistant sandbox mode may be stored there. Missing required Telegram values still produce the existing configuration error.

The parser returns a merged configuration record without mutating `process.env`. Secrets that exist only in `.env` therefore never enter worker or assistant app-server child environments. If a supported secret is supplied through the host environment, the existing exact-key exclusion remains responsible for stripping it from child environments. Future chat adapters must register their credential keys in the same central secret-key set.

The file protects secrets from other OS users; it is not an isolation boundary against QiYan itself. The assistant deliberately runs as the same user with full filesystem access, so managed instructions continue to prohibit exposing credentials or reading secret files without a user-authorized diagnostic need.

## Worker project-path safeguard

`ProjectWorkspacePolicy` receives the resolved canonical QiYan home as a first-class protected root. A candidate worker project is rejected when it is:

- exactly `QIYAN_HOME`;
- any descendant of `QIYAN_HOME`, including `qiyan-workdir`, `data`, or an unrelated sibling below the home;
- an ancestor that contains `QIYAN_HOME`;
- equal to, below, or above an independently configured assistant workdir, data directory, or registry-owned directory;
- filesystem root, the exact real user home, or a parent of the real user home.

The `create_session` rule is explicit: no requested `project_dir` inside the active QiYan home may dispatch a worker. An omitted `project_dir` remains safe because its fallback is under the separate real-user root `~/qiyan-projects/<nickname>`.

Protection runs against the lexical request, its projected canonical path through the nearest existing ancestor, the final canonical directory, and the device/inode-pinned directory immediately before dispatch. It therefore covers missing descendants, `..` traversal, symlink aliases, and directory replacement races.

The same policy is used for:

- `create_session`;
- `adopt_session` using only the native app-server cwd;
- registry validation and startup resume;
- uncertain-operation recovery before adoption or success;
- a central worker-dispatch check immediately before every new instruction or execution-resuming action.

`SessionService` receives the workspace policy and shared per-thread gate. Immediately before both `turn/start` and `turn/steer`, it verifies that the exact `mapping_id` is durably `managed`, freshly reads and canonicalizes the native cwd, requires equality with the registry's canonical `project_dir`, checks the active protected roots and directory pin, and then issues the mutation inside the same gate. Where an app-server mutation accepts cwd, QiYan supplies only the identical freshly verified cwd; it never redirects the thread. `thread/goal/set` with a new objective or active status receives the same gate and verification because it can start or resume work.

Other worker RPCs are classified deliberately. Thread/status/goal reads, collection, model listing, and pending model/effort changes do not execute project work. Interrupt, goal pause, and goal cancel reduce or stop execution and remain available even if a path has become unsafe. Thread creation and internal resume are guarded by the lifecycle policy and remain so. No operation that starts, steers, or resumes worker execution may bypass the central check.

Discovery may report a Codex thread located in a protected directory, but QiYan cannot adopt or dispatch it as a managed worker.

## Fresh live cutover

This change ships as `v0.3.0` because it adds a CLI/configuration surface and changes default paths. The development deployment intentionally starts fresh and does not add a compatibility migrator.

The cutover procedure is:

1. download and digest-verify the new release before touching the live installation;
2. create an exclusive mode-`0700` staging directory outside every path that will be removed;
3. validate and capture only supported QiYan settings and Telegram credentials from the current private service configuration into an exclusive mode-`0600` staging file, without printing values;
4. validate the staged dotenv syntax, required Telegram values, owner ID equality, and the absence of `QIYAN_HOME`;
5. stop and disable the running QiYan service, then prove the bot and all app-server descendants exited before reading or removing runtime state;
6. open the old isolated assistant `auth.json` with no-follow semantics and validate its descriptor as a bounded, current-user-owned regular file without group or world access;
7. copy the authentication bytes to an exclusive mode-`0600` file in the external staging directory, validate the JSON, and hash-verify the copy;
8. remove the current `~/.qiyan-bot` state without creating a new rollback bundle;
9. create `~/.qiyan-bot`, `data`, and `qiyan-workdir` as owner-only real directories;
10. atomically install the staged configuration as mode-`0600` `~/.qiyan-bot/.env`, re-open it through the production dotenv loader, and verify the resolved paths and settings before enabling the service;
11. prepare the fresh isolated assistant profile and atomically restore only `auth.json` as mode `0600` into its canonical `CODEX_HOME`;
12. replace the systemd unit so it starts in `qiyan-workdir`, has no external `EnvironmentFile`, and unsets inherited QiYan/chat configuration keys;
13. enable and start exactly one QiYan service, verify `account/read`, fresh registry/database identity, a new assistant thread, and worker count zero;
14. prove dotenv-only chat secrets are absent from the bot's `/proc/<pid>/environ` and both app-server child environments;
15. remove the temporary authentication/configuration files and staging directory, then complete a Telegram round-trip test.

Every staging prerequisite is fail-closed: a type, ownership, permission, parsing, hash, process-exit, or path validation failure aborts before old state is deleted. The already-existing historical rollback directory is not used by the new runtime and no new backup is created. The temporary credential/configuration transfer is deleted after successful authentication verification; it is not a retained backup. No old assistant session, database, registry, managed policy, dashboard, or manager note is restored.

## Documentation

README and setup guides will:

- present `~/.qiyan-bot/.env` as the normal credential/configuration method;
- provide a mode-`0600` Telegram example without real secrets;
- explain `--home` and `QIYAN_HOME` bootstrap behavior;
- show the new `qiyan-workdir`, data, registry, and `~/qiyan-projects` defaults;
- state that process environment values override `.env`;
- explain that full-access QiYan can technically read same-user files;
- document direct-versus-delegated placement and the backend worker guard;
- update service instructions to avoid an external EnvironmentFile.

`docs/chat-apps/telegram.md` is the canonical adapter-specific credential tutorial. It tells users to create the resolved QiYan home, write `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`, and matching `TELEGRAM_DESTINATION_CHAT_ID` into `<QIYAN_HOME>/.env`, set mode `0600`, run `qiyan-bot assistant-login`, and launch without temporary exports. It retains a secret-safe owner-ID discovery procedure and explains how to stop polling before using `getUpdates`. The root README and shared setup guide link to this tutorial and do not teach shell-export or external-service-environment setup as the normal path.

## Testing and acceptance criteria

Implementation follows red-green TDD. Tests must prove:

- a user-triggered QiYan final is delivered without `[assistant]` or `[QiYan]`;
- worker and system prefixes remain unchanged;
- managed instructions name QiYan and express the approved placement order;
- Documents appears only as an example rather than a default mandate;
- direct and delegated fallback guidance uses `~/qiyan-projects`;
- `--home`, `QIYAN_HOME`, `.env`, and defaults obey the approved precedence;
- arbitrary relative homes and `QIYAN_HOME` inside `.env` are rejected;
- `QIYAN_HOME` equal to or containing the real user home, or overlapping `~/qiyan-projects` in either direction, is rejected before directory creation;
- missing `.env` is allowed, while symlinked, non-regular, wrong-owner, over-permissive, oversized, and malformed files fail safely;
- parsed `.env` secrets do not mutate the host environment or appear in assistant/worker child environments;
- default config paths derive from `<QIYAN_HOME>/data` and `<QIYAN_HOME>/qiyan-workdir`;
- the runtime process changes to the canonical workdir only after path resolution/preparation;
- `assistant-context.json` reports canonical `qiyan_home` and the `~/qiyan-projects` fallback;
- omitted session paths exclusively create `~/qiyan-projects/<nickname>`;
- explicit create paths at, inside, or above `QIYAN_HOME` are rejected;
- protected missing descendants, traversal, symlink aliases, and post-prepare replacements are rejected;
- external normal project directories remain allowed;
- configured assistant/data/registry paths outside `QIYAN_HOME` remain protected;
- adoption ignores caller-supplied cwd because the tool has no `project_dir`, preserves the native cwd, and rejects a protected native cwd;
- adoption resumes/subscribes without a cwd override, verifies unchanged safe cwd and idle state again, and rolls back subscription if mapping commit fails;
- adoption compare-and-reserves a unique hidden `adopting` mapping before resume, rejects duplicate nickname or endpoint/thread identity before native mutation, and promotes only the same `mapping_id`;
- failed or recovered adoption can unsubscribe/delete only the reservation and subscription established by that attempt, never an existing managed mapping;
- startup internal resume, registry reload, recovery, and dispatch revalidation cannot bypass the guard;
- `turn/start`, `turn/steer`, goal set, and goal resume issue no app-server mutation after a managed project is replaced or redirected into `QIYAN_HOME`;
- native cwd drift away from the exact canonical registry cwd blocks every execution-starting mutation and is never silently corrected;
- interrupt, goal pause, and goal cancel remain available to stop work after a project path becomes unsafe;
- the public tool catalog contains `adopt_session`, `unadopt_session`, and `archive_session`, but no register, attach, detach, native delete, or unarchive tool;
- removal transitions share the execution gate, so no turn or goal can start after their idle check;
- unadopt requires idle, checkpoints stable identity, unsubscribes, compare-and-deletes the registry/dashboard mapping, frees the nickname, and leaves the native thread and files unchanged;
- archive requires idle, checkpoints stable identity, proves native archive, compare-and-deletes the registry/dashboard mapping, frees the nickname, and leaves project files intact;
- removal recovery never resolves through a reused nickname or deletes a different `mapping_id`;
- startup reconciles pending removals before resuming only durably managed mappings, and a non-destructive unadopted thread can be discovered and adopted again;
- the Telegram guide uses a mode-`0600` `.env` and contains no normal-launch shell-export instructions;
- the live unit unsets inherited configuration keys, uses no external `EnvironmentFile`, and the running process trees contain no dotenv-only chat secrets;
- full unit/integration checks, real app-server integration checks, package contents, and source/archive retired-string scans pass.

Before release, independent reviewers inspect the specification, implementation plan, security boundary, configuration precedence, path canonicalization, secret propagation, recovery behavior, and distribution changes. All Critical and Important findings are fixed and re-reviewed. The released archive is downloaded, digest-verified, installed cleanly, and used for the fresh live Telegram smoke test.
