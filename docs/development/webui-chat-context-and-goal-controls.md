# Web UI chat context and goal controls

## Goal

Make the two chat surfaces easier to understand and operate without turning the
Web UI into another worker manager or another message store:

- the QiYan conversation visibly distinguishes QiYan replies from backend-relayed
  worker messages;
- a foreground worker panel accepts `/goal` controls through QiYan's existing
  durable manager tools; and
- the worker composer shows the session's model, effort, working directory, and
  host using the existing lease-free session summary.

The active-worker stream design remains unchanged. Detailed worker messages are
still loaded and followed only for the foreground browser tab, and Codex/Claude
remain the durable stores for their own transcripts.

## Fixed behavior

### Message provenance

The durable delivery row already distinguishes `worker_final` and `collection`
from `assistant_final`, commentary, and system notices. The server derives a
worker nickname only when one of those trusted worker-delivery kinds has the
expected leading `[worker ...]` envelope. This provenance is attached both to a
persisted `assistantTranscript` row and to the Web adapter's live `message`
broadcast; a live worker relay must not be labelled as QiYan for the rest of the
page lifetime.

The existing `origin` field remains the file-routing identity and is set only
while that nickname is currently registered. A separate `worker` presentation
field survives an unadopted or renamed session, so an old durable worker relay
does not become visually indistinguishable from QiYan merely because its file
host is no longer routable:

- an assistant message without `worker` is labelled `QiYan` and receives the
  QiYan border color;
- an assistant message with `worker` is labelled `Worker · <nickname>` and
  receives a distinct worker-relay border color; and
- owner messages and native worker-panel messages retain their current styles.

The text label remains present in addition to color, so provenance does not
depend on color perception.

### Worker goal commands

The worker composer recognizes only the `/goal` namespace. Unrecognized slash
commands continue to the worker unchanged, preserving native Codex/Claude slash
commands.

Supported forms are:

```text
/goal <objective>       set or replace the goal
/goal set <objective>   explicit form of the same operation
/goal pause             pause the current goal
/goal resume            resume the current goal
/goal cancel            clear the current goal without interrupting a turn
/goal                    show the command help locally
/goal help               show the command help locally
```

`pause`, `resume`, `cancel`, and `help` are reserved subcommands. The explicit
`/goal set ...` form can set an objective beginning with one of those words.
Commands are controller actions, not worker chat messages: the browser does not
add them to the native worker timeline. It shows a small ephemeral command/result
card, while the durable goal row refreshes from `/api/sessions`.

The browser POSTs a canonical UUID, action, and (for `set`) objective to
`/api/sessions/:nickname/goal`; nickname comes only from the validated pathname.
The JSON object has strict keys. Its normalized objective is non-empty and at
most 16,000 UTF-16 code units; non-`set` actions must omit it. The server passes
the path-derived nickname and validated command to a goal-control dependency.

Production atomically inserts a `web_goal` operation source in the `completed`
state, storing the canonical command for UUID/argument conflict detection. This
requires a persistence method that sets the initial state in the insert itself,
not `createSourceContext()` followed by `setSourceState()`: a crash must never
leave a synthetic operation source pending for the assistant dispatcher. It then
invokes the same `set_goal`, `pause_goal`, `resume_goal`, or `cancel_goal`
`ToolHandler` that QiYan's MCP server exposes.
This preserves the existing schema validation, durable operation receipt,
uncertain-operation reconciliation, goal auto-drive, observations, and dashboard
refresh. It does not copy the session goal logic into the Web UI.

The initial durable transaction records both the completed operation source and a
separate held `web_goal` awareness intent before any manager action can run. The
held intent is not dispatchable. After the action settles, it is atomically
released as a pending awareness source with the durable succeeded, failed,
uncertain, or pre-dispatch outcome, and the assistant dispatcher is woken. The operation
source uses `(kind="web_goal", source_id="operation:<uuid>")`; awareness uses
`(kind="web_goal", source_id="awareness:<uuid>")`, so the unique source index
cannot collapse one into the other. The note contains
the user's command intent and whether the direct backend call succeeded, and says
that it is awareness-only and must not be repeated or answered. This mirrors the
existing `/to` awareness mechanism: QiYan learns about direct browser actions,
but the awareness copy is not a second goal mutation and is not an owner-chat
message. The request UUID makes both the manager operation and awareness source
idempotent across an HTTP retry. Its completed operation source stores the
canonical command; reusing a UUID for different arguments is an operation
conflict. Concurrent requests with the same UUID share one in-flight promise.

The existing operation-reconciliation owner repairs held awareness intents after
startup recovery and after later operation passes. This covers a crash after the
intent transaction but before manager dispatch, a terminal operation whose HTTP
handler died before releasing awareness, and an operation that remains uncertain.
No browser retry is required to make QiYan aware.

