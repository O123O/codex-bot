# Bounded Codex Recovery

> Historical note: ownership initialization described here was removed in July 2026. Bounded native App Server history remains in use for recovery and Web UI paging.

## Problem

Codex `thread/resume` traditionally returns every reconstructed turn in one JSON-RPC response. QiYan's remote App Server transport intentionally limits WebSocket frames to 1 MiB, so a long-lived worker can close the connection during recovery. Raising the frame limit only postpones the failure and increases resource exposure.

Using `thread/resume { excludeTurns: true }` fixes only the first response. Endpoint recovery also reconciles capacity claims, missed terminal deliveries, queued observations, and the assistant's startup state. Those paths must not follow the lightweight resume with `thread/read { includeTurns: true }`.

`excludeTurns` changes only the response projection. Codex still reconstructs the persisted rollout into the resumed model session, so future turns retain their prior context. It does not truncate or rewrite the rollout.

## Design

QiYan requires Codex 0.144.4 and uses its experimental paginated history APIs for recovery:

- Resume every Codex thread with `excludeTurns: true`.
- Read thread status, cwd, and rollout path with `thread/read { includeTurns: false }`.
- Read recovery turn metadata through `thread/turns/list`, in descending order with `itemsView: "notLoaded"` and a page limit of 128. This keeps each response independent of message/tool-output size while avoiding one rollout reconstruction per individual turn.
- Locate an exact turn through metadata-only `thread/turns/list` pages, then fetch only that turn with `limit: 1` and `itemsView: "full"`. The cursor is derived from a verified metadata prefix so unrelated turn bodies never cross the transport.
- Never call `thread/items/list`: the method appears in generated protocol types but released Codex app servers reject it as unsupported.
- Treat the exact pre-first-message `thread/turns/list is unavailable` error as an empty history, just like the existing exact `includeTurns is unavailable` case. Near-match errors remain failures.
- Keep the 1 MiB WebSocket frame limit.

The App Server transport owns a small typed page reader so session lifecycle, capacity claims, relay recovery, observations, assistant startup, and durable operation reconciliation share cursor validation and exact empty-history handling. The reader does not persist message flow. Callers scan 128 metadata-only turns at a time, then fetch one exact full turn when bodies are required. A single turn still has no protocol byte bound; if it alone exceeds the 1 MiB transport limit, recovery fails safely and retries instead of weakening the transport limit. Ordinary history length can no longer make one response grow without bound.

The page reader enforces these invariants before exposing buffered results to a caller:

- Page cursors are opaque, non-empty when present, and must advance. A repeated cursor, duplicate turn/item ID, an empty page with a continuation cursor, or an invalid response is an uncertain operation and produces no side effects.
- A descending suffix scan buffers every result until it finds the requested durable delivery cursor or epoch baseline. If an anchor was expected but exhaustion occurs without finding it, the scan is uncertain: no delivery is committed and no cursor advances.
- With no expected anchor, normal exhaustion proves the beginning of the thread and makes the buffered suffix authoritative.
- An exact target missing before authoritative exhaustion is uncertain. Once an anchor is found, a target at or older than the anchor is conclusively outside the managed epoch; a newer target missing from the buffered suffix remains uncertain.
- Consumers reverse an authoritative descending suffix before applying changes, so commits remain chronological. A nonterminal turn stops terminal delivery and leaves later work pending.

### Provider contract

Pool and relay recovery are provider-neutral. Codex calls use App Server's native `thread/turns/list` method. `ClaudeCodeRuntime` implements the same method over positional transcript windows: 256 KiB for metadata pages and a bounded exact full turn. Its opaque cursor pins device, inode, and size, and remote windows cross SSH through a byte-capped response. The generic reader has no full-thread provider fallback.

### Managed worker recovery

Recovery reads one latest `notLoaded` turn for the delivery baseline, then resumes without turns. The current-generation native snapshot/notification is authoritative; a latest bounded turn page only resolves an ID-less active snapshot. The exact pre-first-message pagination error is classified as an empty latest-turn result, so a managed thread that has never received a user message remains restorable.

### Capacity claims

