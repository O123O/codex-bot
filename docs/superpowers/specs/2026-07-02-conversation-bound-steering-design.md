# Conversation-Bound Assistant Steering Design

## Summary

QiYan will accept messages from multiple chat adapters while running one persistent assistant thread. At most one chat conversation owns the active assistant turn. Follow-up messages from that conversation use Codex app-server's native `turn/steer`; messages from every other conversation wait durably and receive the exact backend-generated acknowledgement `[system] queued`.

The backend does not expose routing metadata to QiYan, ask QiYan to select an app, or decide where within an active turn a follow-up belongs. It submits eligible follow-ups to `turn/steer` immediately and lets Codex append them to the in-flight turn.

This design replaces the current behavior in which every accepted Telegram message waits in the backend scheduler and starts a separate Codex turn. It establishes the shared routing layer required by later Slack and WeChat adapters; adapter-specific authentication, scopes, history tools, and transport behavior remain separate work.

## Goals

- Let a user send follow-up text and attachments while QiYan is working.
- Use native Codex steering instead of implementing backend timing or insertion heuristics.
- Keep one active QiYan turn globally and prevent different chat conversations from steering the same turn.
- Route QiYan output automatically to the conversation that owns the turn.
- Queue other conversations durably and acknowledge every queued message.
- Preserve ordering, deduplication, crash recovery, and ambiguous-request reconciliation.
- Keep the chat adapter boundary general enough for Telegram, Slack, WeChat, and later transports.

## Non-goals

- Running multiple QiYan turns concurrently.
- Combining messages from different conversations into one assistant turn.
- Sending one assistant response to multiple apps or conversations.
- Adding an `app`, destination, or conversation argument to QiYan's output tools.
- Prefixing user input with platform or routing metadata.
- Choosing a tool-call boundary, polling for a safe insertion point, or otherwise reproducing Codex steering logic.
- Defining Slack- or WeChat-specific credentials, permissions, history access, or event APIs.
- Changing the routing policy for autonomous managed-project-session results; that policy must be specified with the adapter that first needs it.

## Terminology

- **Adapter:** A platform integration such as Telegram or Slack.
- **Conversation:** One adapter-specific reply destination, such as a Telegram chat, Slack DM, or Slack channel. Two destinations in one app are different conversations.
- **Conversation key:** An opaque, stable backend key formed from adapter identity and the adapter's native conversation identity. QiYan never sees it.
- **Owner conversation:** The only conversation allowed to add messages to the current assistant turn.
- **Waiting conversation:** A conversation with durable pending messages while another conversation owns the turn.
- **Source message:** One accepted inbound chat message, including its ordered attachments.

## Chosen approach

### Conversation-bound active turn

QiYan has one active assistant turn. The first selected source message assigns ownership to its conversation. Later messages from the same conversation use `turn/steer`; messages from other conversations remain pending until ownership is released.

This is preferred over two rejected alternatives:

1. Cross-conversation steering would require exposing source metadata to QiYan and would make automatic output routing ambiguous.
2. Starting a new Codex turn for every message would preserve simple backend serialization but make follow-up messages wait unnecessarily and discard Codex's native steering behavior.

Ownership is conversation-level rather than app-level. A Slack channel and a Slack DM cannot steer each other's turns even though they use the same adapter.

Existing backend-generated assistant work, such as recovery prompts or managed-session metadata events, is an internal source rather than a chat conversation. An internal turn occupies the same single active-turn slot but has no chat destination and cannot be steered by chat input. Chat messages accepted during an internal turn remain pending and receive `[system] queued`; existing batching and priority rules for internal sources otherwise remain unchanged by this design.

## Components

### Chat adapter

Each adapter converts native inbound events into a canonical source message containing:

- adapter identity;
- opaque conversation key and adapter-owned reply destination;
- stable native source ID for deduplication;
- raw user text;
- ordered attachment references; and
- receipt time.

The adapter sends canonical outbound deliveries to their recorded native destination. It does not own assistant scheduling or inspect Codex state.

### Conversation turn dispatcher

