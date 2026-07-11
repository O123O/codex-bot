# Design: Managing Claude Code sessions (a Claude Code endpoint)

Status: draft (for review)
Goal: let QiYan manage **Claude Code** sessions the way it manages Codex — start/adopt a session, send a
message, stream the response, set a goal, and schedule/watch — running headless on the cluster, reusing
QiYan's existing session/ownership/recovery machinery.

This doc is grounded in **behavior verified by test on 2026-07-11** (see §2), not assumptions. Karpathy:
minimal first slice, explicit assumptions, verifiable success criteria, no speculative abstraction.

## 1. The core difference from Codex

- **Codex** = one long-running `codex app-server` daemon per endpoint, hosting **many threads** via a
  JSON-RPC protocol (`thread/start`, `thread/resume`, submit turn, streaming notifications). QiYan drives it
  through `ManagedAppServerEndpoint` + `RpcClient` over a jsonl/websocket wire.
- **Claude Code** = **no daemon.** You drive it per-session, either as the **Agent SDK** in-process
  (`@anthropic-ai/claude-agent-sdk`) or as a **headless CLI subprocess** (`claude -p`). A session is a
  transcript on disk (`~/.claude/projects/<cwd-hash>/<session-id>.jsonl`), resumable by id.

So the integration is **one runtime-per-session**, not one-daemon-many-threads. Everything else (session
lifecycle, ownership, recovery, delivery) can be reused because it only needs: start session, resume session,
submit turn, stream events, and a durable per-session artifact.

## 2. Verified findings (tested today — build on these)

- `claude -p` is authenticated on the host (returns results with `session_id`, cost, usage).
- **`--input-format stream-json` keeps the process open across turns** (persistent multi-turn; exits on stdin
  EOF). One-shot `claude -p "x"` runs one turn and exits.
- **`--resume <session-id>` restores full conversation context** — no memory loss. The transcript is the
  durable artifact (Claude Code's analog of a Codex rollout). Cost is re-hydration (cache-creation tokens +
  cold start), not lost memory.
- **`Monitor` is asynchronous and only fires via re-invocation** → it is **dead in one-shot `claude -p`**
  (the process exits with the monitor merely "armed"; it never fires). Native `Monitor`/self-firing cron need
  a **warm process** to receive the re-invocation.
- **Subagents survive a process restart with full context.** Verified across three separate `claude -p`
  invocations: the parent re-attached to the same subagent by id via continuation, and the subagent recounted
  its first-turn instruction verbatim two restarts later. Correction to an earlier assumption: *completed*
  subagents are transcript-backed and durable; only *in-flight* background work is ephemeral on resume.

## 3. Assumptions (confirm)

- A1. Headless auth is **API key** (`ANTHROPIC_API_KEY`) or an existing host credential; not interactive OAuth.
- A2. Managed Claude Code sessions should **inherit the user's `~/.claude` config** (CLAUDE.md, skills, MCP) —
  i.e. *not* `--bare` — consistent with the "rely on the user's home settings" decision for Codex workers.
- A3. One QiYan owns a session at a time (single-writer), enforced by QiYan's existing lease/ownership — Claude
  Code itself does not lock sessions.
- A4. Default execution is **fire-and-resume** (process exits between turns); warm sessions are the exception.

## 4. The minimal design

### 4.1 Turn = one `claude -p --resume` invocation (the core, fire-and-resume)

The simplest thing that works, and it maps 1:1 onto QiYan's session/turn model:

- **start session:** `claude -p "<first message>" --output-format stream-json --input-format text` (from the
  session's `cwd`) → capture `session_id` from the `system/init` event. Register it as a managed session
  (the transcript is the durable artifact, like a rollout).
- **adopt session:** register an existing `session_id` (transcript on disk) — resume validates it.
- **submit turn:** `claude -p --resume <id> "<message>" --output-format stream-json` → stream events →
  translate to QiYan's turn/item notifications → the final `result` event is the turn's final message
  (→ QiYan delivery). Process exits when the turn completes.
- **set goal:** injected as a prompt/system-prompt at the app layer (same as QiYan does over Codex).

No persistent process, no daemon. Session state lives in the transcript; QiYan owns lifecycle + scheduling.
This is the whole MVP.

### 4.2 Event translation

Map the stream-json event set onto QiYan's existing turn/item notification model:
`system/init` → session identity/started; `stream_event`/assistant/tool events → item events;
`result` → turn completed + final message. A thin translator (mirrors what QiYan already does for Codex
`turn/*`/`item/*`). Keep it a pure function for testability.

### 4.3 Runtime abstraction

Introduce a `ClaudeCodeRuntime` that manages **per-session subprocess invocations** and implements enough of
QiYan's endpoint surface to plug into the pool/lifecycle/relay. It is a sibling of the Codex
`LocalAppServerRuntime`/`SshAppServerRuntime`, but session-oriented (one process per turn) rather than
server-oriented (one daemon many threads). Reuse: subprocess management, jsonl parsing, and the
session/ownership/recovery machinery. Do NOT try to force it behind `ManagedAppServerEndpoint`'s
daemon-shaped `request(method, params)` — model it as a session-turn runtime.

### 4.4 SDK vs headless — recommendation

Start with **headless `claude -p` subprocess** (fire-and-resume): it mirrors QiYan's existing subprocess +
jsonl patterns, keeps sessions out-of-process (crash isolation), and needs no persistent process. Note the
**TS Agent SDK** (`@anthropic-ai/claude-agent-sdk`) as a strong alternative (typed events, native resume,
hooks/permissions/MCP in-process) — evaluate it in the spike; pick one before building the abstraction.

## 5. Provider-agnostic scheduling & watching (QiYan MCP tools) — the key piece

Do **not** rely on either runtime's native scheduler (Codex has none; Claude Code's is process-bound and dies
on exit — verified §2). Instead expose QiYan **MCP tools** that both Codex and Claude sessions call:
`schedule_wakeup(delay, prompt)`, `schedule_cron(spec, prompt)`, `watch(condition, prompt)`.