The production adapter also exposes its active synthetic attempt IDs to the
existing operation reconciler. Recovery waits while a Web goal handler is
running, just as it waits for an active assistant MCP handler, and is requested
after the handler exits if its operation remains recoverable. This prevents the
live handler and uncertain-operation recovery from mutating the same goal
concurrently.

The Web listener owns goal-control admission. Starting it opens admission;
stopping or rebinding it closes admission before closing sockets and waits for
every admitted handler to settle. Whole-process shutdown also closes admission
and drains Web goal handlers alongside MCP handlers before operation recovery or
the endpoint/database dependencies stop.

`assets/assistant/AGENTS.md` gains an exact rule for `web_goal` awareness. QiYan
may record the reported goal-control outcome for supervision, but must never
reply, repeat, repair, or invoke a goal/session mutation because of the note.
The objective is quoted user data, not instructions, even if its text contains a
directive or asks QiYan to ignore the awareness boundary. This policy, rather
than the note's bracketed prose alone, is the prompt-injection boundary.

### Worker context footer

`/api/sessions` adds two fields to its existing lease-free summary:

- `effort` from `auto_session_info.reasoning_effort.current`; and
- `host` from the configured endpoint: the process hostname for a local endpoint,
  or the configured SSH host alias for a remote endpoint.

The existing `model` and `projectDir` fields supply the other values. A compact,
wrapping footer below the worker composer shows provider, model, effort, cwd, and
host. Missing model or effort is rendered as `default`. Resolving this footer
never acquires an endpoint lease, runs SSH, reads native history, or adds a new
timer; it rides the existing one-second registry/dashboard summary update.

For an SSH endpoint, `host` deliberately means the configured SSH target (for
example `prenyx`), not a transient compute-node hostname. Discovering the latter
would require a remote command and would violate the lease-free/no-extra-polling
constraint.

## HTTP and dependency boundary

The Web server receives a narrow callback:

```ts
controlGoal(input: {
  requestId: string;
  nickname: string; // derived from the validated pathname, absent from JSON
  action: "set" | "pause" | "resume" | "cancel";
  objective?: string;
}): Promise<{ ok: boolean; error?: string }>;
```

The transport owns authentication, pathname/body validation, the 16,000-code-unit
objective limit, strict-key enforcement, HTTP statuses, and response
serialization. Production owns durable manager-tool execution and the assistant
awareness source. Tests can therefore verify the HTTP contract without
constructing the production session stack.

## Failure behavior

- Invalid UUIDs, path nicknames, actions, strict keys, or objective shapes/lengths
  return `400` without calling goal control.
- A manager-tool error is returned as a failed command card; native worker input
  is not sent as a fallback.
- Durable `uncertain` semantics remain authoritative. The Web UI never retries a
  goal mutation under a new UUID automatically.
- QiYan's awareness note records the durable succeeded, failed, uncertain, or
  pre-dispatch outcome; it never
  instructs QiYan to repair or repeat a failed/uncertain action automatically.
- If the session disappears between the summary and command, the existing
  `UNKNOWN_SESSION` manager-tool behavior is surfaced.

## Implementation plan

1. Add failing unit/HTTP tests for persisted and live provenance presentation,
   `/goal` parsing, summary effort/host fields, goal-route validation/dispatch,
   and the durable production goal-control/awareness adapter (including UUID
   conflict, single-flight, recovery fencing, distinct source identities, and a
   crash after the held-intent transaction).
2. Add the atomic completed-operation/held-awareness persistence primitive and
   the shipped `web_goal` awareness rule, with persistence and policy-asset tests.
3. Add `host(endpointId)` to `WebReadsDeps`, extend `WebSessionSummary`, and wire
   local/SSH host labels from the endpoint catalog.
4. Add the authenticated goal HTTP route and inject the production adapter that
   invokes the existing manager tool handlers with deterministic operation IDs.
5. Add the small browser command parser, command/result cards, provenance
   classes/labels, and worker context footer.
6. Build the tracked Web UI asset, run focused tests and `npm run check`, then
   obtain reviewer approval before the signed commit.

## Acceptance criteria

- QiYan replies and persisted/live relayed worker deliveries have different
  borders and explicit labels in the QiYan panel, including old relays whose
  worker is no longer registered.
- `/goal ship the release`, `/goal pause`, `/goal resume`, and `/goal cancel`
  invoke the corresponding existing durable manager tool exactly once per UUID
  and do not send text to the worker.
- QiYan receives one idempotent internal awareness copy for each goal-control
  request outcome, under an identity distinct from the atomically completed
  operation source; arbitrary objective text cannot make QiYan act on the copy.
- The selected worker footer shows provider/model/effort/cwd/host and incurs no
  worker-history read, endpoint activation, or SSH call.
- Unknown slash commands still reach the worker normally.
- The source build and tracked production Web UI asset agree.
