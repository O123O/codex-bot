# Codex Chat Bot Design

## Summary

Build a single-user, self-hosted assistant that lets its owner operate Codex from chat applications. The assistant is itself a persistent Codex thread called the coordinator. It answers general questions, manages projects, chooses project sessions, and uses structured backend tools to control ordinary Codex threads.

The MVP uses Telegram, TypeScript, and one local `codex app-server`. It is designed so Slack and WeChat adapters, remote app-servers reached through SSH, and multiple app-server processes per host can be added without changing coordinator behavior.

## Goals

- Provide a general-purpose personal assistant with the capabilities available to a normal Codex session.
- Let the coordinator discover, create, adopt, resume, steer, interrupt, and inspect ordinary Codex sessions in any local project directory.
- Keep project work in normal Codex threads that the owner can also resume manually with standard Codex clients.
- Let the coordinator manage sessions using memorable nicknames rather than thread IDs.
- Deliver project-session responses automatically to Telegram without routing their full content through the coordinator model.
- Give the coordinator metadata about every project-session result and let it inspect full messages only when needed.
- Support exact pass-through and direct collection semantics through `/pass` and `/collect` markers on the normal send and collect tools.
- Exchange text and file attachments in both directions.
- Recover from backend and app-server restarts without losing or duplicating acknowledged results.
- Keep platform, transport, and app-server boundaries general enough for later Telegram alternatives and SSH hosts.

## Non-goals for the MVP

- Multiple bot users or tenant isolation.
- SSH-hosted projects.
- Slack or WeChat adapters.
- Interactive approval buttons or approval conversations in Telegram.
- Voice or video handling.
- A generic raw JSON-RPC tool exposed to the coordinator.
- Multiple app-server processes on one local host unless verification reveals a practical concurrency limit.

## Terminology

- **App-server:** A Codex JSON-RPC server process that can host and operate multiple threads.
- **Thread/session:** A persistent Codex conversation containing turns and items. This document uses "session" in user-facing language and "thread" when referring to the app-server protocol.
- **Coordinator:** A persistent Codex thread rooted in the bot repository and instructed to act as the user's assistant and session manager.
- **Project session:** An ordinary Codex thread whose working directory is a project directory. It has no bot-specific worker behavior and may use normal Codex tools and subagents.
- **Endpoint:** A connection strategy for one app-server. The MVP has a local endpoint; a later release adds SSH endpoints.
- **Managed session:** A discovered or created Codex thread that has a coordinator-assigned nickname in the bot registry.

App-server threads are distinct from subagent threads. Limits such as `agents.max_threads` govern subagents spawned inside a Codex session, not the number of persistent top-level sessions stored by one app-server. The backend will nevertheless cap concurrent active turns and retain the ability to shard a host across multiple app-server processes.

## Architecture

```text
Telegram API
    |
    v
ChatAdapter
    | canonical messages and attachments
    v
TypeScript Bot Backend
    |-- CoordinatorRuntime
    |-- CoordinatorToolGateway
    |-- SessionRegistry
    |-- AppServerPool
    |-- EventRelay
    |-- AttachmentStore
    `-- OperationalStore
             |
             v
    AppServerEndpoint: local
      `-- one local Codex app-server
            |-- coordinator thread
            |-- payments thread
            `-- website thread

Future:
    AppServerEndpoint: ssh://devbox
      `-- one remote Codex app-server
            `-- remote project threads
