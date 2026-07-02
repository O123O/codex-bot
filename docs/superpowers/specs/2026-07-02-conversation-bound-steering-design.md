# Conversation-Bound Assistant Steering Design

## Summary

QiYan will accept messages from multiple chat adapters while running one persistent assistant thread. At most one chat conversation owns the active assistant turn. Eligible follow-up messages from that conversation use Codex app-server's native `turn/steer`; messages from every other conversation wait durably and receive the exact backend-generated acknowledgement `[system] queued`.

The backend does not expose routing metadata to QiYan, ask QiYan to select an app, or decide where within an active turn a follow-up belongs. It submits eligible follow-ups to `turn/steer` immediately and lets Codex append them to the in-flight turn.

This design replaces the current behavior in which every accepted Telegram message waits in the backend scheduler and starts a separate Codex turn. It also replaces Telegram-shaped source and delivery records with adapter-neutral bindings. Adapter-specific Slack and WeChat authentication, scopes, history tools, and transports remain separate work.

## Goals

- Let a user send follow-up text and attachments while QiYan is working.
- Use native Codex steering instead of backend timing or insertion heuristics.
- Keep one active QiYan turn globally and prevent different chat conversations from steering the same turn.
- Route QiYan output automatically to the conversation that owns the turn.
- Queue other conversations durably and acknowledge every queued message.
- Preserve per-conversation ordering, deduplication, `/pass` and `/collect` safeguards, attachment lifetimes, crash recovery, and ambiguous-request reconciliation.
- Make chat ingress and delivery general enough for Telegram, Slack, WeChat, and later adapters.

## Non-goals

- Running multiple QiYan turns concurrently.
- Combining different conversations in one assistant turn.
- Sending one assistant response to multiple destinations.
- Adding an `app`, destination, or conversation argument to QiYan's output tools.
- Prefixing user input with platform or routing metadata.
- Choosing a tool-call boundary, polling for a safe insertion point, or reproducing Codex steering logic.
- Defining Slack- or WeChat-specific credentials, permissions, history access, or event APIs.
- Changing how autonomous managed-project-session results choose a chat destination; that policy must be specified with the first additional adapter.

## Terminology

- **Adapter:** A platform integration such as Telegram or Slack.
- **Conversation:** One adapter-specific reply destination, such as a Telegram chat, Slack DM, Slack channel, or Slack thread. Two destinations in one app are different conversations.
- **Conversation key:** An opaque, stable backend key formed from adapter identity and native conversation identity. QiYan never sees it.
- **Conversation binding:** Immutable adapter ID, conversation key, adapter-owned destination JSON, and optional adapter-owned source/reply JSON.
- **Owner conversation:** The only conversation eligible to add messages to the current assistant turn.
- **Source message:** One accepted inbound chat message, including its ordered attachments.
- **Lease:** The durable single-active-turn record. Its phase is `starting`, `active`, or `terminalizing`.
- **Submission lane:** The serialized start/steer state machine for the assistant thread. Only one app-server input request may be unresolved at once.

## Chosen approach

QiYan has one active assistant turn. The first selected source assigns ownership to its exact conversation. Later messages from that conversation use `turn/steer`; other conversations remain pending until ownership is released.

This is preferred over two rejected alternatives:

1. Cross-conversation steering would require source metadata in QiYan context and make automatic output routing ambiguous.
2. Starting a new Codex turn for every message would preserve simple backend serialization but make ordinary follow-ups wait and discard Codex's native steering behavior.

Ownership is conversation-level rather than app-level. A Slack channel, Slack thread, and Slack DM cannot steer each other's turns.

### `/pass` and `/collect` safeguards

`/pass` and `/collect` are ordinary user messages. They start or steer turns under exactly the same rules as any other text or attachment message. The dispatcher does not classify them for scheduling, delay later messages, create a special turn, or tell Codex how to order its work.