The dispatcher replaces the current assistant-wide FIFO job scheduler as the authority for assistant input. It owns:

- the durable pending messages for each conversation;
- the active ownership record;
- fair selection of the next conversation;
- submission state for `turn/start` and `turn/steer`; and
- recovery after backend or app-server restarts.

The active ownership record includes the conversation key, QiYan thread ID, active turn ID, and the source message that started the turn. The record is persisted before later input or output can depend on it.

### Assistant runner

The runner translates canonical source messages into Codex `UserInput` values. It uses:

- `turn/start` for the first message after a conversation receives ownership; and
- `turn/steer` with the required `expectedTurnId` for every subsequent owner-conversation message while that turn remains active.

Text and attachments from one source message are submitted together and retain adapter order. The runner calls `turn/steer` as soon as the durable dispatcher selects the message. It does not observe tool-call events to decide when to submit.

### Delivery router

Every assistant attempt and tool invocation carries an immutable conversation binding derived from the owning source message. Normal final responses, `send_chat_message`, and `send_chat_attachment` use that binding automatically. Their QiYan-facing schemas do not gain an app or destination parameter.

The delivery router must not read a mutable global "current conversation" when creating a delivery. A completed turn's late events must still go to that turn's owner even if the next conversation has already acquired ownership.

### Durable stores

SQLite remains authoritative for source-message, operation, and delivery state. The schema must represent:

- adapter and conversation identity for every source message;
- per-conversation pending order;
- the active conversation/turn lease;
- start or steer submission state and `clientUserMessageId`;
- immutable attempt-to-conversation delivery bindings; and
- the backend-generated queued acknowledgement.

Adapter-native destinations remain backend data and are never placed in QiYan context.

## Input flow

### Accepting a message

For every owner-authorized inbound event, the backend atomically deduplicates and persists the source message before scheduling it. A duplicate native source ID returns the existing record and creates neither another Codex input nor another queued acknowledgement.

### Starting from idle

When no assistant turn is active, the dispatcher selects the waiting conversation whose oldest pending message has the earliest receipt order. It persists ownership, submits that conversation's first message through `turn/start`, and records the returned active turn ID.

If that conversation already has more pending messages, the dispatcher submits them in source order through native `turn/steer`. Messages from other conversations remain waiting even when their receipt times fall between messages from the owner conversation. Fairness is between conversation ownership periods, while ordering within each conversation is strict FIFO.

### Receiving from the owner conversation

While a turn is active, each newly persisted message from its owner conversation is submitted immediately with `turn/steer`, the active `expectedTurnId`, and a stable `clientUserMessageId`. Codex decides when and how the appended input affects the in-flight work.

QiYan receives only the user's text and attachments. It receives no app prefix, chat metadata, queue metadata, or destination instruction.

### Receiving from another conversation

A message from any non-owner conversation remains pending. After persistence, the backend creates an ordinary durable system delivery to that same conversation with the exact body:

```text
[system] queued
```

The backend sends this acknowledgement for every queued source message. QiYan neither sees nor generates it. If acknowledgement delivery fails, the normal delivery outbox retries it; the source message remains queued regardless of acknowledgement state.

### Completing a turn

On terminal `turn/completed`, the backend finishes the owning attempt and releases ownership only after all terminal state needed for deterministic recovery is durable. It then chooses the waiting conversation with the oldest pending message. All assistant events retain the immutable binding of the turn that emitted them.

## Steering contract and races

Codex app-server defines `turn/steer` as appending user input to the currently in-flight turn without creating a new turn. The backend delegates insertion timing to that API.

Every steering request includes the persisted active turn as `expectedTurnId`. The following cases are explicit:

- **Accepted:** Record the returned turn ID and mark that source message submitted.
- **Known stale or no active turn:** Keep the source message pending. Once terminal state is reconciled, it becomes input to the next turn rather than being dropped.
- **Ambiguous transport result:** Reconcile the stable `clientUserMessageId` against app-server thread/turn history before retrying. Never submit a second copy merely because the response was lost.
- **Non-steerable turn:** Keep the message pending and start it after the non-steerable turn ends. Current generated protocol types identify review and compact turns as non-steerable.