```

### Component responsibilities

#### ChatAdapter

Converts platform-specific inbound messages and attachments into canonical events and converts canonical outbound deliveries into platform API calls. The Telegram adapter uses long polling. Later Slack and WeChat adapters implement the same interface without importing coordinator or app-server logic.

#### CoordinatorRuntime

Owns the persistent coordinator thread, serializes its turns, sends user messages and internal metadata events to it, and distinguishes user-triggered turns from internal notification turns.

#### CoordinatorToolGateway

Exposes curated, typed backend operations to the coordinator through a coordinator-scoped MCP server. It binds each tool invocation to its originating Telegram message so directive enforcement cannot be detached from the source text.

#### SessionRegistry

Stores human-editable nickname mappings. The coordinator selects nicknames, project directories, and sessions; the backend validates and atomically persists those choices.

#### AppServerPool

Owns app-server processes and connections. An endpoint identifies the host and transport; it does not identify a Codex thread. The MVP creates one local stdio or local-socket app-server connection. A future `SshEndpoint` starts or tunnels a remote app-server over SSH. The pool interface also permits multiple processes for a host if load testing or a later Codex version requires sharding.

#### EventRelay

Consumes app-server notifications, updates runtime state, forwards final project-session messages to Telegram, and queues compact metadata events for the coordinator.

#### AttachmentStore

Downloads, checksums, stores, materializes, uploads, expires, and cleans up attachments without placing their bytes into model context.

#### OperationalStore

Uses SQLite for queues, delivery state, event deduplication, Telegram update offsets, attachment metadata, session runtime state, and crash recovery.

## Coordinator configuration and behavior

The coordinator is started in a dedicated directory inside the repository:

```text
codex-bot/
  AGENTS.md
  coordinator/
    AGENTS.override.md
