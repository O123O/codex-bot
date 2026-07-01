# Automatic Session Dashboard Design

## Goal

Replace the coordinator-edited version-1 `session-status.json` notebook with a version-2 backend-managed session dashboard. Objective session facts update automatically from tool receipts and app-server events. The coordinator owns only concise judgment-based notes through a typed tool, never by editing JSON. The existing `get_session_status` tool becomes the canonical Codex-style status query and includes model, effort, context/token usage, goal, and lifecycle state.

The backend remains deterministic. It projects observed facts and tool results; it does not decide project intent, routing, supervision, or completion.

## Ownership and persistence

`<coordinator-workdir>/session-status.json` is a generated read-only view for the coordinator. The backend is its sole writer. The coordinator may read it at startup and after compaction, but `AGENTS.md` explicitly forbids editing, patching, replacing, deleting, or regenerating it.

The backend registry `data/sessions.json` is also never edited by the coordinator. Nickname, thread, endpoint, directory, and lifecycle changes go through manager tools.

SQLite is authoritative for manager notes and observed automatic facts. The JSON dashboard is a materialized view keyed by current nickname and rebuilt from stable `(endpoint, thread_id)` records plus the registry. This keeps nickname changes from losing history and prevents a failed JSON write from making tool effects uncertain.

Dashboard updates use a serialized renderer, a mode-0400 temporary sibling, and atomic rename. A render failure marks the projection dirty, schedules retry, and produces a structural warning; it never rolls back or retransmits an already-confirmed app-server action. On startup the backend reconciles persisted state and rewrites the complete view before starting the coordinator.

The existing version-1 notebook is migrated once. Entries are matched by `thread_id`; `project_status` becomes `manager_notes.project_summary`, `current_objective` becomes `manager_notes.supervision_objective`, and `pending_follow_up` is retained. Old manually recorded `last_sent` and `last_worker_event` values are not promoted to observed automatic facts. SQLite records completion of the migration before the generated version-2 view replaces the old file, making restart idempotent. Invalid version-1 input still stops startup without data loss.

## Version-2 document

```json
{
  "version": 2,
  "sessions": {
    "payments": {
      "identity": {
        "thread_id": "thr_example",
        "endpoint": "local",
        "project_dir": "/projects/payments"
      },
      "auto_session_info": {
        "management_state": "managed",
        "native_status": "idle",
        "active_turn_id": null,
        "last_sent": {
          "text": "Run the failing idempotency tests.",
          "mode": "start",
          "attachment_ids": [],
          "turn_id": "turn_example",
          "at": "2026-07-01T12:00:00Z"
        },
        "last_worker_event": {
          "message_id": "msg_example",
          "turn_id": "turn_example",
          "status": "completed",
          "at": "2026-07-01T12:10:00Z"
        },
        "model": {
          "current": "gpt-5.4",
          "pending": null
        },
        "reasoning_effort": {
          "current": "high",
          "pending": null
        },
        "token_usage": {
          "total": {
            "total_tokens": 55450,
            "input_tokens": 48210,
            "cached_input_tokens": 18100,
            "output_tokens": 7240,
            "reasoning_output_tokens": 3110
          },
          "last_turn": {
            "total_tokens": 4880,
            "input_tokens": 4200,
            "cached_input_tokens": 1200,
            "output_tokens": 680,
            "reasoning_output_tokens": 250
          },
          "model_context_window": 200000,
          "context_remaining": 144550,
          "context_used_percent": 27.725,
          "observed_at": "2026-07-01T12:10:00Z"
        },
        "goal": {
          "objective": "Make idempotency tests pass",
          "status": "active",
          "token_budget": null
        },
        "observed_at": "2026-07-01T12:10:00Z"
      },
      "manager_notes": {
        "project_summary": "Payments service",
        "supervision_objective": "Finish the webhook fix and verify migration compatibility",
        "pending_follow_up": "Check migration compatibility after tests pass",
        "updated_at": "2026-07-01T12:10:00Z"
      }
    }
  }
}
```

Nullable or not-yet-observed automatic values are represented as `null`; the backend never estimates them. `observed_at` is the newest source observation included in the automatic view. The full last instruction is retained because it is needed to recover supervision context after compaction; only the most recent instruction is stored. Attachment bytes and worker message bodies are never copied into the dashboard.

## Automatic update sources

The backend updates persisted automatic facts after proof of effect:

- `create_session`, `register_session`, and `adopt_session` establish identity and lifecycle state.
- `rename_session` changes only the rendered key; stable thread history and notes remain attached.
- `attach_session`, `detach_session`, and `archive_session` update `management_state` after their lifecycle receipts.
- A successful `send_to_session` records text, actual `start` or `steer` mode, attachment IDs, resolved turn ID, and timestamp. Proven-no-effect failures do not change `last_sent`; uncertain effects remain governed by the operation ledger and are projected only after reconciliation proves the send.
- `turn/started`, `thread/status/changed`, and terminal turn handling update active turn and native status.
- Eligible terminal worker handling updates `last_worker_event` from the stored logical final-message ID and terminal status, without copying the body.
- `thread/settings/updated`, thread start/resume responses, and confirmed model/effort tool operations update current and pending settings. Pending settings remain distinct until consumed by a new turn.
- `thread/tokenUsage/updated` stores the exact `total`, `last`, and `modelContextWindow` values. The backend derives nonnegative `context_remaining` and bounded `context_used_percent`; no notification means `token_usage: null`.
- `thread/goal/updated`, `thread/goal/cleared`, and confirmed goal tools update the native goal projection. Goal completion remains an app-server/worker fact, never a coordinator declaration.
- `get_session_status` refreshes thread state and goal, merges durable token/settings observations, rewrites the dashboard if facts changed, and returns the same structured status.

