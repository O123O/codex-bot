# Design: Remote Claude endpoints (catalog `claude-code`) + ssh ownership scan

Status: draft (for review)
Goal: let the assistant add a **remote Claude Code** endpoint the same way it adds a remote Codex one — an
`endpoints.json` entry — and manage sessions on it safely, including the **ownership scan over ssh** (external-
turn / duplicate-driver detection). This is the deferred remote half of the Claude endpoint work (PRs #7–#12).

## 1. What already exists (do not rebuild)

- **Local Claude endpoint** (merged): `ClaudeCodeRuntime` drives `claude -p`; opt-in via `CLAUDE_CODE_ENDPOINT_ID`.
  Local ownership scan works (`scanLocalClaudeTranscript` reads the local transcript).
- **`SshClaudeCommandRunner`** (merged, verified vs `dfw-vscode`): runs `claude -p` over ssh; the runtime is
  unchanged (local-vs-remote is purely the injected runner). It currently takes a raw `{host}`; production must
  drive it over the **QiYan-managed ControlMaster** instead (see §3.3).
- **Provider awareness** (merged, PR #12): `sessionProvider(endpointId)` + `list_managed_sessions.provider` +
  AGENTS.md. `sessionProvider` already reads a catalog `type:"claude-code"` (once the schema allows it, §3.1).
- **Ownership model** (merged): a Claude turn QiYan drove carries a `<!-- qiyan-cid:ctx:call -->` marker in the
  `user` row's message content (Claude has no Codex `client_id` field); the scanner reads it back and
  `ownsWorkerTurn` classifies owned-vs-external. This is what the remote scan must reproduce on the remote host.

## 2. The impedance: SSH infra is Codex-coupled

A remote Codex endpoint is built in `createRemote` (`production-app.ts:2349`) as: SSH plan (ControlMaster) →
`SshRemoteClient` (helper channel) → **`SshRuntime`** → `SshAppServerRuntime` → `ManagedAppServerEndpoint`, and
a `RemoteContext = { runtime: SshRuntime; remote: SshRemoteClient; projectsRoot }` is recorded.

`RemoteContext.runtime` (the `SshRuntime`) is consumed in **three** places, and every one assumes Codex:
1. **Workspace router** (`production-app.ts:2386-2402`) — `runtime.remoteHome`, `runtime.remoteRuntimeDir`,
   `runtime.remoteHelperPath` (via `SshHost`), to set up a project workspace on the remote host.
2. **Worker file bridge** (`:2403-2413`) — `runtime.remoteHelperPath`, `runtime.remoteRuntimeDir`, for
   attachment transfer.
3. **Ownership-scan router** (`RolloutAccessRouter.remote()`, `:2426-2430`) — `runtime.remoteHelperPath`, to run
   the `rollout-scan` helper op on the remote.

**Key realization:** all three actually need only the **remote *host* management** — bootstrap the shipped
`qiyan-ssh-helper.mjs`, expose `remoteHome`/`remoteRuntimeDir`/`remoteHelperPath`, and run helper ops (workspace,
file transfer, rollout-scan). Those are **provider-agnostic** (generic remote file/dir/scan ops in the helper).
The *only* Codex-specific thing `SshRuntime` does is **start the `codex app-server`** (its `ensureStarted` →
helper `start`). So the coupling is that `SshRuntime` *bundles* provider-agnostic host management with the
Codex-app-server lifecycle.

## 3. Design

### 3.1 Catalog: discriminated `type`
`endpoints.json` entry becomes a discriminated union:
```
{ "type": "ssh",         "projects_root"?: "~/..." }               // Codex on that host (unchanged)
{ "type": "claude-code", "projects_root"?: "~/...", "model"?: "..." } // Claude Code on that host
```
`EndpointCatalog.require` returns `RemoteEndpointDefinition = SshEndpointDefinition | ClaudeEndpointDefinition`.
`CatalogReader.require` / `createRemote` signatures widen to the union (manager.ts). `sessionProvider` already
handles it. **Must land atomically with §3.3** — a `claude-code` entry with no createRemote branch would be
mis-built as Codex.

### 3.2 Decouple host-management from the Codex app-server (the core change)
Extract the provider-agnostic remote-host surface that the three consumers need:
```
interface RemoteHost {
  remoteHome: string;
  remoteRuntimeDir: string;
  remoteHelperPath: string;
  remote: SshRemoteClient;   // helper channel
}
```
Two viable shapes (pick in review):
- **(A) Extract `RemoteHost` out of `SshRuntime`.** `SshRuntime` composes a `RemoteHost` (bootstrap + dirs +
  helper) and adds the Codex-app-server lifecycle on top. A Claude remote uses the `RemoteHost` alone.
- **(B) Keep `SshRuntime`, add a "no app-server" mode.** A flag makes `ensureStarted` bootstrap the helper +
  resolve dirs but skip the `codex app-server` start. Smaller diff, but leaves a Codex-shaped object half-used.

Recommend **(A)** — it makes `RemoteContext.runtime` optional and replaces the three consumers' `context.runtime.X`
with `context.host.X`, so a Claude `RemoteContext` carries a `RemoteHost` (no `SshRuntime`). `RemoteContext`
becomes `{ host: RemoteHost; runtime?: SshRuntime; remote; projectsRoot; provider }`.

Consumers after the change:
1. Workspace router → `context.host.remoteHome/remoteRuntimeDir` + `SshHost(id, context.remote, context.host.remoteHelperPath)`. Works for Claude unchanged (a Claude session still has a cwd/project dir on the remote host that the workspace policy provisions).
2. File bridge → `context.host.remoteHelperPath/remoteRuntimeDir`. Works for Claude (attachments are text-only today; the bridge is dormant but correct).
3. Ownership-scan router → `context.host.remoteHelperPath` + provider dispatch (§3.4).

### 3.3 `createRemote` claude-code branch
```
if (definition.type === "claude-code") {
  const generation = await planner.createGeneration(definition.id);          // ControlMaster plan
  const remote = new SshRemoteClient({ plan: generation.plan, helperSource });
  const host = await createRemoteHost(remote, generation.plan);              // bootstrap helper + dirs (no codex)
  const runner = new SshClaudeCommandRunner({ buildSshArgs: (cmd) => buildSshStreamArgs(generation.plan, cmd) });
  const endpoint = new ClaudeCodeRuntime({ id, runner, launchFlags: { disallowedTools, appendSystemPrompt, model }, goals: claudeGoals });
  remoteCandidateContexts.set(endpoint, { host, remote, projectsRoot: definition.projectsRoot, provider: "claude" });
  return { endpoint, pendingBinding: generation.pendingBinding };
}
```
`buildSshStreamArgs(plan, remoteCommand)` (helper to add to `ssh-config.ts`) = `[...baseArgs(plan, false),
plan.alias, remoteCommand]` — reuses the established ControlMaster; `remoteCommand` is a single pre-quoted shell
string (the runner quotes its own tokens), so it bypasses `buildSshRemoteArgs`'s strict per-token guard (which
is for the restricted helper protocol, and would reject the prompt/flags). The `SshClaudeCommandRunner` refactors
from `{host}` to an injected `buildSshArgs(remoteCommand)`.

### 3.4 Ownership scan over ssh (the safety-critical piece)
Port the Claude transcript scanner into `qiyan-ssh-helper.mjs` as a new op `claude-rollout-scan`, mirroring the
existing `rollout-scan` (Codex). It runs **on the remote host** and returns only `RolloutScanResult` metadata
(cursor, `starts[]`, `openTurn?`, `malformed?`) — **never message bodies** (privacy parity with Codex). The
port reproduces `ClaudeTranscriptParser`: turn-start = `user` row with non-empty `promptSource`; extract the
`<!-- qiyan-cid:…-->` marker → `clientId`; `hasUserMessage:true`; end on a non-`tool_use` `stop_reason`;
byte-offset cursor with the shared append/truncation/mtime detection; the shared
`ROLLOUT_APPENDED_WHILE_SCANNING` sentinel.

`RolloutAccessRouter` (remove the `UNSUPPORTED` stub): for a remote **claude** endpoint, invoke
`claude-rollout-scan` (via `context.remote.invoke`) instead of `rollout-scan`. Dispatch by `provider(endpointId)`
(already injected). The scan filename validator on the remote uses `<session_id>.jsonl` (not Codex `rollout-*`).

### 3.5 Worker scheduling MCP over a remote worker (separable)
The Phase-2 worker scheduling tools reach a LOCAL loopback MCP. A **remote** Claude worker calling them needs the
`ssh -R` reverse tunnel + bind-not-relax auth (impl-plan §2.4). This is **out of scope** for this doc (a remote
Claude endpoint's *management* works without it; only the worker's self-scheduling needs it). Track separately.

## 4. Recovery / edge cases
- Recovery reconciliation runs the ownership scan over ssh on restart — same path, just remote. The phantom-gate
  and external-turn fencing behave identically (metadata is provider-neutral).
- Remote transcript pull-and-parse-locally is the rejected alternative (streams bodies over the wire, needs
  remote `stat` for the device/inode cursor identity) — the on-remote helper keeps bodies remote and reuses the
  cursor machinery, matching Codex.
- Missing `claude` on the remote host → spawn error → the runner reports the turn failed (existing B1 handling);
  the ownership `claude-rollout-scan` returns `missing` if there is no transcript yet.

## 5. Plan (each an independently-reviewed step)
1. **Catalog + decouple + createRemote** — §3.1 union; §3.2 `RemoteHost` extraction + the three consumers;
   §3.3 claude-code branch + `buildSshStreamArgs` + runner refactor. *Verify:* unit tests for the catalog union
   + a fake-runner composition test that a `claude-code` endpoint constructs and a session leases/starts a turn
   through the full manager path (not just the pool).
2. **Ownership scan over ssh** — §3.4 helper `claude-rollout-scan` + router routing. *Verify:* helper unit test
   over sample Claude transcripts (reuse the committed fixtures) returns the same metadata as
   `scanLocalClaudeTranscript`; router routes remote-claude to it.
3. **End-to-end** — gated integration (`RUN_CLAUDE_REMOTE_INTEGRATION`): add a `claude-code` catalog entry for
   `dfw-vscode`, create/adopt a session, run a turn, and confirm the ownership scan classifies an owned turn
   (owned) and an externally-typed turn (external → unadopt). Build + restart + PR.

## 6. Risks
- **Safety-critical layer.** This touches SSH + ownership (the duplicate-delivery layer). The `RemoteHost`
  extraction has real blast radius on the Codex remote path — the Codex remote tests must stay green throughout.
- **Decoupling shape.** (A) vs (B) is the main review decision; (A) is cleaner but larger.
- **Helper port fidelity.** The remote `claude-rollout-scan` must byte-for-byte match `scanLocalClaudeTranscript`
  (same turn model, marker, cursor, sentinel) or ownership diverges local-vs-remote.

## 7. Open questions
- (A) full `RemoteHost` extraction vs (B) SshRuntime no-app-server mode?
- Does a remote Claude session need the workspace policy (project-dir provisioning) at parity with Codex, or a
  lighter "cwd must exist" contract?
- Ship §3.5 (remote worker scheduling over `ssh -R`) with this, or strictly separate?