Their only special behavior is deterministic tool safety. When QiYan invokes `send_to_session` or `collect_messages`, the tool gateway examines the active attempt's admitted source messages in source order. Admitted means a membership is `start_submitting`, `steer_submitting`, `uncertain`, or `submitted`; this closes the interval after app-server accepts input but before its response is persisted. If the attempt has admitted safeguards for that tool kind, each new tool-call ID must select the oldest unconsumed safeguard and exactly match its text, attachments, count, and selected session fields required by the existing safeguard. The same tool-call ID replays its existing operation, while a new call that mismatches, skips an earlier safeguard, or arrives after all admitted safeguards of that kind are consumed is rejected. If the attempt has never admitted a safeguard of that kind, the tool keeps its ordinary non-directive behavior. Newly steered safeguards extend the same FIFO. A malformed `/pass` or `/collect` candidate activates the safeguard queue and blocks that tool kind with a deterministic validation error; it never falls through to ordinary behavior.

An admitted but not yet proven-submitted safeguard blocks ordinary fallback, but its side-effecting tool action does not dispatch. The call waits for submission reconciliation. It proceeds only after the membership becomes `submitted`; if native non-acceptance is proven and the source returns to pending, the call fails with proven no effect. Once submitted, operation preparation and safeguard consumption commit atomically before dispatch. A deterministic no-effect action failure atomically releases the consumption so a later call may retry; a succeeded or uncertain action keeps the safeguard bound and cannot be replayed as a new effect.

### Internal work

Backend-generated assistant work occupies the same single active-turn slot and is never steerable:

- A destinationless event batch has no chat binding. Its model final is suppressed, and chat-output and direct-collection tools fail deterministically as unavailable for that attempt.
- A recovery source derived from a chat attempt inherits that attempt's conversation binding. Its model final remains suppressed as today, but an explicit recovery tool output can use the inherited binding.
- A destinationless recovery source behaves like a destinationless event batch.

Chat messages accepted during internal work remain pending and receive `[system] queued` once each.

## Core invariants

1. There is at most one assistant lease and one unresolved app-server input submission.
2. One turn contains sources from at most one conversation.
3. Within a conversation, source submission order is its durable `arrival_sequence` order.
4. A source is never blindly resubmitted after an ambiguous app-server result.
5. Every output record has an immutable adapter binding before it enters the outbox.
6. Every attempt membership reaches one terminal state. A source releases each inbound attachment reference exactly once only when that source becomes permanently completed or superseded, never when it is requeued.
7. QiYan never receives an app label, native destination, or queue-control message.

## Components

### Adapter registry and canonical ingress

Each adapter converts native inbound events into a canonical source containing:

- adapter ID;
- opaque conversation key and adapter-owned destination JSON;
- stable native source ID and optional reply/source JSON;
- raw user text;
- ordered attachment references; and
- adapter receipt time for diagnostics.

Canonical ingress assigns the authoritative integer `arrival_sequence`; adapter timestamps do not define ordering. The adapter registry maps `adapter_id` to the delivery implementation. Adapter-native destinations, reply handles, and receipts remain opaque JSON outside that implementation.

### Conversation turn dispatcher

The dispatcher replaces the assistant-wide FIFO user-job scheduler as the authority for assistant input. It is a single per-assistant-thread actor that owns:

- durable per-conversation message queues;
- the active lease;
- fair selection at lease boundaries;
- the one-at-a-time submission lane;
- internal-event arbitration; and
- restart reconciliation.

The actor performs small SQLite transitions under a lock but performs app-server network I/O outside the transaction. Compare-and-set state and stable client IDs prevent another actor action from overtaking unresolved I/O.

### Assistant runner and attempt context

The runner translates one source into Codex `UserInput` values. It calls `turn/start` for a lease's primary source and `turn/steer` with `expectedTurnId` for each later eligible source. Text and attachments from one source remain one ordered input.

An attempt has one primary source for existing operation idempotency and MCP context, plus an ordered durable membership relation for all steered sources. Every admitted source's attachments are made available through an attempt-scoped resolver, so a tool may safely use an attachment after native acceptance but before response persistence. The resolver maps the handle back to its original source scope and rejects attachments from unreserved pending, other-conversation, or other-attempt sources.

The MCP tool context identifies the active attempt rather than assuming every tool belongs to its primary source. Directive-aware tools resolve the oldest unconsumed admitted safeguard and require an exact match as described above; ordinary operations continue using attempt-level idempotency. For a matched safeguard, the action receives that safeguard's source ID and attachment scope while operation identity remains attempt-level. `/pass` resolves and retains its attachments from that source, and direct `/collect` uses the matched source or operation ID as its delivery key. This source association changes tool validation and resource scope only; it has no effect on Codex input scheduling.