```

The repository-level file contains development guidance. The nested override contains the runtime manager role and applies after the root instructions. Coordinator-only MCP configuration is scoped to this directory so unrelated project sessions do not receive bot management tools.

The coordinator instructions require it to:

- Act as the user's general assistant and project/session manager.
- Answer directly when a request does not need a project session.
- Select sessions using nicknames, project metadata, current status, and conversational context.
- Ask the user when a routing choice remains ambiguous.
- Discover and adopt existing Codex sessions when appropriate.
- Assign short, memorable, unique nicknames.
- Avoid reading project transcripts and files unless the user's request requires them.
- Know that project-session final messages are automatically delivered to Telegram.
- Avoid repeating or paraphrasing an automatically delivered result unless asked.
- Treat project-session notifications as metadata and read their referenced messages only when useful.
- Retain supervision requests in its persistent conversation and decide what to do after each notification. There is no separate `watch_session` backend state.
- Use the ordinary send and collect tools for `/pass` and `/collect`, respecting backend enforcement.
- Use structured status, model, effort, goal, and lifecycle tools rather than simulating CLI slash commands inside prompts.
- Know that setting a goal replaces the current goal and that goal completion is determined by the target Codex session/app-server, not by the coordinator.
- Warn the user when a session is blocked, detached, unavailable, or inconsistent with its registered directory.

The instructions guide model judgment. Tool validation, authorization, exact pass-through, delivery targeting, and registry integrity remain deterministic backend responsibilities.

## Session registry

The durable JSON registry contains identity and mapping data only:

```json
{
  "version": 1,
  "coordinator": {
    "endpoint": "local",
    "thread_id": "thr_coordinator",
    "project_dir": "/home/user/codex-bot/coordinator"
  },
  "sessions": {
    "payments": {
      "endpoint": "local",
      "thread_id": "thr_payments",
      "project_dir": "/home/user/projects/payments",
      "description": "Payments service",
      "mode": "managed"
    }
  }
}
```

Transient fields such as running state, active turn, last activity, delivery cursor, model overrides, and errors live in SQLite rather than JSON.

### Registry rules

- Nicknames are unique, human-facing identifiers. Internal thread IDs remain available for diagnostics and discovery.
- The backend canonicalizes project paths and verifies a thread's recorded `cwd` through app-server before registering, adopting, attaching, or messaging it.
- A nickname is never silently repointed to a different thread or directory.
- Backend writes use a temporary file and atomic rename.
- Human edits are supported. The complete replacement file must pass schema and mapping validation before activation.
- An invalid edit leaves the last known-good registry active and produces a warning; it does not delete or repair existing mappings.
- Startup validates all mappings. Invalid entries are quarantined from control and reported.

## Session discovery and lifecycle

`thread/list` is called without a working-directory filter to discover all normal Codex sessions visible to the app-server's OS user and `CODEX_HOME`, not merely sessions already controlled by the bot. Results are paginated and include thread ID, title or preview, working directory, source, timestamps, and runtime status. Subagent threads are excluded by default using their parent-thread metadata.

The coordinator may:

- Create a new session in a selected project directory.
- Register a known thread ID after directory verification.
- Discover and adopt a CLI-, IDE-, app-, or app-server-created thread under a new nickname.
- Rename the nickname without changing the Codex thread.
- Detach a session before the user resumes it manually in another Codex client.
- Reattach it after rereading and validating its current metadata.
- Archive a session while retaining registry history.

Concurrent control of the same thread from the bot and another client is unsafe. The supported manual workflow is:

```text
detach payments -> work manually -> attach payments
```

If conflicting active control is detected, the backend fails the new operation instead of guessing.

## Coordinator tool surface

The exact TypeScript/MCP schemas will use structured objects and errors, but the conceptual operations are:

### Discovery and lifecycle

```text
list_managed_sessions()
discover_sessions(endpoint?, search?, cwd?, cursor?, limit?)
get_session_status(nickname_or_thread_id)
create_session(nickname, project_dir, endpoint?)
register_session(nickname, thread_id, project_dir, endpoint?)
adopt_session(nickname, thread_id, endpoint?)
rename_session(old_nickname, new_nickname)
detach_session(nickname)
attach_session(nickname)
archive_session(nickname)
```

### Project-session interaction

```text
send_to_session(nickname, content, attachment_ids?, mode)
read_worker_message(nickname, message_id)
collect_messages(nickname, count)
interrupt_session(nickname)
```

`mode` is explicitly `start` or `steer`. `start` requires an idle session and begins a turn. `steer` requires an active turn and appends input to it. State mismatches return structured errors; the backend does not choose a mode for the coordinator.

### Model, effort, status, and goals

```text
list_models(endpoint?)
set_session_model(nickname, model)
set_reasoning_effort(nickname, effort)
get_goal(nickname)
set_goal(nickname, objective, token_budget?)
pause_goal(nickname)
resume_goal(nickname)
cancel_goal(nickname, interrupt_active_turn?)
```

Model and effort changes are validated against endpoint capabilities and applied on the next turn, after which app-server keeps them for subsequent turns. `get_session_status` combines native app-server status with endpoint, directory, active-turn, configured model/effort, goal, delivery, and managed/detached state.

`set_goal` replaces any current goal and activates the new one. Pause and resume alter the native goal status. Cancel clears the goal and may also interrupt the current turn when explicitly requested. No `complete_goal` tool is exposed: completion, blockage, and budget/usage-limit transitions come from the project session and app-server.

Goal methods and other version-sensitive operations are exposed only when the connected app-server advertises or successfully validates the required capability. The backend uses generated app-server types matching the installed Codex version.

### Chat output

```text
send_chat_message(content, reply_to?)
send_chat_attachment(file_reference, caption?, reply_to?)
```

There is no arbitrary recipient argument in the MVP. All outbound operations target the configured Telegram destination for the single authorized user.

The backend contains a typed app-server client broader than this list, but raw JSON-RPC is not exposed to the coordinator. Common safe operations can be added as curated tools later.

## Message routing

### Normal user message

1. Telegram long polling receives an update.
2. The adapter checks the sender's Telegram user ID. Updates from every other sender are silently discarded before persistence or model invocation.
3. The accepted update is deduplicated, normalized, and queued.
4. The backend starts a coordinator turn with the canonical message and attachment metadata.
5. The coordinator answers directly or calls tools to operate a project session.
6. A final coordinator answer from this user-triggered turn is automatically delivered to Telegram.

Coordinator turns are serialized. Each Telegram message receives its own turn and source-message context. Messages received while the coordinator is busy remain in FIFO order instead of being steered into the active coordinator turn. This makes directive binding deterministic.

### `/pass` enforcement

`/pass` is not a separate tool. It places an invariant on the ordinary `send_to_session` tool invoked during the same coordinator turn.

The directive syntax is an exact standalone `/pass` token followed by one required ASCII space. Text before the token is routing context for the coordinator. The payload is every character after that one delimiter space; any additional leading spaces are part of the payload. The first valid `/pass` token is authoritative.

If a standalone `/pass` token is present but does not satisfy this syntax, the backend marks the source directive as malformed and rejects a related send with `DIRECTIVE_MISMATCH`; it does not silently treat the message as an unconstrained send.

Example:

```text
tell payments /pass rerun the tests, but change nothing
```

When the coordinator calls `send_to_session`, the tool gateway verifies that:

- `content` is exactly the extracted payload as received from Telegram.
- Attachment IDs exactly match the source message attachments and preserve their order.
- The tool call belongs to the same source-message context.

The coordinator may choose the nickname and `start`/`steer` mode. It may not alter, normalize, translate, or reconstruct the content. A mismatch rejects the call and reports the expected payload. A successful receipt includes the resolved nickname, thread ID, actual transmitted text, attachment IDs, and payload hash.

### `/collect` enforcement

`/collect` is not a separate command sent to Codex. It constrains the ordinary `collect_messages` tool in the same source-message context.

The syntax is an exact standalone `/collect` token optionally followed by one ASCII space and a positive decimal count; the default count is one. Only trailing whitespace may follow the count. Text before the token is routing context.

If a standalone `/collect` token has malformed count or trailing content, the backend rejects a related collection with `DIRECTIVE_MISMATCH` rather than weakening it into a normal collection.

Example:

```text
report payments /collect 3
```

The backend verifies the coordinator's requested count, retrieves the latest completed agent messages excluding tool and progress items, and delivers them directly to Telegram with the session nickname. The coordinator receives a delivery receipt rather than the collected bodies unless it separately calls `read_worker_message` outside the direct-collection result.

Without `/pass`, `send_to_session` accepts coordinator-composed content normally. Without `/collect`, `collect_messages` returns the selected message bodies to the coordinator as its tool result and does not deliver them directly to Telegram. The coordinator may then inspect, summarize, or forward them according to the user's request.

## Project-session events and automatic delivery

For every completed project-session turn:

```text
Project-session final response
  |-- full response -> Telegram, prefixed with [nickname]
  `-- compact event -> coordinator event queue
```

