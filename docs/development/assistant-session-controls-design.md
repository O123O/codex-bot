# Assistant session controls

## Goal

Treat QiYan's own Codex thread as the reserved session target `assistant` for the
existing session-management tools. Add native session compaction, expose QiYan's
live status/model/effort in the Web UI, and allow an unavailable-but-registered
worker's active turn to be interrupted.

The implementation must not create a parallel `manage_qiyan_*` tool family.

## Target model

Production resolves a tool target once:

- `assistant` resolves to the assistant registry identity and runtime row.
- Every other nickname resolves through the managed worker registry.

Read/status and pending model/effort operations use that common identity. Worker
execution remains behind `SessionService`; assistant execution remains behind the
assistant dispatcher because its turn is the one invoking the tool.

`restart_endpoint` accepts the assistant endpoint id (`assistant-local` in the
built-in configuration). Project endpoint resolution remains unchanged for tools
that create or discover workers.

## Post-turn actions

Compacting or restarting QiYan synchronously from its own tool call is unsafe: the
request is executing inside the turn or app-server it would modify. Add a small
`AssistantPostTurnActions` component with a durable table:

```text
assistant_post_turn_actions
  id             operation id (primary key)
  kind           compact | restart
  payload_json   exact target identity needed by the handler
  state          pending | running | completed | failed
  created_at
  updated_at
  error_json
```

`schedule()` is idempotent by operation id. The tool returns only after the pending
row is durable, with `{ scheduled: true, actionId }`. A scheduled action therefore
means accepted for post-turn execution, not already completed.

One serialized `drain()` claims actions in creation order and invokes injected,
kind-specific handlers. Each action persists its native pre-dispatch evidence before
issuing a native request. Startup reconciles stale `running` rows from that evidence
instead of blindly repeating them:

- `compact` persists the full set of native `contextCompaction` item ids visible in
  authoritative idle history, then dispatches `thread/compact/start`. Recovery
  marks it complete if history contains a new compaction item; it dispatches only
  when the persisted baseline still exactly matches authoritative full history.
  An incomplete history leaves the action pending instead of guessing.
- `restart` persists the exact runtime process identity present when the action is
  scheduled. It shuts down only that identity. Recovery treats a different current
  identity as proof that replacement already happened; no identity means shutdown
  completed and start/resume remains; the same identity resumes exact shutdown.

Drain post-turn actions after the terminal turn and final messages are committed,
but before enqueueing the next assistant input. `ConversationDispatcher` also gains
a start-admission hook. When it sees a pending candidate with no conversation lease,
it runs the hook before claiming capacity, acquiring a conversation lease, or
reserving a submission. Only a successful admission pass reopens the pump. The hook
awaits the same serialized drain, closing the race where new chat input arrives
while terminal processing is finishing without ever creating a false uncertain
native submission. Startup drains only after authoritative native history proves
the assistant thread has no active turn.

Failures are retained as `failed` rows and reported as operational events; they do
not create an automatic assistant turn that could loop on a failing restart.

There is one durability window between inserting the action row and the generic MCP
tool wrapper marking its operation succeeded. Operation recovery handles
`compact_session(assistant)` and `restart_endpoint(assistantEndpointId)` specially:
an exact action row proves that scheduling committed, so recovery succeeds the MCP
operation with its scheduled receipt; absence of the row proves no scheduling
effect. `schedule()` idempotently verifies an existing row's kind and payload.

## Tool behavior

- Add `compact_session({ nickname })`.
  - A worker must be managed and idle; compaction runs immediately through its
    endpoint work lease and thread gate.
  - `assistant` schedules a post-turn compact action.
- `get_session_status`, `set_session_model`, and `set_reasoning_effort` accept
  `assistant`.
  - Assistant settings are stored as pending settings in `RuntimeStore`.
  - The assistant runner applies them to its next `turn/start` and consumes them
    only after native dispatch succeeds, matching worker Codex behavior.
- `restart_endpoint({ endpoint: assistantEndpointId })` schedules a post-turn
  restart. Other endpoints retain the existing immediate manager workflow.
- `interrupt_session({ nickname: "assistant" })` is rejected with an explicit
  unsupported-capability error: a tool cannot both return into and interrupt the
  turn that is executing it. External service shutdown keeps its existing direct
  interrupt path.
- Goal tools remain worker-only. The assistant thread is not a supervised worker
  goal target.

The assistant policy documents the reserved target and scheduled semantics in one
short rule; individual tool descriptions stay minimal.

## Unavailable worker interrupt

Do not weaken the `managed` invariant used by sends, goal mutation, or settings.
Add a narrow registered-control lookup for interrupt only:

1. Require the registry mapping to still be `managed` and capture its mapping id.
2. Acquire the endpoint mutation lease and thread gate.
3. Require its runtime state to be `managed`, or `unavailable` with restore state
   exactly `managed`; revalidate the same condition and exact registry mapping under
   the lease and gate.
4. Read authoritative native history after the endpoint is ready, resolve the
   active turn (or prove the requested turn terminal), perform the ownership
   check, and interrupt that exact turn.
5. Reconcile the runtime active-turn state.

`SessionService.interrupt` returns the resolved turn id, so callers no longer invoke
the stricter `activeTurnId()` before recovery. Endpoint restart continues to require
idle managed threads; after interrupt is fixed, that safety check no longer creates
the contradictory dead end.

## Assistant status and Web UI

Keep the worker sessions array worker-only. `/api/sessions` and its WebSocket update
gain a separate `assistant` summary with the same display fields. Production builds
it without polling:

- identity/cwd/endpoint from the assistant registry;
- management/native/active state from `RuntimeStore` and assistant runtime;
- current model/effort captured from resume responses, successful turn starts, and
  `thread/settings/updated` notifications;
- pending model/effort from `RuntimeStore` takes display precedence.

The QiYan tab renders the same small status line/dot used by workers, and the shared
context strip below the composer shows provider, model, effort, cwd, and host.

## Verification

Tests are added before implementation for:

- durable post-turn scheduling, ordering, serialization, restart recovery, and
  failure persistence;
- tool schema/catalog and replay behavior for `compact_session`;
- immediate idle worker compaction and busy rejection;
- assistant target status/settings/compaction/restart wiring;
- next-turn application and successful consumption of assistant settings;
- unavailable registered worker interrupt using authoritative history, including
  stale/wrong turn rejection;
- Web read/API/WebSocket shape and QiYan status/context rendering;
- migration creation/reopen behavior.

Run focused tests while iterating, then `npm run check` before the signed commit.