### Delivery router

Every chat-bound attempt and tool call carries an immutable conversation binding. The following producers must use it rather than global Telegram configuration:

- normal assistant finals;
- `send_chat_message` and `send_chat_attachment`;
- direct `/collect` output and its recovery path;
- chat-derived recovery output;
- delivery warnings and queued acknowledgements.

QiYan's chat-output tools have no app, destination, conversation, or native `reply_to` argument. Thread/reply placement is part of the adapter-owned conversation binding. Late output uses its attempt's binding even if another conversation has since acquired the lease.

### Durable outbox and adapter delivery

Every delivery stores `adapter_id`, `destination_json`, optional `reply_json`, and adapter-owned `receipt_json`. The adapter registry selects the delivery worker. The generic store does not name Telegram fields or require numeric message IDs. Deterministic delivery IDs preserve current at-least-once/uncertain-delivery behavior.

## Durable state model

Migrations are append-only and introduce these concepts; exact SQL names may follow repository conventions, but their constraints are required.

### Sources

`source_contexts` gains:

- nullable `adapter_id`, `conversation_key`, `destination_json`, and `native_reply_json` for internal-source compatibility;
- unique non-null `arrival_sequence` for total order;
- whether the source is chat-bound or internal;
- `queue_notice_required` as a durable boolean; and
- adapter-qualified native deduplication rather than Telegram-only kind/source assumptions.

A singleton sequence row allocates `arrival_sequence` transactionally. Conversation queues order by this value; `context_id` is only a corruption-diagnostic tie-breaker.

### Lease and attempt membership

A singleton assistant lease stores:

- phase: `starting`, `active`, or `terminalizing`;
- attempt ID and primary source ID;
- optional conversation binding;
- stable start `clientUserMessageId`;
- active turn ID once known; and
- chat or internal trigger kind.

An `assistant_attempt_sources` relation stores one row per member source with:

- attempt and source IDs;
- source ordinal and stable `clientUserMessageId`;
- submission kind `start` or `steer`;
- state `pending`, `start_submitting`, `steer_submitting`, `submitted`, `uncertain`, `completed`, `failed`, or `superseded`;
- expected and observed turn IDs; and
- timestamps needed for reconciliation.

There is at most one row in a submitting or uncertain state for the assistant thread. A unique `(attempt_id, source_id)` and unique `(attempt_id, source_ordinal)` preserve membership and order.

Membership and `source_contexts.state` move together. Reserving a source for `start_submitting` or `steer_submitting` changes its source state from `pending` to `active` in the same transaction. Proven no-effect or an effect-free failed attempt gives the membership a terminal failed state and restores the source to `pending`. Successful completion changes both to completed. Effectful failure changes both to superseded. A source may have at most one nonterminal membership, so pending enumeration cannot select input already submitting, uncertain, or submitted.

### Attempts and deliveries

Assistant attempts persist their immutable conversation binding. Deliveries persist the adapter-neutral binding and receipt fields described above. Existing Telegram-specific columns may remain during one migration release but are no longer authoritative after backfill.

## Input and arbitration flow

### Atomic acceptance

All adapters call canonical ingress rather than inserting a source and scheduling it separately. One transaction:

1. deduplicates the adapter-qualified native source ID;
2. assigns `arrival_sequence` and persists attachments and binding;
3. decides whether the source can enter the current owner lane; and
4. when another conversation or internal turn blocks it, sets `queue_notice_required` and inserts deterministic delivery `queued:<source-id>` with exact body `[system] queued`.

If idle, the actor creates a provisional `starting` lease for the oldest eligible head in the same serialized decision. Two simultaneous idle arrivals therefore cannot both believe they own the assistant. A duplicate event creates no second source or notice; if the existing row requires a notice but the deterministic delivery is missing, ingress repairs it.

Whenever arbitration acquires a lease, the same transaction marks every pending chat source outside the selected conversation as notice-required and creates its deterministic notice if missing. If internal work wins the lease, it does this for every pending chat source. This covers a former owner message that lost a stale-steer race and becomes blocked when another conversation wins the next lease.

### Starting a turn