The coordinator event includes nickname, endpoint, thread ID, turn ID, final-message ID, timestamps, completion status, and delivery status. It does not include the response body.

When the coordinator is idle, the backend starts an internal event turn. If it is busy, metadata notifications wait and may be batched without losing per-session order. Final text produced by an internal event turn is suppressed by default, preventing acknowledgements such as "noted" from reaching Telegram. The coordinator calls a chat-output tool when it decides the user should receive an additional message.

All project-session result metadata is sent to the coordinator; there is no `watch_session` tool. If the user asks the coordinator to supervise work until completion, the persistent coordinator thread remembers that instruction, reads result messages when needed, sends further project instructions, and decides when supervision is finished.

Tool calls, command output, deltas, and progress events are not automatically forwarded as final responses. Permission blocks, system failures, and delivery failures produce deterministic warnings and coordinator metadata events.

## Attachments

Inbound messages contain text plus zero or more canonical attachment references:

```json
{
  "id": "att_123",
  "name": "error.log",
  "media_type": "text/plain",
  "size": 18421,
  "sha256": "...",
  "source": "telegram"
}
```

The attachment store uses randomized internal names and preserves the display name as metadata. It applies configurable size and retention limits, calculates a checksum, and records ownership by source message.

When sending an attachment to a local project session, the endpoint materializes a session-accessible path and includes the reference in app-server input. `/pass` requires the original attachment IDs and order. Attachment bytes are never embedded in coordinator context.