Endpoint claim reconciliation reads metadata once and scans descending `notLoaded` pages. Active claims match exact turn IDs. Before every new implicit or durable provisional start, QiYan persists the latest turn ID (or an explicit empty-history baseline) before dispatch. Reconciliation considers only the suffix newer than that baseline and hydrates exact full turns only for candidates in that suffix. Nonterminal candidates are rescanned because their user item may not have materialized yet. Restored claims from older versions that lack a baseline remain unresolved rather than scanning historical bodies or proving absence. Claims are released as absent only after an idle thread's bounded suffix is authoritative; a partial or malformed scan never proves absence.

### Terminal relay

The relay scans backward only until the durable delivery cursor or epoch baseline and does not commit while searching for that anchor. It reverses the authoritative bounded suffix to preserve chronological delivery and stops at the first nonterminal turn. A live `turn/completed` notification whose embedded turn has `itemsView: "full"` is carried through generation validation and committed directly, preserving every explicit final item without rereading history. Minimal live notifications and missed-notification recovery fetch the exact full turn. Retried exact targets use the same paginated suffix and never full-read the rollout.

### Assistant startup

Completed conversation-cutover state needs no assistant history. An unfinished one-time cutover pages metadata turns and validates the exact retained active turn; it never required message bodies. Normal startup uses the status returned by resume to decide whether deferred post-turn actions can drain. Assistant dispatcher recovery uses metadata plus exact-turn items when client correlation is required, and observation recovery uses metadata only.

### Automatic operation recovery

Every automatic recovery/reconciliation call site is part of this migration, including startup operation replay and AppServerPool's uncertain start/interrupt reconciliation. Send recovery finds exact turn status and client correlation through metadata plus one exact full turn. Goal recovery uses the authoritative goal API plus metadata when it must authorize an active turn. Compact/model recovery fetches the exact compact turn to find `contextCompaction` items instead of scanning the whole thread. Interrupt recovery locates the exact/active turn through metadata pages. Attachment terminal checks, deferred assistant compaction, assistant status recovery, and active-turn authorization use the same bounded projections. No Codex reconnect, endpoint-ready callback, startup replay, retry timer, or operation reconciler may issue `thread/read { includeTurns: true }`; Claude is bounded by the same provider-neutral page contract.

Interactive actions whose explicit purpose is to show/read native history may retain a full-read implementation for now, provided they are never invoked automatically during endpoint recovery. A repository-level call-site audit test enumerates the remaining full reads and fails if one appears outside those named interactive boundaries.

## Implementation plan

1. Add failing contract tests for the shared page reader, exact empty-thread classification, Codex resume persistence, and Claude's bounded adapter.
2. Implement typed turn/item paging and cursor validation, including positional Claude transcript windows.
3. Replace recovery-time full reads in lifecycle, capacity reconciliation, terminal relay, assistant cutover/dispatcher, observations, durable operation replay, pool start/interrupt reconciliation, deferred actions, and attachment/status checks. Keep only audited explicit interactive full-history APIs unchanged.
4. Run focused recovery tests, the full `npm run check`, and the same-reviewer code review. Re-run both after every accepted finding.
5. Squash-merge the feature/notification chain to `main`, exclude the abandoned WebSocket-limit increase, delete the superseded task branches, push, deploy, and validate a long remote worker in place.

## Safety and verification

Tests must prove:

- Resume responses contain no turns while the fake server's persisted history remains unchanged and later pagination still returns it.
- Active-turn and goal ownership survive connection replacement.
- Empty, never-materialized workers recover successfully.
- Codex claims, relay endpoint wake, assistant startup, and Claude recovery never issue an unbounded `thread/read { includeTurns: true }`.
- Every automatic operation/start/interrupt/retry reconciliation path avoids full reads; an allowlisted source audit prevents new recovery-time full reads.
- Cursor pages preserve baseline/delivery ordering and exact absence rules; malformed, repeated, and missing-anchor pages have no side effects.
- Codex uses bounded native paging. Claude exposes the same reader contract through snapshot-pinned positional windows, with tests proving the runner never returns more than the requested bytes. Exact-turn item paging preserves multiple final responses where supported, and the exact legacy-Codex-store fallback is tested to recover only the summary's last agent response without a full read.
- The 1 MiB WebSocket bound remains enforced.

After deployment, record the existing worker rollout size and latest turn ID, restart QiYan, and verify the same latest turn remains pageable while the worker reconnects without a large frame or repeated endpoint outage.