Events and receipts are deduplicated by existing stable operation, thread, turn, item, and notification identities. Replaying an event cannot move a newer observation backward.

## `get_session_status`

The existing tool name remains `get_session_status`; no alias or duplicate `get_status` tool is added. It requires a resolved nickname. The coordinator chooses the contextually active nickname or asks when a bare user `/status` request is ambiguous.

The result contains:

- nickname, endpoint, thread ID, and canonical project directory;
- management state, native status, and active turn ID;
- current and pending model;
- current and pending reasoning effort;
- exact observed total and last-turn token breakdown;
- model context window, remaining context, used percentage, and observation time;
- current native goal and status; and
- the manager notes for management context.

Thread token usage is context usage corresponding to Codex thread status. It is not account billing, global usage, credits, or rate-limit information.

## `update_session_notes`

The coordinator updates judgment-based state through one new side-effecting tool:

```json
{
  "nickname": "payments",
  "project_summary": "Payments service",
  "supervision_objective": "Finish the webhook fix",
  "pending_follow_up": "Check migration compatibility"
}
```

The three note fields are optional nullable strings with bounded lengths. At least one must be present. Omitted fields are unchanged; `null` clears a field. The backend resolves the nickname to stable thread identity, records `updated_at`, updates SQLite through the existing operation ledger, and renders the dashboard. The receipt returns the complete resulting `manager_notes` object. Renaming a session does not require rewriting notes manually.

The tool does not add a `watch_session` concept. Supervision intent remains coordinator judgment stored as notes; automatic worker events merely wake the coordinator as before.

## Coordinator playbook examples

The managed `AGENTS.md` gains concise worked examples pairing user language, routing decisions, exact tool arguments, and automatic outcomes.

### Create and name a new project session

```text
User: Work on /projects/payments and fix the duplicate webhook bug.

Coordinator:
1. Choose the short unique nickname "payments" and tell the user.
2. create_session({"nickname":"payments","project_dir":"/projects/payments"})
3. send_to_session({"nickname":"payments","content":"Fix the duplicate webhook bug.","attachment_ids":[],"mode":"start"})
```

The example explains that identity and `last_sent` appear automatically. The coordinator does not edit JSON.

### Adopt existing work

```text
User: Continue my existing Codex work in /projects/payments.

Coordinator:
1. discover_sessions({"cwd":"/projects/payments"})
2. If exactly one intended top-level session is clear, adopt_session with nickname "payments".
3. Ask the user if multiple candidates remain plausible.
```

### Read status

```text
User: What is the status of payments?

Coordinator:
get_session_status({"nickname":"payments"})
```

The example calls out model, effort, token/context usage, active turn, and goal fields, and instructs the coordinator not to invent missing values.

### Record supervision intent

```text
User: Monitor payments until the tests pass, then check migration compatibility.

Coordinator:
update_session_notes({
  "nickname":"payments",
  "supervision_objective":"Get the test suite passing",
  "pending_follow_up":"Check migration compatibility after tests pass"
})
```

### Exact pass-through

```text
User: tell payments /pass  preserve this leading space

Coordinator sends content exactly equal to:
" preserve this leading space"
```

The example also states that attachment IDs and ordering are unchanged, while the coordinator still chooses `start` or `steer` from live status.

### Direct collection

```text
User: report payments /collect 3

Coordinator:
collect_messages({"nickname":"payments","count":3})
```

The backend delivers the selected finals directly; the coordinator does not repeat or summarize them.

## Failure behavior

- An invalid manager-note update has proven no effect and does not change the dashboard.
- A dashboard render failure never converts a confirmed app-server mutation into an uncertain external effect. The dirty projection is retried and a warning is queued.
- Invalid persisted automatic state or notes stop unsafe activation; last-known-good SQLite data remains intact.
- Unknown or out-of-order token/settings/goal notifications cannot overwrite observations for a newer turn or timestamp.
- Manual coordinator edits to `session-status.json` are unsupported and may be overwritten by the next render. `AGENTS.md` tells the coordinator to use tools only.

## Tests

Tests cover:

- migration of every version-1 manager field without importing unverified automatic facts;
- backend-only mode-0400 atomic rendering and startup rebuild;
- stable notes across rename and restart;
- automatic updates from lifecycle tools, successful send receipts, terminal worker events, model/effort tools, goals, status changes, and token-usage notifications;
- no automatic update after proven-no-effect operations and correct behavior after uncertain-operation reconciliation;
- ordering guards that prevent stale notifications from replacing newer observations;
- `get_session_status` with full data and with all unobserved values as `null`;
- token context calculations and bounds;
- partial update and null-clearing semantics for `update_session_notes`;
- render-failure retry without replaying external actions;
- policy examples for nickname creation/adoption, status, notes, `/pass`, and `/collect`;
- explicit read-only instructions for both the dashboard and backend registry; and
- preservation of existing delivery, compaction, operation-ledger, and recovery behavior.