For outbound files, the backend resolves the reference, verifies that it is a regular readable file, checks platform limits, and asks the Telegram adapter to upload it. A future SSH endpoint implements the same contract by fetching the remote file before handing it to the chat adapter.

## Persistence and recovery

SQLite stores at least these logical records:

- Accepted inbound Telegram updates and coordinator-turn state.
- App-server event identities and processing state.
- Pending and acknowledged Telegram deliveries.
- Pending and completed coordinator metadata notifications.
- Per-thread runtime state and delivery cursors.
- Model/effort overrides awaiting their next turn.
- Attachment metadata and expiry state.

The exact schema is an implementation detail, but all externally visible effects use durable inbox/outbox semantics:

- Record accepted input before processing.
- Give every event and delivery a stable idempotency key.
- Mark Telegram output complete only after platform acknowledgement.
- Retry incomplete work after restart without repeating acknowledged output.

App-server events are deduplicated by endpoint, thread, turn, item, and event type. Telegram updates use Telegram's stable update/message identities.

If an app-server disconnects, the endpoint becomes unavailable, new operations fail or remain queued according to their tool contract, and the pool restarts the process with bounded exponential backoff. After reconnecting, the backend rereads registered threads and reconciles completed turns against stored delivery cursors. This recovers final messages whose live notifications were missed.

Thread identity is independent of a particular app-server process. Persisted threads are resumed by ID after a process restart.

## Concurrency and capacity

- The coordinator processes one source message or internal notification turn at a time.
- Different project sessions may run concurrently.
- Events remain ordered within one project session; cross-session events may interleave and are labeled.
- A configurable `maxConcurrentTurns` protects local CPU, memory, and API limits. Excess starts are queued or rejected according to the operation's documented behavior.
- The MVP uses one app-server process because app-server supports multiple top-level threads. The pool can add another process for a host without changing registry or coordinator APIs.
- The system warns against multiple concurrent sessions modifying the same project files. The MVP does not create worktrees automatically.

## Security and execution policy

### Telegram authorization

Exactly one Telegram user ID is configured. Updates from all other user IDs are silently ignored before they enter durable queues, attachment storage, logs, or Codex. Outbound tools have no recipient parameter and use the configured destination chat.

Long polling avoids exposing a public webhook listener. The Telegram bot token and Codex credentials are supplied through environment variables or a local secret store and never committed.

### Codex permissions

Sessions run with a configured non-interactive approval policy. The operator explicitly configures the sandbox level, including whether to grant full machine access. This is a high-trust personal deployment: granting unrestricted Codex access makes the Telegram account a remote-control boundary for the machine.

If app-server still reports an approval or permission requirement, the deterministic backend does not approve it conversationally. It marks the session blocked, sends a nickname-labeled warning to Telegram, notifies the coordinator with metadata, and rejects or leaves the action blocked as required by the protocol.

### Data handling

- Logs redact tokens and do not include full message bodies or attachment contents by default.
- Registry paths are canonicalized, and thread working directories are verified before state-changing operations.
- Attachment paths reject traversal and symlink surprises at the point of materialization or upload.
- Outbound chat operations cannot select another recipient.
- Malformed configuration or registry input never replaces known-good active state.

## Error handling

Backend tools return typed errors with stable categories, including:

- `UNKNOWN_SESSION`
- `AMBIGUOUS_SESSION`
- `SESSION_DETACHED`
- `SESSION_BUSY`
- `SESSION_IDLE`
- `THREAD_NOT_FOUND`
- `CWD_MISMATCH`
- `ENDPOINT_UNAVAILABLE`
- `UNSUPPORTED_CAPABILITY`
- `DIRECTIVE_MISMATCH`
- `ATTACHMENT_INVALID`
- `DELIVERY_FAILED`
- `PERMISSION_BLOCKED`

