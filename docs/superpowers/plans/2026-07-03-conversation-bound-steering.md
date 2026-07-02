# Conversation-Bound Assistant Steering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one QiYan conversation steer its active Codex turn natively while other conversations queue durably with automatic adapter-bound delivery.

**Architecture:** Introduce adapter-neutral conversation bindings and outbox records, then replace the assistant user-job FIFO with a durable single-thread actor backed by a lease and ordered attempt-source memberships. The actor serializes `turn/start` and `turn/steer`, delegates insertion timing to Codex, and drives the existing runtime, MCP tools, attachments, events, and recovery through immutable attempt bindings.

**Tech Stack:** TypeScript 6, Node.js 24, `node:sqlite`, Codex app-server JSON-RPC v2, MCP SDK, Node test runner, Telegram Bot API.

---

## File structure

New focused units:

- `src/chat/binding.ts`: JSON-safe adapter/conversation binding and receipt types.
- `src/chat/adapter-registry.ts`: routes generic delivery records to one configured adapter.
- `src/chat/delivery-worker.ts`: adapter-neutral durable outbox worker, replacing the Telegram-named worker.
- `src/storage/conversation-cutover.ts`: idempotent config-aware legacy Telegram backfill.
- `src/storage/conversation-store.ts`: canonical ingress, arrival ordering, lease, membership, notice, and arbitration queries.
- `src/assistant/conversation-dispatcher.ts`: serialized start/steer/terminal actor with no Codex item-boundary logic.
- `src/assistant/attempt-scope.ts`: attempt-member attachment lookup and FIFO `/pass`/`/collect` safeguard resolution.

Existing units retain one responsibility:

- `src/assistant/runtime.ts`: attempt hydration, MCP fencing, terminal source transitions, and recovery grouping.
- `src/assistant/scheduler.ts`: internal event batching/fairness only; chat input moves to the dispatcher.
- `src/app-server/pool.ts`: explicit provisional/active capacity claims and authoritative turn lookup.
- `src/production-app.ts`: composition and lifecycle wiring, not state-machine logic.
- `src/telegram/poller.ts` and `src/telegram/chat-adapter.ts`: Telegram normalization and transport only.

## Task 1: Add adapter-neutral bindings and append-only schema

**Files:**
- Create: `src/chat/binding.ts`
- Modify: `src/core/types.ts`
- Modify: `src/storage/migrations.ts`
- Test: `tests/storage/conversation-schema.test.ts`

- [ ] **Step 1: Write the failing schema and type test**

Create `tests/storage/conversation-schema.test.ts` with a fresh-database assertion and constraint checks:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "../../src/storage/database.ts";

test("conversation steering schema has one lease and ordered attempt members", () => {
  const db = createTestDatabase();
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[]).map((row) => row.name));
  assert.ok(tables.has("assistant_turn_lease"));
  assert.ok(tables.has("assistant_attempt_sources"));
  assert.ok(tables.has("arrival_sequence"));
  const columns = new Set((db.prepare("PRAGMA table_info(source_contexts)").all() as any[]).map((row) => row.name));
  for (const name of ["adapter_id", "conversation_key", "destination_json", "native_reply_json", "arrival_sequence", "queue_notice_required"]) assert.ok(columns.has(name), name);
});