- On call, QiYan **durably records** (session id + schedule/condition + prompt).
- When it fires (timer, or QiYan-evaluated condition), QiYan **resumes the session and drives a turn** with
  the stored prompt — reusing `send_to_session`/resume and the **idempotent-delivery/ownership** machinery so
  a fire is single-delivery.
- Provider-agnostic (MCP is common to both), durable (survives process + QiYan restart), and it lets sessions
  stay fire-and-resume. QiYan becomes the scheduler/watcher of record — the correct place, and the same as its
  goal mechanism today. `watch` is the only non-trivial part: QiYan evaluates the condition (poll on the
  worker endpoint) on an interval and resumes on trigger.

This unifies cron/reminders/watchers across Codex + Claude and removes any need for warm processes for
scheduling.

## 6. Warm mode (opt-in, for live monitors only)

For a session that needs sub-second reactive `Monitor` or is being driven with rapid turns, run it warm:
hold a `--input-format stream-json` process open so the runtime is alive to receive Monitor/cron
re-invocations and to skip re-hydration cost. QiYan keeps the pipe open and relays events. Costs a live
process per warm session and is less restart-safe (in-flight monitors lost on crash). Reserve for the few
sessions that need it; everything else is fire-and-resume.

## 7. Ownership, durability, recovery (reuse what exists)

- **Durable artifact:** the transcript `.jsonl` is the rollout analog. "Does the session have a durable
  rollout" → "does the transcript exist / does `--resume` succeed." The phantom-session gate we just built maps
  directly (drop a session whose transcript never materialized).
- **Single-writer:** QiYan's lease/ownership prevents two drivers on one session (Claude Code won't).
- **Subagents:** durable across restart (§2) — so a persistent sub-worker can be a continued subagent (parent
  holds its id) OR a separate managed session; both survive restart.
- **cwd/worktree:** sessions are cwd-scoped — matches QiYan's `project_dir`; use worktrees for isolation.

## 8. Non-goals

- No reimplementation of Claude Code's scheduler/monitor (use QiYan MCP tools, §5).
- No changes to Codex handling or the shared session/delivery internals.
- No warm-process-by-default (opt-in only, §6).
- Not a generic multi-provider framework yet — just a second concrete runtime alongside Codex.

## 9. Plan & verifiable success criteria

- **Phase 0 — Spike (do first, before any abstraction):** drive one session end-to-end from a script:
  start → capture `session_id` → send a follow-up via `--resume` → stream the response → confirm context
  retained. Also A/B the Agent SDK vs headless for ergonomics.
  **Verify:** two turns, second turn demonstrably has first-turn context; decide SDK-vs-headless.
- **Phase 1 — `ClaudeCodeRuntime` (fire-and-resume) + event translator.** Start/adopt/submit-turn as managed
  sessions; translate events to turn/item notifications; deliver the final message.
  **Verify:** an integration test drives a real (or faked) session: start → turn → delivery, and a resumed
  turn carries context. Ownership/phantom gate applies (a never-materialized session is dropped).
- **Phase 2 — QiYan MCP scheduling/watch tools + durable firing.** `schedule_wakeup/cron/watch` record
  durably; QiYan fires by resuming + driving a turn, single-delivery.
  **Verify:** a scheduled wakeup fires exactly one resumed turn after a QiYan restart (survives restart);
  works against both a Codex and a Claude session.
- **Phase 3 (opt-in) — warm mode** for live monitors. **Verify:** a held-open stream-json session receives a
  native Monitor fire (the §2 complementary test), and QiYan relays it.

## 10. Risks

- R1: SDK vs headless is a real fork — resolve in Phase 0, don't build both.
- R2: `watch` polling cost/latency — bound the interval; prefer event hooks where the worker exposes them.
- R3: re-hydration cost on frequent resumes of large sessions — mitigate with warm mode for hot sessions and
  prompt-cache reuse.
- R4: auth/config on the worker host (API key, `~/.claude` inheritance) — confirm in Phase 0.
- R5: stream-json is a stable contract but version-sensitive; pin a Claude Code version and translate defensively.

## 11. What this unlocks

QiYan manages Codex and Claude Code sessions uniformly — start/adopt/send/goal + durable cron/reminders/
watchers via the same MCP tools — with per-turn fire-and-resume by default and warm sessions only where a live
monitor is required. Subagents work inside turns and survive restarts, so multi-agent work composes under a
managed session.