Errors include safe recovery hints and correlation IDs but do not leak secrets. The coordinator decides how to explain recoverable errors to the user. Automatic delivery failures remain in the outbox and are also surfaced as metadata notifications.

## Extensibility

### SSH endpoints

Stage two adds `SshEndpoint`, which starts or communicates with `codex app-server` on a configured SSH host. The project directory is interpreted and validated on that host. The registry's existing `endpoint` field selects the correct connection, and attachment materialization gains upload/download behavior. Coordinator tools and chat adapters remain unchanged.

Direct public WebSocket exposure is not required. SSH stdio, Unix-socket forwarding, or loopback tunneling is preferred.

### Additional chat applications

Slack and WeChat adapters translate their native update, message, formatting, file, and delivery concepts into the canonical chat contracts. They do not import app-server types. Platform-specific message size and formatting rules are handled at the adapter boundary.

The single-user authorization policy remains part of deployment configuration. A future multi-user product would require a separate identity, authorization, isolation, and registry design rather than merely adding more user IDs.

## Verification strategy

### Unit tests

- Directive parsing, including exact Unicode preservation, whitespace boundaries, attachment order, and mismatch rejection.
- Canonical chat conversion and Telegram message splitting.
- Registry schema validation, atomic replacement, nickname collisions, and canonical-path checks.
- Coordinator source-message binding.
- Event ordering, idempotency keys, inbox/outbox transitions, and retry decisions.
- Attachment checksum, expiry, path validation, and output targeting.
- Goal replacement, pause/resume/cancel mapping, and the absence of coordinator-controlled completion.
- Unauthorized Telegram updates being discarded before persistence and model invocation.

### App-server contract and integration tests

- Generate or consume TypeScript/JSON schemas matching the installed app-server version.
- Start and operate several top-level threads through one local app-server.
- Verify discovery across directories and adoption of a session created outside the bot.
- Verify thread resume, working-directory validation, detach/attach, and status transitions.
- Verify model and effort overrides on subsequent turns.
- Verify supported native goal operations and capability-gated behavior.
- Verify final-message extraction excludes tool and progress items.
- Verify interruption and structured busy/idle failures.

### Recovery and concurrency tests

- Kill the backend before and after Telegram acknowledgement and confirm exactly-once visible delivery.
- Kill app-server after turn completion but before event processing and confirm reconciliation recovers the result.
- Run several project sessions concurrently while coordinator inputs remain serialized.
- Exercise a configurable concurrent-turn limit and endpoint restart backoff.
- Confirm no two aliases can race into inconsistent registry mappings.

### Telegram tests

- Mock Telegram API behavior for polling, downloads, uploads, retries, rate limiting, and message-size splitting.
- Prove updates from unauthorized users cause no storage, Codex work, or reply.
- Provide an optional live private-chat smoke test for the configured owner.

## MVP success criteria

The MVP is successful when one configured Telegram user can:

1. Converse with a persistent coordinator as a general assistant.
2. Discover Codex sessions from across the local machine's active Codex profile.
3. Create or adopt project sessions and manage them by nickname.
4. Start and steer work, interrupt turns, inspect status, and change supported model/effort settings.
5. Set or replace, pause, resume, inspect, and cancel native goals without the coordinator declaring completion.
6. Receive every completed project-session response automatically with its nickname.
7. Give the coordinator metadata-only visibility and allow selective message inspection.
8. Use backend-enforced `/pass` and `/collect` semantics through the normal tools.
9. Send and receive file attachments.
10. Restart the backend or app-server without losing registered sessions or duplicating acknowledged final responses.

## Delivery stages

1. **MVP:** TypeScript modular monolith, Telegram, local app-server pool endpoint, coordinator, discovery/registry/tools, attachments, directives, automatic delivery, and recovery.
2. **Remote projects:** SSH endpoint, remote validation, and remote attachment transfer.
3. **Additional chat apps:** Slack and WeChat adapters.
4. **Optional scale work:** Multiple app-server processes per host based on measured capacity, not speculation.