The backend must not wait for an `item/completed`, command completion, tool completion, model boundary, timer, or quiet period before calling `turn/steer`.

## Recovery

On startup, the dispatcher loads pending source messages and the active ownership record before accepting new scheduling work. It reads the QiYan thread from app-server and reconciles:

- If the recorded turn is still active and matches the persisted turn ID, retain ownership and continue submitting pending owner-conversation messages.
- If no matching turn is active, reconcile terminal and ambiguous operations, release stale ownership, and select the next pending conversation.
- If app-server is unavailable, preserve ownership and queues without starting a competing turn; retry through the existing endpoint recovery policy.
- If the backend crashed before a queued acknowledgement was confirmed, retry the same durable delivery ID.

Recovery never reconstructs destination routing from model text or from whichever conversation most recently sent a message.

## Error handling

- Reject unauthorized adapter users before creating a canonical source message.
- Keep malformed or oversized attachments under the adapter and attachment-store policies already applied to inbound files.
- Do not acknowledge a message as queued until its pending state is durable.
- Treat a failure to deliver `[system] queued` as an outbound delivery failure, not as loss of the accepted source message.
- Keep a failed `turn/start` message pending unless reconciliation proves that app-server accepted it.
- Do not release conversation ownership on a transient endpoint disconnect without reconciling the active turn.
- Surface repeated unrecoverable adapter or app-server failures through the existing system-warning path, bound to the affected conversation where one is known.

## Testing

### Dispatcher tests

- An idle message acquires ownership and produces one `turn/start`.
- Owner-conversation follow-ups produce ordered `turn/steer` calls with the exact active `expectedTurnId`.
- Pending messages already belonging to a newly selected owner are drained in order by native steering.
- A different app or a different conversation in the same app cannot steer the active turn.
- A chat message cannot steer a backend-generated internal turn and is acknowledged as queued.
- Every non-owner source message creates exactly one `[system] queued` delivery after persistence.
- The next owner is the conversation whose oldest pending message arrived first.
- Duplicate native source IDs neither reach Codex twice nor create duplicate acknowledgements.

### Codex-boundary tests

- A follow-up received while a tool item is active is passed immediately to `turn/steer`; the backend does not wait for the tool notification to finish.
- Text and attachments remain one ordered steering input.
- A stale `expectedTurnId` leaves the message pending and starts it in the next turn after reconciliation.
- An ambiguous steering response is reconciled by `clientUserMessageId` and is not blindly retried.
- Review and compact turns preserve follow-ups until a new steerable turn can start.

### Routing and recovery tests

- Final responses and explicit chat/attachment tools deliver to the immutable owner conversation without an app argument.
- Late output from a completed turn cannot be routed to the next owner.
- Restart with a matching active turn preserves ownership and resumes owner-message steering.
- Restart with stale ownership releases it only after app-server reconciliation.
- Failed queued acknowledgements and ordinary outputs retry without rerunning QiYan.
- Telegram remains behaviorally compatible when it is the only configured adapter, except that same-chat follow-ups now steer the active turn.

## Documentation impact

Shared architecture documentation will explain that QiYan supports one active conversation at a time, same-conversation follow-ups steer the active Codex turn, and other conversations receive `[system] queued`. Adapter guides will define which native destinations constitute distinct conversations. QiYan's `AGENTS.md` needs no source-routing instructions because routing remains entirely backend-owned.

## Acceptance criteria

The design is complete when implementation can demonstrate all of the following:

1. A second message from the active conversation reaches native `turn/steer` while QiYan is still working.
2. No backend code selects a tool boundary or inserts platform metadata into QiYan's input.
3. A message from any other conversation is durable, receives `[system] queued`, and cannot affect the active turn.
4. All assistant output reaches the owner conversation without QiYan choosing an app or destination.
5. Completion races, ambiguous app-server responses, delivery failures, duplicates, and restarts preserve each accepted message without blind duplicate submission.