test("only one assistant lease row is allowed", () => {
  const db = createTestDatabase();
  db.prepare("INSERT INTO source_contexts(id, kind, source_id, raw_text, attachment_ids_json, state, created_at, source_class) VALUES ('c', 'recovery', 'c', '', '[]', 'active', 1, 'internal'), ('d', 'recovery', 'd', '', '[]', 'active', 2, 'internal')").run();
  db.prepare("INSERT INTO assistant_attempts(id, context_id, turn_id, trigger_kind, state, created_at) VALUES ('a', 'c', 'pending:a', 'internal', 'active', 1), ('b', 'd', 'pending:b', 'internal', 'active', 2)").run();
  db.prepare("INSERT INTO assistant_turn_lease(singleton, phase, attempt_id, primary_context_id, client_user_message_id, trigger_kind, capacity_claim_id) VALUES (1, 'starting', 'a', 'c', 'm', 'internal', 'claim-a')").run();
  assert.throws(() => db.prepare("INSERT INTO assistant_turn_lease(singleton, phase, attempt_id, primary_context_id, client_user_message_id, trigger_kind, capacity_claim_id) VALUES (2, 'starting', 'b', 'd', 'n', 'internal', 'claim-b')").run());
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/storage/conversation-schema.test.ts`

Expected: FAIL because the new tables and columns do not exist.

- [ ] **Step 3: Define JSON-safe conversation types**

Create `src/chat/binding.ts`:

```ts
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ConversationBinding {
  adapterId: string;
  conversationKey: string;
  destination: JsonValue;
  reply?: JsonValue;
}

export interface AdapterReceipt { value: JsonValue }

export function sameConversation(left: ConversationBinding, right: ConversationBinding): boolean {
  return left.adapterId === right.adapterId && left.conversationKey === right.conversationKey;
}
```

Extend `SourceContext` in `src/core/types.ts` with optional `binding`, `arrivalSequence`, and `queueNoticeRequired`; add `ConversationBinding` via a type-only import. Keep internal event/recovery sources representable without a binding.

Define the canonical chat ingress type used by all later tasks:

```ts
export interface CanonicalChatSource {
  id: string;
  nativeSourceId: string;
  binding: ConversationBinding;
  rawText: string;
  attachmentIds: readonly string[];
  receivedAt: number;
}
```

- [ ] **Step 4: Append the migration**

Add one migration entry in `src/storage/migrations.ts` that:

```sql
ALTER TABLE source_contexts ADD COLUMN adapter_id TEXT;
ALTER TABLE source_contexts ADD COLUMN conversation_key TEXT;
ALTER TABLE source_contexts ADD COLUMN destination_json TEXT;
ALTER TABLE source_contexts ADD COLUMN native_reply_json TEXT;
ALTER TABLE source_contexts ADD COLUMN arrival_sequence INTEGER;
ALTER TABLE source_contexts ADD COLUMN source_class TEXT NOT NULL DEFAULT 'internal' CHECK(source_class IN ('chat', 'internal'));
ALTER TABLE source_contexts ADD COLUMN queue_notice_required INTEGER NOT NULL DEFAULT 0 CHECK(queue_notice_required IN (0, 1));

CREATE TABLE arrival_sequence (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  next_value INTEGER NOT NULL
);
INSERT INTO arrival_sequence(singleton, next_value) VALUES (1, 1);

CREATE TABLE conversation_cutover (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  phase TEXT NOT NULL CHECK(phase IN ('schema_added', 'routing_backfilled', 'complete'))
);
INSERT INTO conversation_cutover(singleton, phase) VALUES (1, 'schema_added');

CREATE TABLE assistant_turn_lease (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  phase TEXT NOT NULL CHECK(phase IN ('starting', 'active', 'terminalizing')),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES assistant_attempts(id),
  primary_context_id TEXT NOT NULL REFERENCES source_contexts(id),
  adapter_id TEXT,
  conversation_key TEXT,
  destination_json TEXT,
  native_reply_json TEXT,
  client_user_message_id TEXT NOT NULL,
  turn_id TEXT,
  trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('chat', 'internal')),
  capacity_claim_id TEXT NOT NULL,
  steer_paused INTEGER NOT NULL DEFAULT 0 CHECK(steer_paused IN (0, 1)),
  pause_reason TEXT
);

CREATE TABLE assistant_attempt_sources (
  attempt_id TEXT NOT NULL REFERENCES assistant_attempts(id),
  context_id TEXT NOT NULL REFERENCES source_contexts(id),
  source_ordinal INTEGER NOT NULL,
  client_user_message_id TEXT NOT NULL,
  submission_kind TEXT NOT NULL CHECK(submission_kind IN ('start', 'steer')),
  state TEXT NOT NULL CHECK(state IN ('pending', 'start_submitting', 'steer_submitting', 'uncertain', 'submitted', 'completed', 'failed', 'superseded')),
  expected_turn_id TEXT,
  observed_turn_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(attempt_id, context_id),
  UNIQUE(attempt_id, source_ordinal)
);
CREATE UNIQUE INDEX assistant_source_nonterminal_idx ON assistant_attempt_sources(context_id)
  WHERE state IN ('start_submitting', 'steer_submitting', 'uncertain', 'submitted');
CREATE UNIQUE INDEX assistant_single_unresolved_input_idx ON assistant_attempt_sources((1))
  WHERE state IN ('start_submitting', 'steer_submitting', 'uncertain');

ALTER TABLE assistant_attempts ADD COLUMN adapter_id TEXT;
ALTER TABLE assistant_attempts ADD COLUMN conversation_key TEXT;
ALTER TABLE assistant_attempts ADD COLUMN destination_json TEXT;
ALTER TABLE assistant_attempts ADD COLUMN native_reply_json TEXT;
ALTER TABLE assistant_attempts ADD COLUMN tool_fence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assistant_attempts ADD COLUMN accepting_tools INTEGER NOT NULL DEFAULT 1;

ALTER TABLE operations ADD COLUMN effect_class TEXT NOT NULL DEFAULT 'side_effecting'
  CHECK(effect_class IN ('read_only', 'side_effecting'));

ALTER TABLE deliveries ADD COLUMN adapter_id TEXT;
ALTER TABLE deliveries ADD COLUMN conversation_key TEXT;
ALTER TABLE deliveries ADD COLUMN destination_json TEXT;
ALTER TABLE deliveries ADD COLUMN reply_json TEXT;
ALTER TABLE deliveries ADD COLUMN receipt_json TEXT;
```

Drop `source_context_source_idx`, then add `UNIQUE(adapter_id, source_id) WHERE adapter_id IS NOT NULL` for chat rows and `UNIQUE(kind, source_id) WHERE adapter_id IS NULL` for internal rows. The raw migration leaves `arrival_sequence` nullable so retained rows can be backfilled; Task 2 installs its final unique index and non-null insert/update triggers after filling every row and advancing the allocator. Use `CHECK(singleton = 1)` to enforce the single lease.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npm test -- tests/storage/conversation-schema.test.ts tests/storage/database.test.ts && npm run typecheck`

Expected: PASS; update the migration-count assertion in `tests/storage/database.test.ts` to the new exact count.

- [ ] **Step 6: Commit**

```bash
git add src/chat/binding.ts src/core/types.ts src/storage/migrations.ts tests/storage/conversation-schema.test.ts tests/storage/database.test.ts
git commit -m "feat: add conversation steering schema"
```

## Task 2: Implement config-aware legacy cutover

**Files:**
- Create: `src/storage/conversation-cutover.ts`
- Modify: `src/storage/database.ts`
- Test: `tests/storage/conversation-cutover.test.ts`
- Modify: `tests/storage/database.test.ts`
- Modify: `src/production-app.ts`

- [ ] **Step 1: Write legacy fixture tests**

Build a file-backed fixture at the schema version before Task 1, insert Telegram sources in pending/completed/superseded states, an event batch, active attempt, and deliveries in prepared/dispatched/uncertain/confirmed/failed states. Reopen through normal migrations, then call:

```ts
const binding = {
  adapterId: "telegram",
  conversationKey: "telegram:42",
  destination: { chatId: "42" },
} as const;
runConversationRoutingBackfill(db, binding);
runConversationRoutingBackfill(db, binding);
```

Assert every retained source has a unique non-null arrival sequence, all Telegram rows have the binding, destinationless event rows remain destinationless, all delivery states have adapter-neutral routing/receipt JSON, `arrival_sequence.next_value` is `MAX(arrival_sequence) + 1`, and the second invocation changes no rows. Include a recovery source whose `source_id` points to a superseded Telegram source and assert it inherits that source's binding while retaining `source_class = 'internal'`; include a destinationless recovery and assert it remains internal. Assert null/duplicate arrival inserts fail after backfill and the first new allocation uses the next value. Add a fixture whose Telegram source cannot be related to the configured destination and assert `CONFIGURATION_ERROR`, `conversation_cutover.phase` remains `schema_added`, `qiyan_state` remains version 2, and no backfill mutation commits.

Add a separate finalization test with an authoritative full thread snapshot:

```ts
finalizeConversationCutover(db, {
  threadId: "assistant",
  turns: [{ id: "turn-1", status: "inProgress", itemsView: "full", items: [{ type: "userMessage", clientId: "ctx-active" }] }],
});
assert.equal(db.prepare("SELECT state_version FROM qiyan_state WHERE product = 'qiyan-bot'").get()!.state_version, 3);
```

Assert summary/not-loaded snapshots cannot finalize an active-attempt cutover and that every retained source/delivery—not only schedulable rows—is validated on a version-3 reopen.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/storage/conversation-cutover.test.ts`

Expected: FAIL because the two cutover phase functions do not exist.

- [ ] **Step 3: Implement the cutover transaction**

Create `src/storage/conversation-cutover.ts` with two public phases:

```ts
import type { ConversationBinding } from "../chat/binding.ts";
import type { Database } from "./database.ts";

export function runConversationRoutingBackfill(db: Database, telegram: ConversationBinding): void;
export function finalizeConversationCutover(db: Database, assistant: FullAssistantThreadSnapshot): void;
```

`runConversationRoutingBackfill` runs before endpoints exist. Inside one `BEGIN IMMEDIATE` transaction:

1. Return when the cutover phase is already `routing_backfilled` or `complete`, after validating every retained row.
2. Allocate `arrival_sequence` for every retained `source_contexts` row ordered by `created_at, id`.
3. Backfill all `kind = 'telegram'` sources and attempts from the configured binding. Walk the durable `recovery.source_id -> original source` relation: chat-derived recovery inherits the original binding but retains internal classification, while unprovable recovery remains destinationless internal or fails closed if active.
4. Backfill every delivery state from its legacy `destination`, `reply_to`, and `telegram_message_id` into adapter-neutral JSON.
5. Backfill `operations.effect_class = 'read_only'` only for the fixed read-only tool set (`list_managed_sessions`, `discover_sessions`, `get_session_status`, `read_worker_message`, `list_models`, `get_goal`); every delivery-producing, mutating, or unknown kind remains side-effecting.
6. Set `arrival_sequence.next_value` to `MAX(arrival_sequence) + 1`, create a unique index, and install `BEFORE INSERT/UPDATE` triggers that reject null sequences.
7. Persist cutover phase `routing_backfilled`; keep `qiyan_state.state_version = 2`.

`finalizeConversationCutover` runs only after the assistant endpoint supplies a full authoritative thread snapshot. It creates/reconciles the provisional lease and membership for any active legacy attempt, including an inherited-binding recovery attempt, validates all retained source/delivery classes, marks `conversation_cutover.phase = 'complete'`, and sets `qiyan_state.state_version = 3` in one transaction. Use `AppError("CONFIGURATION_ERROR", ...)` for ambiguity. Do not start pollers, delivery, MCP, or scheduling before both phases complete.

Change `assertQiYanDatabase` in `src/storage/database.ts` to accept known state versions 2 and 3 before opening read-write; reject every other value without mutation. Fresh databases still begin at 2 and become 3 only through the cutover. Extend `tests/storage/database.test.ts` to reopen a cut-over version-3 database and to reject version 4 read-only.

- [ ] **Step 4: Wire cutover before store use**

In the `storage` phase of `src/production-app.ts`, call `runConversationRoutingBackfill` immediately after `openDatabase` and before constructing `OperationStore` or `DeliveryStore`, using:

```ts
const telegramBinding: ConversationBinding = {
  adapterId: "telegram",
  conversationKey: `telegram:${config.telegramDestinationChatId}`,
  destination: { chatId: String(config.telegramDestinationChatId) },
};
runConversationRoutingBackfill(db, telegramBinding);
```

In the assistant endpoint/reconciliation phase, read the assistant thread with full turns, call `finalizeConversationCutover`, and only then construct/enable runtime scheduling, MCP dispatch, delivery, and polling. On an unavailable endpoint leave phase `routing_backfilled`, fail startup closed, and preserve all rows for retry.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/storage/conversation-cutover.test.ts tests/storage/database.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/storage/conversation-cutover.ts src/storage/database.ts src/production-app.ts tests/storage/conversation-cutover.test.ts tests/storage/database.test.ts
git commit -m "feat: migrate legacy Telegram routing"
```

## Task 3: Generalize durable delivery and adapter dispatch

**Files:**
- Create: `src/chat/adapter-registry.ts`
- Create: `src/chat/delivery-worker.ts`
- Modify: `src/chat/contracts.ts`
- Modify: `src/storage/delivery-store.ts`
- Modify: `src/telegram/chat-adapter.ts`
- Modify: `src/production-app.ts`
- Modify: `src/assistant/runtime.ts`
- Modify: `src/assistant/auth-recovery.ts`
- Modify: `src/events/relay.ts`
- Modify: `src/events/delivery-status.ts`
- Modify: `src/sessions/service.ts`
- Delete: `src/telegram/delivery-worker.ts`
- Test: `tests/chat/adapter-registry.test.ts`
- Test: `tests/chat/delivery-worker.test.ts`
- Modify: `tests/storage/delivery-store.test.ts`
- Modify: `tests/events/delivery-status.test.ts`
- Modify: `tests/integration/recovery.test.ts`
- Modify: `tests/assistant/runtime.test.ts`
- Modify: `tests/assistant/auth-recovery.test.ts`
- Modify: `tests/events/relay.test.ts`
- Modify: `tests/sessions/service.test.ts`
- Modify: `tests/telegram/delivery-worker.test.ts`

- [ ] **Step 1: Write adapter-neutral store and routing tests**

Use two fake adapters with opaque destinations and receipts:

```ts
const telegram = fakeAdapter("telegram", { messageId: 7 });
const slack = fakeAdapter("slack", { ts: "1.2" });
const registry = new ChatAdapterRegistry([telegram, slack]);
const delivery = store.prepare({
  id: "d1",
  kind: "chat",
  binding: { adapterId: "slack", conversationKey: "slack:C1", destination: { channel: "C1" } },
  body: "hello",
  mandatory: true,
});
await worker.processOne(delivery.id);
assert.deepEqual(store.get("d1")?.receipt, { ts: "1.2" });
assert.equal(slack.sent.length, 1);
assert.equal(telegram.sent.length, 0);
```

Also assert uncertain mandatory recovery preserves the adapter binding, optional warnings use the same binding, attachment upload works with opaque destination JSON, and an unknown adapter fails deterministically without mutating another adapter.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/chat/adapter-registry.test.ts tests/chat/delivery-worker.test.ts tests/storage/delivery-store.test.ts`

Expected: FAIL because the generic registry/worker and binding-aware store do not exist.

- [ ] **Step 3: Change the contracts**

Replace numeric Telegram assumptions in `src/chat/contracts.ts` with:

```ts
import type { JsonValue } from "./binding.ts";

export interface ChatDeliveryAdapter {
  readonly id: string;
  sendMessage(destination: JsonValue, body: string, reply?: JsonValue): Promise<JsonValue>;
  sendDocument?(destination: JsonValue, file: {
    stream: AsyncIterable<Uint8Array | string>;
    size: number;
    displayName: string;
    mediaType: string;
    caption?: string;
    reply?: JsonValue;
  }): Promise<JsonValue>;
}
```

Keep `ChatAdapter` lifecycle methods and expose its delivery adapter ID.

- [ ] **Step 4: Implement registry, generic worker, and store fields**

`ChatAdapterRegistry` validates unique IDs and exposes `delivery(id)`. Move the existing worker logic to `src/chat/delivery-worker.ts`; select the adapter per record and pass opaque JSON through unchanged.

Change `DeliveryStore.prepare` to require `binding: ConversationBinding`, persist adapter ID, conversation key, destination/reply JSON, return the exact binding and receipt, and change `confirm(id, receipt: JsonValue)`. Warning deliveries copy the original binding. Remove authoritative use of `telegramMessageId` and numeric `replyTo`. Add a round-trip assertion where two bindings share destination JSON but have different conversation keys.

Adapt Telegram transport wrappers to translate `{ chatId: string }`, `{ messageId: number }`, and optional reply JSON at the edge only.

Update every current producer in this same task so the commit typechecks. Attempt-bound routing is introduced later; for now pass the existing configured Telegram administrative binding wherever code currently passes the global destination. Update `AssistantRuntime`, auth recovery, event relay/status, session collection, production warnings/tools, and all tests/imports listed above. Autonomous worker finals and infrastructure warnings keep this administrative binding until a future adapter policy changes them. Remove the old worker only after all imports use `src/chat/delivery-worker.ts`.

- [ ] **Step 5: Run affected tests and commit**

Run: `npm test -- tests/chat tests/storage/delivery-store.test.ts tests/assistant/runtime.test.ts tests/assistant/auth-recovery.test.ts tests/events tests/sessions/service.test.ts tests/integration/recovery.test.ts tests/telegram && npm run typecheck`

Expected: PASS.

```bash
git add src/chat src/storage/delivery-store.ts src/telegram src/production-app.ts src/assistant/runtime.ts src/assistant/auth-recovery.ts src/events src/sessions/service.ts tests/chat tests/storage/delivery-store.test.ts tests/assistant/runtime.test.ts tests/assistant/auth-recovery.test.ts tests/events tests/sessions/service.test.ts tests/integration/recovery.test.ts tests/telegram
git commit -m "refactor: make chat delivery adapter neutral"
```

## Task 4: Build the durable conversation store and atomic ingress

**Files:**
- Create: `src/storage/conversation-store.ts`
- Modify: `src/storage/operation-store.ts`
- Modify: `src/attachments/store.ts`
- Test: `tests/storage/conversation-store.test.ts`
- Modify: `tests/attachments/store.test.ts`

- [ ] **Step 1: Write ingress, notice, membership, and fairness tests**

Cover these exact transactions:

```ts
const first = store.acceptChatSource(message("one", binding("telegram", "chat-1")));
assert.equal(first.disposition, "pending");
store.acquireLease({ kind: "chat", contextId: "one" }, "claim-one");
const second = store.acceptChatSource(message("two", binding("slack", "dm-1")));
assert.equal(second.disposition, "queued");
assert.equal(deliveries.get("queued:two")?.body, "[system] queued");
assert.equal(store.lease()?.primaryContextId, "one");
```

Add cases for duplicate native IDs, concurrent idle persistence without premature ownership, same-owner admission without a notice, unique arrival sequence, one nonterminal membership per source, one globally unresolved input, source state paired with membership state, and lease acquisition creating missing notices for all pending non-owner sources. Delete a required notice row, then prove both duplicate ingress and `repairQueueNotices()` recreate the deterministic ID exactly once. Test an internal lease notices every pending chat source. Chat acceptance must never choose a lease; only dispatcher arbitration does. Ingest an attachment at ref-count zero, accept the source, and assert exactly one retain occurs in the acceptance transaction; duplicate acceptance must keep the count at one.

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/storage/conversation-store.test.ts`

Expected: FAIL because `ConversationStore` does not exist.

- [ ] **Step 3: Implement the store API**

Create `src/storage/conversation-store.ts` with explicit DTOs and these methods:

```ts
export class ConversationStore {
  acceptChatSource(input: CanonicalChatSource, commitNativeCheckpoint?: () => void): { contextId: string; disposition: "pending" | "owner" | "queued" };
  createInternalSource(input: InternalSource): string;
  lease(): AssistantLease | undefined;
  acquireLease(candidate: { kind: "chat" | "internal"; contextId: string }, capacityClaimId: string): AssistantLease;
  reserveStart(contextId: string): ReservedSubmission;
  reserveNextSteer(attemptId: string): ReservedSubmission | undefined;
  markSubmitted(attemptId: string, contextId: string, turnId: string): void;
  markUncertain(attemptId: string, contextId: string): void;
  restorePending(attemptId: string, contextId: string): void;
  beginTerminalizing(turnId: string): AssistantLease | undefined;
  membersForAttempt(attemptId: string): AttemptSource[];
  clearLease(attemptId: string): void;
  repairQueueNotices(): number;
}
```

Every public mutation uses `inTransaction`; network I/O never occurs here. `acceptChatSource` creates the source, retains each newly accepted attachment exactly once, and creates any notice intent atomically, then invokes the optional synchronous native checkpoint before commit. A duplicate does not retain again. Inject `AttachmentStore` and use a transaction-safe retain method that verifies `(scope_id = contextId, attachment_id)` without starting a nested transaction. With no lease it leaves the source pending so the dispatcher can arbitrate due internal events. `acquireLease` is the sole lease creator; it persists the caller-owned capacity claim ID, compare-and-sets no existing lease, and atomically notices every losing conversation. `reserveStart`/`reserveNextSteer` change `source_contexts.state` to `active` in the same transaction as membership creation. Use compare-and-set `WHERE state = ...` checks and throw `OPERATION_CONFLICT` when an invariant is stale.

`ConversationStore` owns queue/lease/membership primitives only. `AssistantRuntime` remains the sole transactional authority for successful completion, effect-free requeue, effectful recovery creation, operation-receipt capture, inherited binding, and attachment release in Task 7.

- [ ] **Step 4: Adapt OperationStore reads**

Parse and return binding/sequence/notice fields. Make pending listing order by `arrival_sequence, id`; keep an internal-only listing used by event batching. Move chat source creation to `ConversationStore` so adapters cannot bypass atomic routing.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/storage/conversation-store.test.ts tests/storage/operation-store.test.ts tests/attachments/store.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/storage/conversation-store.ts src/storage/operation-store.ts src/attachments/store.ts tests/storage/conversation-store.test.ts tests/storage/operation-store.test.ts tests/attachments/store.test.ts
git commit -m "feat: add durable conversation ingress"
```

## Task 5: Add explicit app-server capacity claims and full-history reconciliation

**Files:**
- Modify: `src/app-server/pool.ts`
- Test: `tests/app-server/pool.test.ts`
- Modify: `tests/integration/app-server.test.ts`

- [ ] **Step 1: Write claim and history-view tests**

Add tests for:

```ts
const claim = pool.claimTurnCapacity("assistant-local", "assistant", "claim-1");
assert.equal(pool.activeTurnCount, 1);
pool.restoreTurnCapacityClaim("assistant-local", "assistant", "claim-1", { phase: "provisional" });
assert.equal(pool.activeTurnCount, 1);
pool.bindTurnCapacityClaim(claim, "turn-1");
pool.markTurnTerminal("assistant-local", "assistant", "turn-1");
assert.equal(pool.activeTurnCount, 0);
```

Verify an ambiguous start retains the provisional claim, endpoint unavailability does not discard a dispatcher-owned claim, `summary`/`notLoaded` items views never prove absence, and only `itemsView: "full"` may support negative reconciliation.

Register a capacity listener, exhaust the pool, release/terminalize one claim, and assert the listener fires once after capacity becomes available. Removing the listener prevents later callbacks.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/app-server/pool.test.ts tests/integration/app-server.test.ts`

Expected: FAIL because explicit claims and full-view checks do not exist.

- [ ] **Step 3: Implement explicit claim lifecycle**

Add:

```ts
export interface TurnCapacityClaim { id: string; endpointId: string; threadId: string }

claimTurnCapacity(endpointId: string, threadId: string, claimId: string): TurnCapacityClaim;
restoreTurnCapacityClaim(endpointId: string, threadId: string, claimId: string, state: { phase: "provisional" | "active"; turnId?: string }): TurnCapacityClaim;
bindTurnCapacityClaim(claim: TurnCapacityClaim, turnId: string): void;
releaseTurnCapacityClaim(claim: TurnCapacityClaim): void;
onCapacityAvailable(listener: () => void): () => void;
```

Change `startTurn` to accept an optional caller-owned claim and never release it on `OPERATION_UNCERTAIN`. Keep old self-owned claim behavior for project sessions. Emit a coalesced capacity-available signal whenever a release or terminal transition takes the pool below its limit. Add `readFullThread`/reconciliation helpers that reject negative inference unless every relevant terminal turn reports `itemsView === "full"`.

- [ ] **Step 4: Add a live steer correlation test**

In `tests/integration/app-server.test.ts`, make an opt-in supported-version protocol probe. Use a prompt that requires a controlled five-second shell command, wait until the returned turn is active, and call `turn/steer` with a unique `clientUserMessageId`. Retry the whole probe at most three times if the model completes before the steer; when explicitly enabled, fail with a diagnostic if no attempt remains active rather than silently skipping. Read full history and assert the user item exposes that client ID. Probe a repeated ID and record whether it is rejected or deduplicated without enabling production retries unless the protocol advertises an idempotency capability. Deterministic unit tests remain the normal correctness gate; the enabled integration probe supplies required protocol evidence.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/app-server/pool.test.ts tests/integration/app-server.test.ts && npm run typecheck`

Expected: unit tests PASS; the live test follows the suite's existing integration skip conditions.

```bash
git add src/app-server/pool.ts tests/app-server/pool.test.ts tests/integration/app-server.test.ts
git commit -m "feat: persist assistant turn capacity claims"
```

## Task 6: Implement the conversation dispatcher with native steering

**Files:**
- Create: `src/assistant/conversation-dispatcher.ts`
- Test: `tests/assistant/conversation-dispatcher.test.ts`

- [ ] **Step 1: Write actor tests with controllable promises**

Build a fake runner whose start and steer promises can be held. Assert:

```ts
await dispatcher.accept(chatSource("first", "chat-1"));
runner.resolveStart({ turn: { id: "turn-1", status: "inProgress" } });
await dispatcher.accept(chatSource("follow-up", "chat-1"));
assert.deepEqual(runner.steers[0], {
  threadId: "assistant",
  expectedTurnId: "turn-1",
  clientUserMessageId: "follow-up",
  input: [{ type: "text", text: "more", text_elements: [] }],
});
```

While the first steer is held, accept another owner message and assert no second steer call. Accept another conversation and assert only `[system] queued` is created. Publish terminal before steer response and assert lease remains `terminalizing` until reconciliation. Assert no code waits for item/tool notifications.

For both `turn/start` and `turn/steer`, use a source with text, an image, and a document and assert the exact input order is text, local image, then mention/document. This is the submission-contract test; Task 8 separately tests later tool access to those attachments.

Exercise the complete capacity lifecycle: `CAPACITY_EXCEEDED` leaves the source pending with no lease and does not spin; releasing another claim posts one actor wake and the pending source then starts. A successful claim ID is persisted with lease acquisition; proven-no-effect start releases it; positive start binds it to the turn; ambiguous start retains it; and terminal completion releases it. Simulate a lease CAS loss after claiming and assert the unused claim is released.

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/assistant/conversation-dispatcher.test.ts`

Expected: FAIL because the dispatcher does not exist.

- [ ] **Step 3: Implement the single-thread actor**

Create:

```ts
export interface AssistantTurnPort {
  start(params: TurnStartParams, claim: TurnCapacityClaim): Promise<TurnStartResponse>;
  steer(params: TurnSteerParams): Promise<TurnSteerResponse>;
  readThread(): Promise<Thread>;
}

export class ConversationDispatcher {
  accept(source: CanonicalChatSource, commitNativeCheckpoint?: () => void): Promise<void>;
  enqueueInternal(contextId: string): Promise<void>;
  terminal(turn: Turn): Promise<void>;
  recover(): Promise<void>;
  idle(): Promise<void>;
  stop(): Promise<void>;
}
```

Use one short-running promise tail/actor mailbox to serialize database decisions. `accept` persists through `ConversationStore.acceptChatSource(source, commitNativeCheckpoint)`, then posts a wake event. The mailbox never awaits start/steer network I/O: it persists the submitting state, launches the promise, returns, and posts a separate result event back to the mailbox. This lets `terminal` mark `terminalizing` while a steer response is held. The actor maintains one in-flight submission token and ignores stale result events through compare-and-set state. Do not subscribe to `item/*` events.

With no lease, the actor asks the internal scheduler whether an event batch is due and compares that with the oldest chat/recovery head. It first obtains `AppServerPool.claimTurnCapacity` with a stable claim ID, then calls the store's sole `acquireLease(candidate, claim.id)` or event materialize/acquire method. A capacity failure leaves all input pending, marks the actor capacity-waiting, and returns without immediate re-pump. The dispatcher subscribes once to `onCapacityAvailable`; that callback posts a coalesced wake. A bounded one-second retry timer is only a lost-wakeup safety net and is cancelled when capacity succeeds or the dispatcher stops. A lease CAS loss releases the unused claim. Start success binds the claim to the native turn; proven no-effect releases it; ambiguity retains it; terminal completion releases it. Chat ingress never creates a lease independently.

- [ ] **Step 4: Implement conservative uncertainty**

On lost start/steer response, read full history by client ID. Positive evidence submits; full terminal absence restores pending; active absence marks uncertain and stops the lane. Known stale errors restore pending. A non-steerable rejection restores the source and sets the lease's durable `steer_paused` flag; the pump does not retry owner input until terminal reconciliation clears the lease. Never retransmit an uncertain steer.

Expand the actor test matrix to cover crashes before start dispatch, after native acceptance, and after response persistence; terminal notification before and after every steer-state write; full/summary/not-loaded history; and non-steerable pause without a retry loop.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/assistant/conversation-dispatcher.test.ts tests/app-server/pool.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/assistant/conversation-dispatcher.ts tests/assistant/conversation-dispatcher.test.ts
git commit -m "feat: steer active assistant conversations"
```

## Task 7: Make runtime multi-source and fence terminal tool work

**Files:**
- Modify: `src/assistant/runtime.ts`
- Modify: `src/assistant/tools.ts`
- Modify: `src/storage/operation-store.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/assistant/runtime.test.ts`
- Modify: `tests/mcp/server.test.ts`

- [ ] **Step 1: Write multi-source terminal and tool-fence tests**

Add two sources to one attempt, complete it, and assert both source states and attachment releases. Fail effect-free and assert both return pending with refs retained. Fail after a dispatched operation and assert one recovery source supersedes both.

Add a table-driven recovery matrix:

```ts
for (const row of [
  { effectClass: "side_effecting", state: "prepared", effectful: false },
  { effectClass: "side_effecting", state: "failed", effectful: false },
  { effectClass: "read_only", state: "succeeded", effectful: false },
  { effectClass: "side_effecting", state: "dispatched", effectful: true },
  { effectClass: "side_effecting", state: "uncertain", effectful: true },
  { effectClass: "side_effecting", state: "succeeded", effectful: true },
]) assert.equal(classifyAttemptEffects([row as any]), row.effectful);
```

Delivery-producing tools are persisted as side-effecting operations before they create an outbox intent, so a committed delivery intent appears as dispatched/uncertain/succeeded side-effecting state and forces grouped recovery. Unknown operation kinds default side-effecting.

Use a blocked action promise:

```ts
const call = tools.send_to_session(context, args);
runtime.beginTerminalizing("turn-1");
await runtime.fenceTools("attempt-1", 10);
releaseAction();
await assert.rejects(call, /terminalized|uncertain/);
assert.equal(operations.get(operationId)?.state, "uncertain");
```

Assert new MCP dispatch is rejected after terminalization and late success cannot overwrite uncertain.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/assistant/runtime.test.ts tests/mcp/server.test.ts`

Expected: FAIL because runtime handles only one context and operation success is unconditional.

- [ ] **Step 3: Extend runtime context and hydration**

Change the active context to:

```ts
export interface ActiveAssistantContext {
  attemptId: string;
  contextId: string; // primary source, retained for existing callers
  turnId: string;
  triggerKind: "chat" | "internal";
  binding?: ConversationBinding;
  toolFence: number;
}
```

Add `hydrateActive`, `beginTerminalizing`, `registerTool`, `finishTool`, and `fenceTools`. `hydrateActive` reads the durable attempt/lease and is called before MCP starts accepting tool calls after restart. Retaining `contextId` avoids an intermediate repository-wide rename; Task 8 adds `effectiveSourceContextId` for guarded actions.

- [ ] **Step 4: Make operation transitions fenced CAS updates**

Add attempt fence and persisted `effectClass` to `ToolActionContext`/`OperationRecord`. `OperationStore.prepare` requires the caller to provide `read_only` or `side_effecting`; `createAssistantTools` derives it from the central read-only tool set before preparation, and unknown kinds remain side-effecting. Change success/failure methods to update only the expected nonterminal state and fence. A terminalization timeout changes dispatched operations to uncertain and increments the fence in one transaction. A late handler whose CAS changes zero rows returns/throws `OPERATION_UNCERTAIN` without rewriting the receipt.

Rewrite terminal completion/failure to iterate `assistant_attempt_sources`; release only permanently completed/superseded source refs. `AssistantRuntime` performs one transaction that queries operation states/receipts, applies the explicit effect matrix above, updates every membership/source, creates one inherited-binding recovery source when effects may have occurred, updates event batches, and releases source references. Prepared and deterministic-no-effect failed operations do not force recovery; succeeded read-only operations do not force recovery; dispatched, uncertain, or succeeded side-effecting operations do. `ConversationStore` supplies membership reads and lease primitives but does not independently create recovery. The runtime API is:

```ts
handleTerminal(turnId: string, status: "completed" | "failed" | "interrupted", finalText?: string, error?: unknown): { recoveryContextId?: string };
```

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/assistant/runtime.test.ts tests/mcp/server.test.ts tests/integration/recovery.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/assistant/runtime.ts src/assistant/tools.ts src/storage/operation-store.ts src/mcp/server.ts tests/assistant/runtime.test.ts tests/mcp/server.test.ts tests/integration/recovery.test.ts
git commit -m "feat: terminalize multi-source assistant attempts"
```

## Task 8: Resolve attempt attachments and FIFO safeguards

**Files:**
- Create: `src/assistant/attempt-scope.ts`
- Modify: `src/assistant/tools.ts`
- Modify: `src/attachments/store.ts`
- Modify: `src/assistant/conversation-dispatcher.ts`
- Modify: `src/storage/conversation-store.ts`
- Modify: `src/production-app.ts`
- Test: `tests/assistant/attempt-scope.test.ts`
- Modify: `tests/assistant/tools.test.ts`
- Modify: `tests/attachments/store.test.ts`

- [ ] **Step 1: Write safeguard race and attachment tests**

Create an attempt with a primary normal source plus two steered `/pass` sources and two `/collect` sources. Put the first safeguard in `steer_submitting` and assert the corresponding tool waits instead of dispatching. Mark it submitted and assert exact action arguments use its source scope. Assert:

- malformed safeguard blocks ordinary fallback;
- same call ID replays;
- new calls consume safeguards FIFO;
- mismatch and post-exhaustion calls fail;
- deterministic no-effect failure releases consumption;
- success/uncertainty keeps consumption bound;
- native non-acceptance restores pending without a side effect;
- two `/collect` calls produce distinct delivery keys.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/assistant/attempt-scope.test.ts tests/assistant/tools.test.ts tests/attachments/store.test.ts`

Expected: FAIL because directive lookup and attachments are primary-source-only.

- [ ] **Step 3: Implement AttemptScope**

Create this public surface:

```ts
export class AttemptScope {
  admittedSources(attemptId: string): AttemptSource[];
  waitUntilSubmitted(attemptId: string, contextId: string): Promise<void>;
  resolveAttachment(attemptId: string, attachmentId: string): { contextId: string; attachmentId: FileHandleId };
  resolveSafeguard(input: {
    attemptId: string;
    callId: string;
    tool: "send_to_session" | "collect_messages";
    args: unknown;
  }): Promise<{
    effectiveSourceContextId: string;
    operation: OperationRecord;
    replay: boolean;
    releaseConsumptionOnNoEffect(): void;
  }>;
}
```

Parse admitted sources in `source_ordinal` order. Treat submitting/uncertain candidates as queue-activating, but await `submitted` before action dispatch. Bind consumption and `OperationStore.prepare` in one transaction and return the typed operation record. Use an attempt-local waiter notified by dispatcher submission transitions; add dispatcher notifications after submitted, restored-pending, and terminal membership transitions. A restored-pending candidate rejects the waiting tool with proven no effect.

- [ ] **Step 4: Pass effective source scope into actions**

Extend `ToolActionContext` with `effectiveSourceContextId`. For ordinary calls use the primary source; for guarded calls use the matched source. Change `send_to_session`, direct collection, and inbound attachment retention in `src/production-app.ts` to use this effective source. Use `operationId` as the direct-collection delivery key.

Remove numeric `reply_to` from the two chat tool schemas. Chat output uses the immutable attempt binding.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/assistant/attempt-scope.test.ts tests/assistant/tools.test.ts tests/attachments/store.test.ts tests/sessions/final-messages.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/assistant/attempt-scope.ts src/assistant/tools.ts src/assistant/conversation-dispatcher.ts src/storage/conversation-store.ts src/attachments/store.ts src/production-app.ts tests/assistant/attempt-scope.test.ts tests/assistant/tools.test.ts tests/attachments/store.test.ts tests/sessions/final-messages.test.ts
git commit -m "feat: validate steered safeguards by source"
```

## Task 9: Preserve internal event fairness at lease boundaries

**Files:**
- Modify: `src/assistant/scheduler.ts`
- Modify: `src/assistant/conversation-dispatcher.ts`
- Modify: `src/storage/conversation-store.ts`
- Test: `tests/assistant/scheduler.test.ts`
- Modify: `tests/assistant/conversation-dispatcher.test.ts`

- [ ] **Step 1: Rewrite scheduler tests around completed ownership periods**

Keep event batching/coalescing tests, but replace user-job execution with an arbitration API:

```ts
scheduler.enqueueEvent(event("e1", 0));
for (let index = 0; index < 5; index += 1) scheduler.noteConversationPeriodCompleted();
assert.deepEqual(scheduler.peekEligibleEventBatch(1_000)?.eventIds, ["e1"]);
```

With a fake clock, assert a 30-second event wins only after the active lease releases. A long active turn is never interrupted. Chat-derived recovery counts as one conversation period; destinationless event batches do not. Test a failed lease CAS leaves the peeked events eligible, while a successful materialize/acquire marks them batched and prevents replay after restart.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/assistant/scheduler.test.ts tests/assistant/conversation-dispatcher.test.ts`

Expected: FAIL under the old execute-and-await scheduler API.

- [ ] **Step 3: Narrow AssistantScheduler to internal arbitration**

Expose event enqueue/coalescing and:

```ts
noteConversationPeriodCompleted(): void;
peekEligibleEventBatch(now?: number): { batchId: string; eventIds: string[]; payload: unknown } | undefined;
commitEventBatch(batchId: string, eventIds: readonly string[]): void;
nextWakeAt(): number | undefined;
```

The dispatcher consults it only with no lease. In one mailbox action it peeks the due event candidate and oldest chat/recovery head and applies the comparator, then obtains a pool capacity claim. For an event winner, call a new `ConversationStore.materializeAndAcquireEventBatch(candidate, claim.id)` transaction that verifies every event is still pending, creates the destinationless internal source and `event_batches` row, marks events batched/active, and acquires the lease. Only after that transaction succeeds call `scheduler.commitEventBatch`; on CAS loss release the claim, leave the peek untouched, and re-pump. For a chat/recovery winner, call `ConversationStore.acquireLease(candidate, claim.id)`, which verifies the candidate remains pending. Startup rebuilds scheduler memory from pending events, while already materialized batch sources are recovered directly and cannot be peeked again. Preserve max 20 events, 8 KiB, 1-second batching, five completed periods, and 30-second maximum age at lease boundaries.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/assistant/scheduler.test.ts tests/assistant/conversation-dispatcher.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/assistant/scheduler.ts src/assistant/conversation-dispatcher.ts src/storage/conversation-store.ts tests/assistant/scheduler.test.ts tests/assistant/conversation-dispatcher.test.ts
git commit -m "refactor: arbitrate events at assistant lease boundaries"
```

## Task 10: Add Telegram canonical conversation normalization

**Files:**
- Modify: `src/telegram/adapter.ts`
- Modify: `src/telegram/types.ts`
- Modify: `tests/telegram/adapter.test.ts`

- [ ] **Step 1: Write pure conversation identity tests**

Assert a private Telegram update normalizes to:

```ts
{
  adapterId: "telegram",
  conversationKey: "telegram:42",
  destination: { chatId: "42" },
  reply: { messageId: 9 },
}
```

Assert two updates in the same chat share a conversation key, a different chat differs, native update/message IDs remain stable, attachment handles retain source order, and unauthorized updates still classify as ignored. This task adds only a pure normalization helper; it does not change the live poller constructor yet.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/telegram/adapter.test.ts`

Expected: FAIL because the pure canonical-source helper does not exist.

- [ ] **Step 3: Implement the additive normalization helper**

Export a pure helper without changing `TelegramPoller` or `TelegramChatAdapter` signatures:

```ts
toTelegramCanonicalSource(message: ClassifiedTelegramMessage, attachmentIds: readonly string[]): CanonicalChatSource;
```

The helper constructs the Telegram binding and preserves raw text, update/native IDs, receive time, and ordered handles. Task 11 switches poller/composition atomically so this intermediate commit remains type-correct.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/telegram/adapter.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/telegram/adapter.ts src/telegram/types.ts tests/telegram/adapter.test.ts
git commit -m "feat: normalize Telegram conversation ingress"
```

## Task 11: Integrate dispatcher, recovery, routing, and shutdown

**Files:**
- Modify: `src/production-app.ts`
- Modify: `src/assistant/runtime.ts`
- Modify: `src/assistant/auth-recovery.ts`
- Modify: `src/events/delivery-status.ts`
- Modify: `src/events/relay.ts`
- Modify: `src/sessions/service.ts`
- Modify: `src/chat/contracts.ts`
- Modify: `src/telegram/poller.ts`
- Modify: `src/telegram/chat-adapter.ts`
- Modify: `tests/production-app.test.ts`
- Modify: `tests/assistant/auth-recovery.test.ts`
- Modify: `tests/events/relay.test.ts`
- Modify: `tests/events/delivery-status.test.ts`
- Modify: `tests/sessions/final-messages.test.ts`
- Modify: `tests/integration/recovery.test.ts`
- Modify: `tests/integration/telegram-live.test.ts`
- Modify: `tests/telegram/poller.test.ts`
- Modify: `tests/telegram/chat-adapter.test.ts`

- [ ] **Step 1: Write production seam tests**

Inject a fake assistant turn port and fake adapters into a production composition seam. Assert:

- a second same-conversation message calls `turn/steer` before terminal;
- another conversation commits `[system] queued` and never steers;
- assistant finals, chat tools, direct collection, and chat-derived recovery use the attempt binding;
- startup/auth/dashboard/infrastructure warnings and autonomous worker finals use the configured administrative binding rather than whichever attempt happens to be active;
- destinationless internal attempts suppress finals and reject chat output;
- terminal late output retains the old binding;
- restart restores starting/active capacity claims, runtime current context, and uncertain lane before MCP/scheduling;
- first-upgrade finalization restores the newly migrated active lease claim before any managed-session or other pooled work;
- startup recreates a missing deterministic queue notice before the outbox drains;
- shutdown fences tools, interrupts only a proven active turn, and leaves ambiguity durable.

Inject a failure after source/notice/attachment retention but before Telegram checkpoint commit. Assert source row, notice row, ref-count increment, and offset all roll back. Replay the same update and assert exactly one source, one retain, and one offset advance.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/production-app.test.ts tests/assistant/auth-recovery.test.ts tests/events tests/sessions/final-messages.test.ts tests/telegram/poller.test.ts tests/telegram/chat-adapter.test.ts tests/integration/recovery.test.ts`

Expected: FAIL because production still constructs the old FIFO job path and global Telegram destination.

- [ ] **Step 3: Replace user-job scheduling in composition**

In `src/production-app.ts`:

1. Construct `ConversationStore`, `AttemptScope`, adapter registry, generic delivery worker, runtime, and dispatcher.
2. Immediately after constructing `AppServerPool`, load any durable lease and restore its provisional/active capacity claim before endpoint reconciliation, managed-session resume, or any other pooled work; this DB-only restoration must work while the endpoint is unavailable.
3. Atomically switch `TelegramPoller`/`TelegramChatAdapter` to `onMessage(message, commitNativeCheckpoint)` and route it to `dispatcher.accept(message, commitNativeCheckpoint)`. The store retains newly accepted attachments exactly once and advances the Telegram offset in the same transaction; duplicate redelivery does neither twice.
4. Keep `AssistantScheduler` only for event peeking/coalescing. The dispatcher pulls a candidate and uses `materializeAndAcquireEventBatch`; production no longer separately enqueues a batch context.
5. Replace `runAssistantJob`, `terminalWaiters`, `enqueuedSources`, and user `enqueueSource` with dispatcher calls.
6. Forward assistant `turn/completed` directly to `dispatcher.terminal`.
7. Bind causal assistant finals, chat tools, direct collection, and chat-derived recovery to the immutable attempt/source binding; reject destinationless chat-output tools. Keep startup/auth/dashboard/infrastructure warnings and autonomous worker finals on the explicitly configured administrative binding. Never consult a mutable current attempt for those non-causal categories.
8. During startup, run routing backfill and restore any already durable capacity claim immediately after pool construction. Start/recover the assistant endpoint without starting other pooled work, finalize cutover from full history, then immediately restore the claim of any lease created by finalization. Only after that second restore may managed sessions or other pooled work resume. Reconcile the assistant lease/runtime, call `conversationStore.repairQueueNotices()`, and only then recover/drain the outbox and enable MCP turns, delivery, and polling.
9. During stop, stop ingress, drain/fence tools, stop the actor, then stop endpoints and outbox.

- [ ] **Step 4: Add a live Telegram steering smoke path**

Extend the opt-in live diagnostic to send one task and poll the durable lease for `active` with a real turn ID. If the model completes before an active lease is observed, skip with a diagnostic rather than fail. Otherwise send the second same-chat message and assert both source IDs belong to one assistant attempt, the second membership kind is `steer`, and only one final assistant delivery is emitted. Keep tokens and owner IDs environment-controlled; deterministic dispatcher tests remain the correctness gate.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/production-app.test.ts tests/assistant/auth-recovery.test.ts tests/events tests/sessions/final-messages.test.ts tests/telegram/poller.test.ts tests/telegram/chat-adapter.test.ts tests/integration/recovery.test.ts tests/integration/telegram-live.test.ts && npm run typecheck`

Expected: PASS with live tests skipped unless explicitly enabled.

```bash
git add src/production-app.ts src/assistant/runtime.ts src/assistant/auth-recovery.ts src/chat/contracts.ts src/telegram/poller.ts src/telegram/chat-adapter.ts src/events src/sessions/service.ts tests/production-app.test.ts tests/assistant/auth-recovery.test.ts tests/events tests/sessions/final-messages.test.ts tests/telegram/poller.test.ts tests/telegram/chat-adapter.test.ts tests/integration/recovery.test.ts tests/integration/telegram-live.test.ts
git commit -m "feat: integrate conversation-bound assistant steering"
```

## Task 12: Update user documentation and run release verification

**Files:**
- Modify: `README.md`
- Modify: `docs/setup.md`
- Modify: `docs/chat-apps/telegram.md`
- Modify: `docs/chat-apps/slack.md`
- Modify: `tests/docs.test.ts`

- [ ] **Step 1: Write documentation contract assertions**

In `tests/docs.test.ts`, assert shared docs contain the exact queue notice, conversation ownership rule, native steering statement, and directive non-special scheduling statement:

```ts
assert.match(readme, /\[system\] queued/);
assert.match(readme, /same conversation.*turn\/steer/is);
assert.match(readme, /\/pass.*\/collect.*ordinary messages/is);
```

Assert Slack remains marked planned rather than implying that an adapter ships in this change.

- [ ] **Step 2: Run the docs test and verify RED**

Run: `npm test -- tests/docs.test.ts`

Expected: FAIL because the behavior is not documented.

- [ ] **Step 3: Update docs**

Document:

- one active QiYan conversation globally;
- same-conversation messages and attachments use native Codex steering;
- another conversation receives `[system] queued` for every blocked message;
- `/pass` and `/collect` are ordinary steerable input with backend exactness safeguards only;
- QiYan never chooses a platform or destination;
- Telegram is implemented, Slack and WeChat remain planned;
- approval mode remains unsupported and full-auto risk warnings remain unchanged.

- [ ] **Step 4: Run full verification**

Run:

```bash
npm run typecheck
npm test
npm run build
git diff --check
git status --short
```

Expected: typecheck, all non-opt-in tests, and build PASS; `git diff --check` is silent; only the intended documentation/test changes remain before commit.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/setup.md docs/chat-apps/telegram.md docs/chat-apps/slack.md tests/docs.test.ts
git commit -m "docs: explain conversation-bound steering"
```

## Final review loop

After Task 12:

1. Run `npm run check && npm run build` from a clean working tree.
2. Ask two independent reviewers to inspect the complete commit range from `9665c73` through `HEAD`: one for state-machine/recovery correctness and one for routing/security/test coverage.
3. Fix every confirmed Critical, Important, and Minor finding with a failing regression test first.
4. Repeat review until both reviewers report no findings.
5. Re-run `npm run check && npm run build`, inspect `git status --short`, and report exact evidence.
