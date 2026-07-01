# External Coordinator Workdir Design

## Goal

Run the coordinator Codex thread from an explicit user-owned directory rather than from the bot source or installation directory. This makes the launch directory irrelevant, prevents the coordinator from inheriting the bot repository's instructions in normal deployments, and establishes the CLI shape needed by a future `codex-bot` binary.

## Command and configuration

The source checkout supports the future binary syntax through:

```bash
npm start -- --workdir /absolute/or/relative/path
```

The packaged binary will expose the same option as `codex-bot --workdir <path>`. `--workdir` takes precedence over `COORDINATOR_WORKDIR`. Startup fails with a concise configuration error when neither is supplied. Relative paths resolve against the process launch directory, after which the bot uses the canonical absolute path everywhere.

Binary packaging and distribution are outside this change; the CLI contract is included now so packaging does not require an architecture change.

## Coordinator workspace

Before starting either app-server endpoint, the bot prepares the coordinator workdir. It creates the directory with owner-only permissions when absent and initializes:

- `AGENTS.md`, copied from the coordinator policy packaged with the bot;
- `.codex-bot-agents.sha256`, containing the SHA-256 digest of the last policy version installed by the bot; and
- `session-status.json`, initialized from the packaged example only when absent.

An existing valid notebook is opened unchanged. An existing unreadable, malformed, or schema-invalid notebook stops startup without moving, truncating, quarantining, or replacing it; preserving supervision intent is safer than silently resetting it.

The coordinator thread is started or resumed with the canonical coordinator workdir as its exact `cwd`. Its registry mapping must use that same path. The backend database, registry, and attachment store stay outside this workdir so the coordinator cannot rewrite authoritative backend state through normal workspace access.

This separation is enforced rather than documented only. Startup canonicalizes the coordinator directory, data directory, and registry location through their existing parents, then rejects equality or containment in either direction. This catches direct paths, nested paths, and symlink aliases before Codex starts. The attachment store is already beneath the data directory and is covered by the same check.

## Instruction ownership and updates

`AGENTS.md` is entirely bot-managed and contains no ownership-marker comments. On every startup the bot evaluates it before starting Codex:

1. If both `AGENTS.md` and the hash file are absent, install the current packaged policy and its hash atomically.
2. If both exist and the file matches the stored hash, install a newer packaged policy when needed and update the hash atomically.
3. If `AGENTS.md` differs from the stored hash, fail startup without changing either file. The error explains that `AGENTS.md` is managed and directs the user to put complete custom instructions in `AGENTS.override.md`.
4. If `AGENTS.md` exists without a hash, adopt it only when it exactly matches the current packaged policy; otherwise fail without overwriting it.
5. If the hash exists but `AGENTS.md` is absent, fail because the managed workspace is inconsistent.

The digest is an accidental-edit guard, not a security boundary. The hash file is deliberately kept beside the managed file so a workspace is self-describing and movable.

The bot never creates, reads, edits, or deletes `AGENTS.override.md`. Codex gives that file precedence over `AGENTS.md` in the same directory, so creating it gives the user full ownership of the coordinator prompt. Documentation warns that a full override is also responsible for retaining tool-routing, delivery, notebook, and safety guidance.

Recovery from a managed-file error is explicit: either restore `AGENTS.md` to the exact last bot-installed content, or move the desired custom content to `AGENTS.override.md` and remove both the managed `AGENTS.md` and its hash so the bot can reinstall them together. A later maintenance command may automate repair, but it is outside this change.

## Coordinator operating playbook

The packaged `AGENTS.md` is a practical operating manual, not a short role label. It remains concise enough for durable context but explicitly defines the following behavior.

### Role and routing

- Act as the user's general assistant and manager of ordinary Codex project sessions.
- Answer general requests directly when project execution is unnecessary.
- Route project work using explicit nicknames first, then registered project metadata, recent conversational context, and live session status. Ask the user instead of guessing when multiple targets remain plausible.
- Use `list_managed_sessions` for known projects and `discover_sessions` to find ordinary Codex threads outside the registry. Create a new session only for new work; adopt or register an existing thread when continuity is requested.
- Assign short unique nicknames, preserve stable nickname-to-thread meaning, and explain a newly assigned nickname to the user.

### Lifecycle and live state

- Treat the backend registry and app-server as authoritative. The notebook is memory, not live status.
- Check live status before sending, steering, interrupting, changing model or effort, changing goals, attaching, detaching, or archiving.
- Use `start` only when beginning an idle turn and `steer` only when intentionally adding guidance to an active turn. Never use steering as a generic message mode.
- Do not claim that a state-changing operation happened until its tool receipt proves it. Treat an uncertain receipt or transport failure as potentially applied and reconcile before retrying.
- Never silently repoint a nickname, thread, endpoint, or project directory.

