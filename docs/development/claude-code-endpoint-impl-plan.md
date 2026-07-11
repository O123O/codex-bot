# Implementation Plan: Claude Code endpoint + provider-agnostic scheduling

Companion to `claude-code-endpoint-design.md`. Ordered, independently-verifiable tasks with review
checkpoints. Karpathy: build the minimum that passes each task's check; do not build ahead of the spike's
findings. **Stop for review at each ⬛ checkpoint before proceeding.**

Guiding invariants (from the design):
- The only provider-aware code is the **adapter** (`ClaudeCodeRuntime`). Everything above `send_to_session`
  (lifecycle, relay, ownership, scheduling, steer, manager tools) is provider-blind.
- Firing (schedule/monitor/cron/steer) = **call `send_to_session`**; one durable store + one firing path +
  four trigger sources.
- Everything QiYan owns is **durable + single-fire idempotent**; everything the session owns is the transcript.

---

## Phase 0 — Spike (throwaway; de-risk the unknowns) ⬛

Goal: turn every "confirm in spike" from the design into a documented fact before building the abstraction.
Not merged; a scratch script + a findings note.

- **0.1 Drive one session end-to-end** headless: start (`claude -p … --output-format stream-json`) → capture
  `session_id` → follow-up via `--resume` → stream. Confirm context retained across turns.
- **0.2 Document the transcript schema**: dump a `~/.claude/projects/<hash>/<id>.jsonl` and map its records to
  the fields the adapter needs — per-turn `userMessage` marker (for the `clientId` round-trip / external-turn
  classification), `agentMessage`/final-text, tool events, cwd, turn boundaries, status.
- **0.3 Tool-disable + redirect**: spawn with `--disallowedTools "Monitor ScheduleWakeup CronCreate CronList
  CronDelete"` + the redirect prompt; assert the model cannot invoke each AND has no residual scheduling path
  (does not reach for `/loop` or background/hooks). Exact tool-name strings verified.
- **0.4 Steer/queue behavior**: with `--input-format stream-json` held open, does a second message injected
  mid-turn queue-for-next or nothing? (Confirms the emulation is "queue," not a Claude feature.)
- **0.5 Auth + config**: confirm API-key headless auth and `~/.claude` inheritance (non-`--bare`).

(Runtime is **headless `claude -p`** — decided; no SDK comparison.)

**Verify / exit:** a findings note with the transcript schema and the tool-disable proof. ⬛ *Review the
findings before Phase 1 — they may change the adapter shape.*

---

## Phase 1 — The Claude endpoint (Codex-protocol adapter) + transcript layer

Build so the whole existing stack (lifecycle, relay, ownership, manager tools) drives a Claude session
unchanged. Test each unit against the real lifecycle/relay with a **faked** runtime first (de-risk R1).

- **1.1 Transcript parser + `RolloutAccess`** (`src/sessions/…` new module): parse the Phase-0 schema; implement
  **both** `scan` and `scanUnmaterialized`; a Claude filename validator. Reuse the ownership DB tables +
  `inspect`/`initialize` state machine unchanged.
  *Verify:* unit tests over sample transcripts — materialized/unmaterialized/missing; owned-vs-external via the
  user-message marker.
- **1.2 Event translator** (pure function): stream-json → Codex-shaped turn/item notifications; synthesize
  `turn/completed`. *Verify:* pure-function unit tests on captured stream-json fixtures.
- **1.3 `ClaudeCodeRuntime`** — a **parallel `ManagedAppServerEndpoint`-shaped class** (NOT
  `AppServerRuntimeService` — avoid the initialize/account handshake). Implement the adapter contract (design
  §4.3): `thread/start`, transcript-reconstructed `thread/read` (+`cwd`, `clientId` round-trip, `agentMessage`/
  `userMessage` item shapes), `thread/resume`, `turn/start` (spawn `claude -p --resume` with the **stable**
  flags → translate → push synthesized `turn/completed` via `onNotification`), `turn/interrupt` (kill
  subprocess), `archive`/`unsubscribe` (local). Decide error-shape handling (reproduce vs. never-reached).
  *Verify:* drive it through the **real** `lifecycle`/`relay` with a scripted subprocess: start → turn →
  synthesized `turn/completed` → delivery; resumed turn carries context; phantom-gate drops a
  never-materialized session (uses 1.1).