Before `turn/start`, the actor persists the provisional lease, attempt, primary membership row in `start_submitting`, and stable client ID. On success it atomically stores the returned turn ID, marks the source submitted, and changes the lease to `active`.

Pending messages from the owner conversation are then offered to the serialized steer lane in arrival order. Messages from other conversations remain waiting even if their arrival sequences fall between owner messages. This intentionally makes fairness operate between ownership periods rather than between individual messages.

### Steering the active turn

For one eligible owner source at a time, the actor:

1. persists an attempt-membership row as `steer_submitting` with stable client ID and the current `expectedTurnId`;
2. calls `turn/steer` immediately, without waiting for any Codex item or timer;
3. records acceptance as `submitted`; and
4. only then advances to the next owner source.

Later messages cannot overtake a submitting or uncertain source. QiYan receives only user text and attachments.

### Queue notices

Every source blocked at acceptance by another conversation or internal turn gets exactly one durable delivery:

```text
[system] queued
```

QiYan neither sees nor generates it. A failed acknowledgement retries through the ordinary adapter-neutral outbox. Startup repairs any row with `queue_notice_required = 1` whose deterministic notice delivery is missing.

### Terminalization and source lifetimes

On `turn/completed`, the actor changes the lease to `terminalizing`. It does not release ownership while a start/steer is submitting or uncertain. After reconciling that row against authoritative thread history:

- every source proven submitted to a successfully completed turn becomes completed and releases its inbound attachment references exactly once;
- a source in a failed attempt gets a terminal failed membership, but its source and inbound references remain pending when the source will be retried;
- sources not proven submitted remain pending in original arrival order; and
- output retains the terminal attempt's immutable binding.

If an attempt fails with no possibly effective operations, all submitted member sources return to pending in original order and retain their inbound attachment references. If it fails after possibly effective operations, all submitted members are superseded together by one recovery source carrying the effect receipts and inherited conversation binding; replay cannot duplicate only part of the turn. Superseding releases each source's inbound reference once, while existing operation-held and turn-held attachment references remain until their own terminal rules release them.

After terminal state is durable, the lease is removed and arbitration selects the next work item.

Terminalizing also closes the attempt to new MCP tool dispatch. Already registered handlers may finish before recovery classification. Each operation completion uses a compare-and-set from its dispatched state and attempt fence; it cannot unconditionally overwrite a terminalized or recovery-frozen result. Terminalization waits for registered handlers to drain. On bounded shutdown/timeout, it atomically fences the attempt and changes unresolved dispatched operations to uncertain before producing recovery metadata; a late handler cannot overwrite that outcome. Recovery and lease release occur only after all handlers have either settled or been fenced.

### Fairness and internal events

At a lease boundary, the next chat owner is the conversation whose head has the smallest `arrival_sequence`. Once selected, all eligible owner messages may steer until natural Codex completion; there is no backend message cap, timer, or preemption. Consequently, another conversation or an internal event can wait longer than 30 seconds while a native turn remains active. This is intentional: only Codex determines the turn boundary.

Existing event fairness applies at lease boundaries. Count completed chat or chat-derived recovery ownership periods in place of the old completed user-job count. When no lease is active, an event batch wins after five such periods or when its oldest event has waited 30 seconds; otherwise the oldest chat/recovery head wins. Event batch windows and transient-event coalescing remain unchanged. Fake-clock tests define the comparator precisely.

## App-server uncertainty and races

Codex app-server defines `turn/steer` as appending input to the currently in-flight turn without creating a new turn. The backend delegates insertion timing to that API.

### Lost `turn/start` response

The provisional lease exists before dispatch. On a lost response, the stable client ID is searched in authoritative thread history:

- Positive evidence binds the discovered turn ID and activates or terminalizes the lease according to native status.
- If an authoritative completed history with `turn.itemsView = "full"` and current thread state prove no such start exists, the source returns to pending and the lease may be released.
- If neither acceptance nor non-acceptance is proven, the lease remains unresolved and blocks competing work; the backend never starts a second turn speculatively.

### Lost `turn/steer` response

`clientUserMessageId` is a correlation key, not an assumed idempotency guarantee. Production does not retry an ambiguous steer merely because history does not yet show it:

- Positive history evidence marks the source submitted.
- A terminal turn with `turn.itemsView = "full"` and no such client ID proves it was not included; the source returns to pending for a later turn when its conversation is next selected. `summary` and `notLoaded` views are never negative evidence.
- While the expected turn remains active and evidence is absent, the row remains uncertain and blocks the lane.

A live supported-version integration test will document whether repeated steer client IDs are deduplicated. Production remains conservative unless official protocol semantics or a version-gated proven capability explicitly permits retry.

### Known stale and non-steerable turns

A rejected stale `expectedTurnId` is proven no-effect. The source stays pending for a later ownership period. Review and compact turns are non-steerable under the current generated protocol; their follow-ups remain pending until a steerable turn can start.

The backend never waits for `item/completed`, command completion, tool completion, model output, a timer, or a quiet period before an eligible `turn/steer` call.

## Restart recovery

Before accepting adapter input or scheduler work, startup:

1. runs adapter-neutral binding backfill and validates every pending/active row;
2. loads the lease, attempt membership, pending sources, and required queue notices;
3. reads the QiYan thread and reconciles provisional, active, terminalizing, and uncertain submissions;
4. hydrates `AssistantRuntime.current()` with the durable attempt and immutable binding;
5. restores the lease's provisional or active `AppServerPool` capacity claim before any pooled work resumes, even when app-server is temporarily unavailable; and
6. only then enables dispatcher arbitration and MCP tool calls.

If app-server is unavailable, the lease and queues remain frozen; the backend does not start competing work. If a matching turn remains active, ownership is retained and the one-at-a-time lane resumes. If terminal history is authoritative, terminalization completes before selecting another conversation.

Recovery never reconstructs routing from model text, the latest chat message, or global adapter configuration.

The provisional lease acquires an `AppServerPool` capacity claim before `turn/start`. That claim survives an ambiguous response, converts to an active-turn reservation on positive evidence, and releases only on proven no-effect or terminal state. Live ambiguity therefore cannot undercount capacity and allow a competing start.

## Migration and legacy backfill

The SQLite migration appends the new source, lease, membership, attempt-binding, and delivery-binding structures. Before adapters or the dispatcher start, a config-aware cutover backfills the sole existing Telegram installation:

- every retained source receives an arrival sequence allocated in stable `(created_at, id)` order and an explicit chat/internal classification;
- every retained Telegram source, including completed and superseded history, additionally receives `adapter_id = "telegram"`, a conversation key derived from the configured owner destination, and the configured destination JSON;
- active attempts and their primary source become a provisional lease/membership record only if they can be reconciled to the configured conversation and app-server history;
- every retained delivery state, including failed and confirmed history, receives the Telegram adapter binding; existing numeric reply/message IDs move into adapter-owned JSON; and
- internal event batches remain destinationless, while user-derived recovery inherits its original binding where that relation is provable.

Historical destinationless internal sources may keep null chat-binding fields. If any retained chat source or delivery, or any pending/active internal relation, cannot be classified and bound unambiguously, startup fails closed before polling or scheduling. Backfill is idempotent and records its cutover version only after all retained rows validate.

## Error handling

- Reject unauthorized adapter users before canonical ingress.
- Apply existing attachment size, media, and storage checks before acceptance commits.
- Never report `[system] queued` before the source and notice intent are durable.
- Treat notice failure as an outbound failure, not source loss.
- Reject chat-output and direct-collection tools deterministically for destinationless internal attempts.
- Do not release a lease on endpoint disconnect or terminal notification until unresolved submission state is reconciled.
- Stop new MCP dispatch during terminalization and settle or fence existing handlers before recovery classification.
- Keep unresolved ambiguity visible through system health/status warnings without guessing acceptance.
- Route unrecoverable adapter warnings through the affected binding when known; destinationless infrastructure warnings use the configured administrative warning route.

## Testing

### Dispatcher and safeguard tests