### Worker messages and supervision

- Know that worker final messages are delivered to the user automatically with the session nickname. Do not duplicate, paraphrase, or announce those messages unless the user asks.
- Treat coordinator worker notifications as metadata. Read a referenced worker body only when needed to answer the user, make a supervision decision, or recover missing context.
- There is no watch tool. For requests such as “monitor this until finished,” record the objective and next decision in `session-status.json`, respond to each metadata event, inspect the worker result when necessary, send follow-up guidance when justified, and remove the pending follow-up only when supervision is genuinely finished.
- Read the notebook at startup and after compaction. Update it after session adoption or rename, every instruction sent, every relevant worker event, and each supervision decision. Keep summaries concise and never use it as a transcript.

### Exact directives

- `/pass` is a constraint on the ordinary `send_to_session` tool. Forward the immutable payload and attachment IDs exactly; do not translate, normalize, quote, prefix, or reconstruct them. The coordinator still chooses the target and `start` or `steer` mode, asking when the target is ambiguous.
- `/collect` is a constraint on the ordinary `collect_messages` tool. Use the exact requested count and let the backend deliver the selected final messages directly. Do not repeat or summarize directly collected bodies.
- For ordinary sends and collects without these directives, the coordinator may compose, inspect, and summarize according to the user's request.

### Models, effort, goals, and interruption

- Use the structured tools rather than sending simulated CLI slash commands to a worker.
- List supported models before selecting an uncertain model name. Explain whether a model or effort change affects the next turn rather than claiming it rewrites an active turn.
- `set_goal` replaces the current worker goal. The coordinator may inspect, set, replace, pause, resume, or cancel a goal, but it never marks a worker goal complete; completion belongs to the worker/app-server goal lifecycle.
- Interrupt only on explicit user intent or when required by an already-authorized supervision objective, and report the affected session and turn.

### Attachments, failures, and user communication

- Preserve inbound attachment IDs and ordering for `/pass`. Use backend attachment handles for outbound files; never invent paths or expose attachment-store internals.
- Permission blocks, detached sessions, cwd mismatches, unavailable endpoints, capacity limits, and worker failures are real states. Explain the blocker and choose only an authorized recovery action.
- Auto-approval mode does not mean every operation succeeds. Never fabricate approval or completion.
- Keep manager updates concise: name the nickname, action, verified status, and next decision. Do not expose tokens, hidden message bodies, internal tool chatter, or backend-only identifiers unless they are needed for diagnosis.

The playbook explains cross-tool judgment and invariants. MCP schemas remain the source of individual arguments, and deterministic backend validation remains authoritative for authorization, path verification, exact directives, idempotency, and delivery.

## Existing coordinator identity

The configured workdir becomes part of coordinator identity. If an existing registry maps the coordinator to another directory, startup fails before starting a coordinator turn. It does not silently repoint or resume the old thread. Relocation is a separate explicit operation and is outside this change; for the current test deployment, the operator can select the existing coordinator directory initially or start with a new data directory.

## Parent instruction warning

Codex may discover instructions between a detected project root and the coordinator workdir. During preparation, the bot checks whether the selected workdir is inside a Git worktree and emits a concise warning when it is. A standalone directory such as `~/.codex-bot/coordinator` is recommended. This is a warning rather than a startup failure because advanced users may intentionally place the coordinator in a repository.

## Failure behavior

Workspace preparation completes before app-server startup. Any missing configuration, path overlap, unreadable directory, managed-file mismatch, partial managed state, invalid notebook, or identity mismatch stops startup. User-facing configuration errors name the affected trusted path without echoing arbitrary CLI arguments, Telegram tokens, message contents, raw filesystem errors, or other untrusted values.

Managed file and hash updates use temporary files in the coordinator directory followed by atomic renames. The policy file is committed before the hash so a crash cannot record a digest for policy bytes that were not installed; an interrupted update will be rejected safely on the next startup.

## Tests

Automated tests cover:

- CLI parsing, environment fallback, precedence, missing values, and unknown arguments;
- relative-path canonicalization independent of the bot installation path;
- rejection when coordinator and backend state paths overlap directly, by containment, or through a symlink;
- first-run workspace initialization;
- unchanged managed policy on restart;
- packaged policy upgrade when the installed file is unmodified;
- refusal after a manual `AGENTS.md` edit;
- safe handling of missing or partial hash state;
- preservation and non-inspection of `AGENTS.override.md`;
- initialize-only notebook behavior;
- warning when the workdir is inside a Git worktree;
- coordinator start/resume and registry cwd verification; and
- sanitized user-visible startup errors.

The existing unit, integration, typecheck, and secret-scanning suites must remain green.