- **1.4 Wire into pool / EndpointManager / config**: an endpoint `type: "claude-code"` alongside Codex; launch
  flags (system-prompt, `--mcp-config`, `--disallowedTools`, model) are **stable per session**.
  *Verify:* a Claude session is created/adopted and appears in `list_managed_sessions`; the unified manager
  tools (`send_to_session`, `get_session_status`, `get_chat_history`, `adopt_session`, `interrupt_session`)
  work against it identically to Codex.
- **1.5 Goal emulation** (the one non-transparent manager family): implement `get/set/pause/resume/cancel_goal`
  for Claude via QiYan-tracked goal state + persistence (ownership already covered by the `clientId` marker).
  *Verify:* the 5 goal tools operate on a Claude session; set-goal persists and is enforced by QiYan driving.

⬛ *Review Phase 1 (adapter correctness + manager-tool parity + phantom-gate) before Phase 2.*

Exit criterion: **a Claude session is a first-class managed session** — every manager tool except goal works by
construction; goal works via emulation; recovery reconciles it via the transcript.

---

## Phase 2 — The provider-agnostic scheduling / monitor / steer layer

One module, provider-blind, firing via `send_to_session`. Built once, tested against **both** Codex and Claude.

- **2.1 Durable schedule store** (`src/…` new DB table + migration): `(id, session, trigger_kind, trigger_spec,
  message, single_fire_key, state, next_fire_at)`. Replace the in-memory `assistant/scheduler.ts`.
  *Verify:* store/reload round-trips; survives process restart in a test.
- **2.2 Trigger engine** (provider-blind): timers (wakeup/cron) + condition poller (`monitor`, runs `check` on
  the session endpoint, floored interval) + turn-completion hook (steer). On fire → `send_to_session(session,
  message)`; **single-fire idempotent** (reuse the hardened delivery-idempotency key).
  *Verify:* a fake trigger fires exactly one `send_to_session`, never twice; mid-turn fire enqueues (steer rule).
- **2.3 Steer queue = the store with a turn-completed trigger**: `send_to_session(mode:steer)` while mid-turn →
  enqueue durably; drain FIFO on `turn/completed`; never interrupt.
  *Verify:* two steers during a running turn deliver as the next two turns, in order, single-delivery, and
  survive a simulated restart mid-turn.
- **2.4 Worker-facing MCP surface** (`src/mcp/…` new): expose the 5 tools (`schedule_wakeup/cron/monitor/
  list_schedules/cancel_schedule`) to **worker** sessions (not just the assistant) — worker auth model +
  per-session identity injection; attach via per-invocation `--mcp-config`, additive, byte-identical per turn.
  Tools are drop-in (provider-neutral descriptions); write to 2.1.
  *Verify:* a worker session (Codex and Claude) calls each tool; it registers a row; `list`/`cancel` work.
- **2.5 Recovery**: on QiYan restart, reload the store + re-arm (timers recompute next-fire / fire missed
  one-shots per policy; monitors restart poll loops; steer queues reload; goal reloads).
  *Verify:* a `schedule_wakeup` set before a QiYan restart fires **exactly one** resumed turn after restart —
  against **both** a Codex and a Claude session (proves provider-agnostic + durable + single-fire).

⬛ *Review Phase 2 (durability + single-fire + provider-agnostic proof) before finishing.*

---

## Cross-cutting

- **Tests:** each task ships its own failing-test-first per repo convention; Phase-1/2 exit criteria are
  integration tests. Keep Codex behavior byte-identical throughout (regression-lock).
- **Security/logging:** never log message bodies, tokens, or transcript contents (repo rule). `monitor` `check`
  runs with the worker's own permissions (like the agent's own Bash).
- **Sequencing:** Phase 0 gates 1; 1.1/1.2 gate 1.3; 1.3/1.4 gate the manager-tool parity; Phase 1 gates 2;
  2.1/2.2 gate 2.3/2.4/2.5. Do not build 2 before 1's adapter exists (nothing to fire into).
- **Not now (deferred):** detached-subprocess turn survival (start with child + re-drive); provider-agnostic
  pool/lifecycle refactor (only if a 3rd provider appears); warm mode (removed).

## Open decisions to close during implementation (from the design)
- Error-shape reproduce-vs-never-reached (1.3). Goal persistence mechanism (1.5: QiYan-drive vs `--settings`
  Stop hook). Cron missed-occurrence policy (2.5). (Runtime = headless `claude -p`, decided.)