- Simultaneous idle arrivals create one provisional lease; every other conversation source atomically receives one notice intent.
- Owner ordinary follow-ups produce serialized, ordered `turn/steer` calls with the exact active `expectedTurnId`.
- No second steer begins while the previous submission is unresolved.
- A different adapter or conversation cannot steer the active turn.
- `/pass` and `/collect` follow ordinary start/steer scheduling, including multiple directives in one turn.
- Directive-aware tools consume admitted safeguards in source order, validate exact text/attachments/count, and reject a mismatch without changing scheduling.
- Safeguards remain active while their source is submitting or uncertain; malformed candidates block, same-call retries replay, and extra new calls after exhaustion fail.
- An unresolved safeguard cannot dispatch an effect; negative submission reconciliation is no-effect, deterministic action failure releases consumption, and succeeded/uncertain actions remain bound.
- Multiple steered `/pass` attachments resolve through their matched source scopes, and multiple `/collect` safeguards use distinct matched-source or operation delivery keys.
- A message blocked by internal work receives `[system] queued`.
- Duplicate native events do not duplicate Codex input or acknowledgements and repair a missing required notice.
- Conversation heads and messages use unique arrival-sequence order.

### Codex and lifecycle tests

- A follow-up received while a tool item is active calls `turn/steer` immediately without waiting for that item.
- Text and attachments remain one ordered user input, and attempt-scoped tools can access only admitted member attachments.
- Successfully completed or superseded sources release once; sources requeued after an effect-free failed attempt retain their references.
- Multi-source attempt failure requeues all members when effect-free or supersedes them as one recovery unit when effects may have occurred.
- Start crashes before dispatch, after native acceptance, and after response persistence reconcile without competing turns.
- Terminal notifications before and after every steer-state write do not lose or duplicate a source.
- A stale owner steer that returns to pending receives its notice if another conversation wins the next lease.
- A blocked side-effecting MCP handler cannot overwrite a terminalized uncertain/recovery outcome.
- Ambiguous steer absence does not trigger blind retry; positive client-ID evidence reconciles acceptance.
- `summary` and `notLoaded` terminal histories never prove client-ID absence.
- Stale and non-steerable cases preserve the source for a later eligible turn.
- A live app-server test records supported-version client-ID visibility and any proven steer deduplication behavior.

### Routing, recovery, and migration tests

- Finals, chat tools, attachments, direct collection, recovery output, notices, and warnings use immutable adapter bindings.
- Destinationless attempts suppress finals and reject chat-output tools.
- Late output from a completed turn cannot move to the next owner.
- Adapter-owned destination, reply, and receipt JSON round-trip without numeric Telegram assumptions.
- Restart hydrates runtime context and pool capacity before MCP or scheduling resumes.
- An ambiguous live `turn/start` retains its provisional pool capacity claim until acceptance or no-effect is proven.
- Restart with an unresolved `starting` lease restores its provisional capacity claim before endpoint recovery or other pooled work.
- Restart with stale or uncertain ownership releases it only after authoritative reconciliation.
- Failed deliveries retry without rerunning QiYan.
- Fake-clock arbitration preserves five-period and 30-second event priority at lease boundaries.
- A legacy fixture with pending/completed/superseded Telegram sources, retained destinationless internal sources, an active attempt, and prepared/dispatched/uncertain/confirmed/failed deliveries backfills idempotently; ambiguous rows fail closed.
- Telegram remains the supported adapter and eligible same-chat follow-ups now steer the active turn. Removing QiYan's numeric `reply_to` tool arguments is an intentional adapter-neutral compatibility change; normal replies continue to use the conversation binding.

## Documentation impact

Shared documentation will explain that QiYan supports one active conversation at a time, same-conversation follow-ups—including `/pass`, `/collect`, and attachments—steer the active Codex turn, and other conversations receive `[system] queued`. Adapter guides define native conversation and thread identity. QiYan's `AGENTS.md` needs no source-routing instructions because routing is backend-owned.

## Acceptance criteria

Implementation is complete when it demonstrates all of the following:

1. An eligible second message from the active conversation reaches native `turn/steer` while QiYan is still working.
2. No backend code selects a Codex item boundary or inserts platform metadata into QiYan input.
3. Another conversation's message and acknowledgement intent commit atomically, and that message cannot affect the active turn.
4. `/pass` and `/collect` steer like ordinary messages while remaining exact, ordered, and one-time safeguards under the multi-source attempt model.
5. Text and attachment sources have deterministic membership, terminal state, and reference release.
6. All chat output uses immutable adapter bindings without a QiYan app/destination argument.
7. Completion races, ambiguous app-server results, delivery failures, duplicates, migration, and restarts preserve accepted messages without blind duplicate submission or competing turns.
