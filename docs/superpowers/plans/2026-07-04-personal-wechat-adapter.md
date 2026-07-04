# Personal WeChat Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one officially authorized personal-WeChat bot channel to QiYan with terminal QR login, owner-only text/image/file ingress, voice transcription, durable ambiguity-safe egress, and concurrent Telegram/Slack operation.

**Architecture:** A new `src/weixin/` boundary separates credential pinning, Tencent wire decoding, durable account/inbox/outbox state, media crypto, ingress, delivery, and adapter lifecycle. Existing platform-neutral conversation and delivery layers gain only the minimum generic capabilities needed for route catalogs, inbox attachment holds, and uncertain-delivery reconciliation. All protocol behavior is exercised through injected fake transports; real credentials are used only by an opt-in live test.

**Tech Stack:** strict TypeScript, Node.js 24 built-ins (`fetch`, `crypto`, `fs`, `sqlite`), `zod`, pinned `lossless-json` 4.3.0, pinned `qrcode-terminal` 0.12.0, Node test runner, esbuild single-binary packaging.

---

## File map

- `src/weixin/credential-store.ts`: private credential file, atomic replacement, parent/file identity pins, opaque runtime handle.
- `src/weixin/endpoint-policy.ts`: Tencent HTTPS host/path validation and bounded manual redirect resolution.
- `src/weixin/protocol.ts`: lossless JSON decoding, wire schemas, normalized message identities, safe numeric conversions.
- `src/weixin/api-client.ts`: endpoint-specific request headers/bodies, authenticated API calls, CDN calls, aborts, and failure categories.
- `src/weixin/auth-client.ts`: QR creation/status/verification and already-bound credential probe.
- `src/weixin/login.ts`: bounded terminal login state machine and credential commit.
- `src/weixin/account-store.ts`: account-generation activation, credential revisions, authorization latch, and stale incidents.
- `src/weixin/inbox-store.ts`: cursor/inbox/route-token transactions, claims, media checkpoints, and holds.
- `src/weixin/event-classifier.ts`: direct-owner message normalization without retaining unauthorized content.
- `src/weixin/media.ts`: AES key decoding, PKCS#7 streaming bounds, deterministic attachment IDs, safe filenames.
- `src/weixin/ingress-worker.ts`: ordered media processing and atomic canonical-source acceptance.
- `src/weixin/outbound-store.ts`: immutable step plans and per-effect durable dispatch state.
- `src/weixin/delivery-adapter.ts`: text/image/file execution and uncertain reconciliation.
- `src/weixin/chat-adapter.ts`: startup activation, polling, backoff, health, and bounded shutdown.
- `src/chat/contracts.ts`, `src/chat/delivery-worker.ts`, `src/chat/owner-route-store.ts`: generic uncertain reconciliation and alternate administrative routing.
- `src/config-source.ts`, `src/config.ts`, `src/cli.ts`, `src/main.ts`, `src/production-app.ts`: async credential bootstrap, third adapter configuration, CLI login, and composition.
- `src/storage/migrations.ts`, `src/storage/database.ts`, `src/attachments/store.ts`: additive WeChat state and transaction-safe inbox holds.
- `docs/chat-apps/wechat.md`, `README.md`, `.env.example`: supported scope, setup, security, and troubleshooting.

### Task 1: Pin dependencies and protocol provenance

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/weixin/provenance.ts`
- Create: `tests/weixin/provenance.test.ts`
- Modify: `tests/distribution/package-info.test.ts`

- [ ] **Step 1: Write the failing dependency/provenance tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import packageJson from "../../package.json" with { type: "json" };
import { WEIXIN_PROTOCOL_REFERENCE } from "../../src/weixin/provenance.ts";

test("pins only the reviewed Tencent protocol dependencies", () => {
  assert.equal(packageJson.devDependencies["lossless-json"], "4.3.0");
  assert.equal(packageJson.devDependencies["qrcode-terminal"], "0.12.0");
  assert.equal(WEIXIN_PROTOCOL_REFERENCE.revision, "cef0bfc390393f716903e16d50408118047f87e0");
  assert.equal(Object.keys(packageJson.devDependencies).some((name) => name.includes("openclaw")), false);
});
```

- [ ] **Step 2: Run the test and verify the missing module/dependencies fail**

Run: `npm test -- tests/weixin/provenance.test.ts tests/distribution/package-info.test.ts`

Expected: FAIL because `src/weixin/provenance.ts` and the pinned dependencies do not exist.

- [ ] **Step 3: Install exact dependencies and add immutable provenance**

Run: `npm install --save-dev --save-exact lossless-json@4.3.0 qrcode-terminal@0.12.0 @types/qrcode-terminal@0.12.2`

Create:

```ts
export const WEIXIN_PROTOCOL_REFERENCE = Object.freeze({
  repository: "https://github.com/Tencent/openclaw-weixin",
  revision: "cef0bfc390393f716903e16d50408118047f87e0",
  release: "2.4.6",
  license: "MIT",
});
```

Extend the package audit to require the bundled modules while rejecting any `openclaw` package or copied Tencent source path.

- [ ] **Step 4: Run targeted tests**

Run: `npm test -- tests/weixin/provenance.test.ts tests/distribution/package-info.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add package.json package-lock.json src/weixin/provenance.ts tests/weixin/provenance.test.ts tests/distribution/package-info.test.ts
git commit -m "build: pin personal WeChat protocol dependencies"
```

### Task 2: Enforce Tencent endpoint trust and lossless protocol decoding

**Files:**
- Create: `src/weixin/endpoint-policy.ts`
- Create: `src/weixin/protocol.ts`
- Create: `tests/weixin/endpoint-policy.test.ts`
- Create: `tests/weixin/protocol.test.ts`

- [ ] **Step 1: Write failing endpoint and decoder tests**

Cover HTTPS-only Tencent label boundaries, userinfo/port rejection, endpoint path families, validated bounded redirects, canonical uint64 values above `Number.MAX_SAFE_INTEGER`, kind-separated message/client identities, missing identities, mixed valid/malformed batches, opaque cursor replacement, and missing/empty successor cursors preserving an existing cursor. Add byte/depth/schema limit fixtures for API JSON (8 MiB and depth 64), at most 100 messages and 20 items per message, 64 KiB cursors, 16 KiB context tokens, 64 KiB retained text, and 16 KiB individual auth/QR fields.

```ts
assert.equal(validateTencentUrl("https://ilinkai.weixin.qq.com/ilink/bot/getupdates", "api").hostname, "ilinkai.weixin.qq.com");
assert.throws(() => validateTencentUrl("https://weixin.qq.com.evil.test/x", "api"));
assert.deepEqual(parseUpdates('{"ret":0,"get_updates_buf":"AA==","msgs":[{"message_id":9007199254740993}]}').messages[0]?.identity,
  { kind: "message", value: "9007199254740993" });
assert.equal(parseUpdates('{"ret":0,"get_updates_buf":"","msgs":[]}').cursor, undefined);
assert.throws(() => parseUpdates(nestedJson(65)), /nesting limit/i);
```

- [ ] **Step 2: Run tests to verify missing exports fail**

Run: `npm test -- tests/weixin/endpoint-policy.test.ts tests/weixin/protocol.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement the narrow public contracts**

```ts
export type WeixinEndpointKind = "qr" | "api" | "cdn-download" | "cdn-upload";
export function validateTencentUrl(value: string | URL, kind: WeixinEndpointKind): URL;
export function resolveTencentRedirect(current: URL, location: string, kind: WeixinEndpointKind, hop: number, maxHops?: number): URL;

export type WeixinMessageIdentity = { kind: "message" | "client"; value: string };
export interface ParsedUpdates { ret: 0; cursor?: string; timeoutMs?: number; messages: readonly ParsedMessageCandidate[] }
export function parseUpdates(raw: string): ParsedUpdates;
export async function readBoundedJson(response: Response, limits: { maxBytes: number; maxDepth: number }): Promise<string>;
export function canonicalUnsignedInteger(value: unknown, label: string): string;
export function boundedSafeInteger(value: unknown, label: string, min: number, max: number): number;
```

Use `lossless-json.parse`, preserve candidate-local errors, reject an invalid envelope as a whole, and never compare cursors numerically or lexically. Keep untrusted raw JSON inside this module.

- [ ] **Step 4: Run targeted tests**

Run: `npm test -- tests/weixin/endpoint-policy.test.ts tests/weixin/protocol.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/weixin/endpoint-policy.ts src/weixin/protocol.ts tests/weixin/endpoint-policy.test.ts tests/weixin/protocol.test.ts
git commit -m "feat: validate WeChat protocol inputs losslessly"
```

### Task 3: Build the private credential store and per-use pin

**Files:**
- Create: `src/weixin/credential-store.ts`
- Create: `tests/weixin/credential-store.test.ts`
- Modify: `src/config-source.ts`
- Modify: `tests/config-source.test.ts`

- [ ] **Step 1: Write failing filesystem-race and secret-boundary tests**

Exercise schema version 1, `0700` directory/`0600` file, atomic temp-sync/rename/directory-sync ordering, same-identity generation preservation, different-identity generation replacement, malformed/unknown schemas, symlink and hard-link rejection, delete/recreate/inode/content swaps after bootstrap, and absence of WeChat secrets from child/service environment lists.

```ts
const handle = await store.loadPinned();
assert.equal(handle.public.accountGenerationId.length > 0, true);
await replaceFileAtSamePath(credentialsPath, anotherValidCredential);
await assert.rejects(handle.withVerifiedCredential(async () => undefined), /credential changed/i);
assert.equal(BOT_SECRET_ENV_NAMES.has("WEIXIN_BOT_TOKEN"), true);
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/weixin/credential-store.test.ts tests/config-source.test.ts`

Expected: FAIL for the missing store and WeChat secret stripping.

- [ ] **Step 3: Implement versioned storage and opaque handle**

```ts
export interface WeixinCredentialPublic {
  accountGenerationId: string;
  credentialRevisionId: string;
  botId: string;
  ownerUserId: string;
  apiBaseUrl: string;
}
export interface WeixinCredentialHandle {
  readonly public: WeixinCredentialPublic;
  withVerifiedCredential<T>(operation: (credential: Readonly<WeixinCredential>) => Promise<T>): Promise<T>;
}
export class WeixinCredentialStore {
  constructor(qiyanHome: string, options?: { expectedUid?: number; fsHooks?: CredentialFsHooks });
  loadPinned(): Promise<WeixinCredentialHandle | undefined>;
  commitConfirmed(input: ConfirmedWeixinCredential): Promise<WeixinCredentialPublic>;
}
```

Pin every managed parent plus the file by canonical path, device, inode, owner, type, link count, mode, and SHA-256. Reverify immediately before invoking the operation callback. Add pseudo WeChat credential names to secret-unset sets even though real credentials never enter `.env`.

- [ ] **Step 4: Run targeted tests**

Run: `npm test -- tests/weixin/credential-store.test.ts tests/config-source.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/weixin/credential-store.ts src/config-source.ts tests/weixin/credential-store.test.ts tests/config-source.test.ts
git commit -m "feat: store and pin WeChat credentials privately"
```

### Task 4: Implement exact QR and authenticated Tencent clients

**Files:**
- Create: `src/weixin/api-client.ts`
- Create: `src/weixin/auth-client.ts`
- Create: `tests/weixin/api-client.test.ts`
- Create: `tests/weixin/auth-client.test.ts`

- [ ] **Step 1: Write failing wire-contract fixtures**

Assert exact methods and headers for QR creation/status, authenticated JSON calls, and CDN calls; `base_info.channel_version` and `base_info.bot_agent`; fresh uint32 UINs; manual redirect validation; no bearer on CDN; 200 plus bounded `x-encrypted-param` for uploads; aborts/timeouts; and redacted failure categories. Assert the bounded reader rejects oversized API JSON before parsing, QR/auth JSON above 256 KiB, depth above 64, and over-limit QR/token/ID/base-URL fields without echoing their values. Assert `-14` is represented as authorization failure without retaining body text.

```ts
assert.deepEqual(observedQrRequest, {
  method: "POST",
  path: "/ilink/bot/get_bot_qrcode?bot_type=3",
  authorizationType: "ilink_bot_token",
  bearer: undefined,
  body: { local_token_list: ["prior-token"] },
});
assert.equal(observedCdnHeaders.authorization, undefined);
```

- [ ] **Step 2: Run tests to verify missing clients fail**

Run: `npm test -- tests/weixin/api-client.test.ts tests/weixin/auth-client.test.ts`

Expected: FAIL because the clients do not exist.

- [ ] **Step 3: Implement injected transport clients**

```ts
export interface WeixinHttpTransport { fetch(input: URL, init: RequestInit): Promise<Response> }
export class WeixinApiClient {
  getUpdates(cursor: string, signal: AbortSignal): Promise<ParsedUpdates>;
  getConfig(signal?: AbortSignal): Promise<void>;
  sendMessage(request: WeixinSendMessageRequest, signal?: AbortSignal): Promise<WeixinSendReceipt>;
  getUploadUrl(request: WeixinUploadRequest, signal?: AbortSignal): Promise<WeixinUploadTarget>;
  upload(target: WeixinUploadTarget, body: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<WeixinUploadReceipt>;
  download(url: URL, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  sendTyping(state: "start" | "stop", signal?: AbortSignal): Promise<void>;
  notifyLifecycle(state: "start" | "stop", signal?: AbortSignal): Promise<void>;
}
export class WeixinAuthClient {
  createQr(localToken?: string, signal?: AbortSignal): Promise<WeixinQrChallenge>;
  pollQr(challenge: WeixinQrChallenge, verificationCode?: string, signal?: AbortSignal): Promise<WeixinQrState>;
}
```

Use `redirect: "manual"` and a single request helper that revalidates every hop. Credential verification must wrap every authenticated or CDN dispatch.

- [ ] **Step 4: Run targeted tests**

Run: `npm test -- tests/weixin/api-client.test.ts tests/weixin/auth-client.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/weixin/api-client.ts src/weixin/auth-client.ts tests/weixin/api-client.test.ts tests/weixin/auth-client.test.ts
git commit -m "feat: implement Tencent WeChat wire clients"
```

### Task 5: Add the bounded terminal WeChat login command

**Files:**
- Create: `src/weixin/login.ts`
- Create: `tests/weixin/login.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/main.ts`
- Modify: `tests/cli.test.ts`
- Modify: `tests/bin.test.ts`

- [ ] **Step 1: Write failing CLI and state-machine tests**

Test `qiyan-bot weixin-login [--home]`, no assistant/app-server startup, all exact QR states, terminal QR rendering, numeric verification input, bounded refresh/rejection, regional redirects, cancellation, already-bound successful `getconfig` no-op, one empty-token retry after stale probe, confirmation field/base-URL requirements, and prior-file rollback on failure.

```ts
assert.deepEqual(parseCliArgs(["weixin-login", "--home", "/private/qiyan"]), { command: "weixin-login", qiyanHome: "/private/qiyan" });
await runWeixinLogin(config, fakeTerminal, fakeAuth);
assert.equal(fakeTerminal.output.some((line) => line.includes(botToken)), false);
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/weixin/login.test.ts tests/cli.test.ts tests/bin.test.ts`

Expected: FAIL because the command/state machine is missing.

- [ ] **Step 3: Implement terminal abstractions and state transitions**

```ts
export interface WeixinLoginTerminal {
  renderQr(payload: string): void;
  promptVerificationCode(): Promise<string>;
  status(message: string): void;
}
export async function runWeixinLogin(input: {
  store: WeixinCredentialStore;
  auth: WeixinAuthClient;
  terminal: WeixinLoginTerminal;
  signal?: AbortSignal;
}): Promise<WeixinCredentialPublic>;
```

Dispatch this command before ordinary config loading. Never print IDs, tokens, QR payload text, raw responses, or verification codes.

- [ ] **Step 4: Run targeted tests**

Run: `npm test -- tests/weixin/login.test.ts tests/cli.test.ts tests/bin.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/weixin/login.ts src/cli.ts src/main.ts tests/weixin/login.test.ts tests/cli.test.ts tests/bin.test.ts
git commit -m "feat: add terminal WeChat QR login"
```

### Task 6: Bootstrap WeChat asynchronously into configuration

**Files:**
- Create: `src/weixin/bootstrap.ts`
- Create: `tests/weixin/bootstrap.test.ts`
- Modify: `src/config.ts`
- Modify: `src/main.ts`
- Modify: `src/app.ts`
- Modify: `src/production-app.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/config-source.test.ts`
- Modify: `tests/app.test.ts`

- [ ] **Step 1: Write failing bootstrap/config tests**

Cover run/config-check sharing the bootstrap, other commands bypassing it, WeChat-only primary selection at configuration time, all three adapters requiring explicit `PRIMARY_CHAT_APP`, valid `weixin`, invalid credentials failing closed, public configured flag only in config, and credential handle never entering serializable config or environment. Do not claim that a WeChat-only run can start until Task 14 composes the adapter.

```ts
const boot = await bootstrapWeixin(qiyanHome);
const config = loadConfig(values, { qiyanHome, weixinConfigured: boot.configured });
assert.equal(config.chat.primary, "weixin");
assert.equal("token" in JSON.parse(JSON.stringify(config)), false);
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/weixin/bootstrap.test.ts tests/config.test.ts tests/config-source.test.ts`

Expected: FAIL because WeChat is not a supported adapter/config override.

- [ ] **Step 3: Implement the split public/private bootstrap**

```ts
export interface WeixinBootstrap { configured: boolean; credential?: WeixinCredentialHandle }
export async function bootstrapWeixin(qiyanHome: string): Promise<WeixinBootstrap>;

export interface AppRuntimeOptions {
  phases?: readonly AppPhase[];
  weixinCredential?: WeixinCredentialHandle;
}
export async function createApp(config: BotConfig, options?: AppRuntimeOptions): Promise<BotApp>;

export interface ConfigOverrides {
  qiyanHome: string;
  assistantWorkdir?: string;
  weixinConfigured?: boolean;
}
export interface ChatConfig {
  primary: "telegram" | "slack" | "weixin";
  telegram?: TelegramConfig;
  slack?: SlackConfig;
  weixin?: { configured: true };
}
```

Return the opaque handle separately from `BotConfig`, pass it through `AppRuntimeOptions` directly to `buildProductionApp`, and make `config-check` validate but reveal only presence/validity. Refactor phase-injection tests to `createApp(config, { phases })`; `buildProductionApp` stores but does not activate the handle until Task 14.

- [ ] **Step 4: Run targeted tests**

Run: `npm test -- tests/weixin/bootstrap.test.ts tests/config.test.ts tests/config-source.test.ts tests/app.test.ts tests/bin.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/weixin/bootstrap.ts src/config.ts src/main.ts src/app.ts src/production-app.ts tests/weixin/bootstrap.test.ts tests/config.test.ts tests/config-source.test.ts tests/app.test.ts tests/bin.test.ts
git commit -m "feat: bootstrap WeChat configuration privately"
```

### Task 7: Add durable account generations, latches, incidents, and schema migration

**Files:**
- Modify: `src/storage/migrations.ts`
- Modify: `src/storage/database.ts`
- Modify: `src/storage/delivery-store.ts`
- Create: `src/weixin/account-store.ts`
- Create: `tests/storage/weixin-schema.test.ts`
- Create: `tests/weixin/account-store.test.ts`
- Modify: `tests/storage/database.test.ts`
- Modify: `tests/storage/delivery-store.test.ts`

- [ ] **Step 1: Write failing migration and activation tests**

Create file-backed fixtures for exact product state versions 2 and 3 (including completed routing cutover), then assert all WeChat constraints/indexes. Test same generation/new revision preserving sync/inbox/routes, different identity fencing inbox and atomically failing unsent old deliveries, non-WeChat latest-route preservation, WeChat latest-route clearing, durable `active`/`relogin_required`/`credential_changed` latch transitions, and one incident per transition. Inject a failure after one old delivery transition and prove account activation, outbound-step cleanup, delivery state, and attachment release all roll back.

```ts
const activation = store.activate(credential.public);
assert.equal(activation.kind, "new-generation");
assert.equal(store.authorization(credential.public.accountGenerationId), "active");
assert.equal(store.latchInactive(generation, "relogin_required", "incident-1"), true);
assert.equal(store.latchInactive(generation, "relogin_required", "incident-2"), false);
```

- [ ] **Step 2: Run tests to verify missing schema fails**

Run: `npm test -- tests/storage/weixin-schema.test.ts tests/weixin/account-store.test.ts tests/storage/database.test.ts`

Expected: FAIL because the WeChat tables/store are absent.

- [ ] **Step 3: Add the append-only migration and transactional store**

Create constrained tables named exactly `weixin_account_generations`, `weixin_auth_incidents`, `weixin_sync_state`, `weixin_inbox`, `weixin_inbox_sequence`, `weixin_route_tokens`, `weixin_inbox_media`, `weixin_inbox_attachment_refs`, and `weixin_outbound_steps`. Do not change supported product marker versions; make the migration operate on either supported existing database.

```ts
export type WeixinAuthorizationState = "active" | "relogin_required" | "credential_changed";
export class WeixinAccountStore {
  activate(identity: WeixinCredentialPublic): WeixinActivation;
  requireActive(generationId: string): void;
  latchInactive(generationId: string, state: Exclude<WeixinAuthorizationState, "active">, incidentId: string): boolean;
  latchInactiveInTransaction(generationId: string, state: Exclude<WeixinAuthorizationState, "active">, incidentId: string): WeixinAuthTransition;
  markIncidentRouteInTransaction(incidentId: string, result: { warningDeliveryId: string } | { noRoute: true }): void;
  listUnwarnedIncidents(): readonly WeixinAuthIncident[];
}

export interface WeixinAuthorizationIncidentSink {
  transition(input: { generationId: string; state: "relogin_required" | "credential_changed"; category: string }): Promise<void>;
}

// DeliveryStore: called by owners that already hold BEGIN IMMEDIATE.
failInTransaction(id: string): boolean;
```

Implement public wrappers as transactions around the explicit in-transaction primitives. `latchInactiveInTransaction` updates the latch and inserts/deduplicates the incident but deliberately does not decide a chat route; its public wrapper records `no_route`. Task 14's shared incident coordinator will call the in-transaction primitive and prepare an alternate warning before commit. Implement `DeliveryStore.fail()` as a transaction wrapper around `failInTransaction()`. The delivery primitive must apply the terminal state and release the attachment reference exactly once. `WeixinAccountStore.activate` receives the delivery store and uses that primitive while retiring old-generation outbound plans.

- [ ] **Step 4: Run targeted tests**

Run: `npm test -- tests/storage/weixin-schema.test.ts tests/weixin/account-store.test.ts tests/storage/database.test.ts tests/storage/delivery-store.test.ts tests/fresh-cutover.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/storage/migrations.ts src/storage/database.ts src/storage/delivery-store.ts src/weixin/account-store.ts tests/storage/weixin-schema.test.ts tests/weixin/account-store.test.ts tests/storage/database.test.ts tests/storage/delivery-store.test.ts
git commit -m "feat: persist WeChat account lifecycle"
```

### Task 8: Persist owner-only inbox, opaque cursor, and route-token versions

**Files:**
- Create: `src/weixin/event-classifier.ts`
- Create: `src/weixin/inbox-store.ts`
- Create: `tests/weixin/event-classifier.test.ts`
- Create: `tests/weixin/inbox-store.test.ts`

- [ ] **Step 1: Write failing classification and transaction tests**

Test exact owner acceptance, direct-only enforcement, bot/unauthorized/malformed discard without body retention, text/voice-transcription/image/file descriptors, missing voice/video failed descriptors, same-batch valid plus malformed candidates, server order, kind/value dedupe, atomic cursor replacement, missing/empty successor preservation, replay, crash rollback, single processing head, restart recovery, generation fencing, immutable route-token selection, administrative latest-token selection, and reference-aware GC. Canonical `nativeSourceId` is `weixin:<account-generation-id>:<identity-kind>:<identity-value>`; equal Tencent IDs from two generations must create two accepted generic sources. Over-limit response/message/item/text/context-token/cursor fixtures must leave the cursor, inbox, route tokens, and logs unchanged.

```ts
store.commitPoll(generation, "old-cursor", parsedBatch);
assert.equal(store.cursor(generation), "new-cursor");
store.commitPoll(generation, "new-cursor", parseUpdates('{"ret":0,"get_updates_buf":"","msgs":[]}'));
assert.equal(store.cursor(generation), "new-cursor");
assert.deepEqual(store.listInbox().map((row) => row.identity), [
  { kind: "message", value: "9007199254740993" },
  { kind: "client", value: "9007199254740993" },
]);
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/weixin/event-classifier.test.ts tests/weixin/inbox-store.test.ts`

Expected: FAIL because classifier/store do not exist.

- [ ] **Step 3: Implement normalized rows and one transaction boundary**

```ts
export function classifyWeixinMessage(candidate: ParsedMessageCandidate, identity: WeixinOwnerIdentity): WeixinClassifiedMessage | undefined;
export class WeixinInboxStore {
  cursor(generationId: string): string;
  commitPoll(generationId: string, expectedCursor: string, batch: ParsedUpdates): WeixinPollCommit;
  claimHead(generationId: string): WeixinInboxRecord | undefined;
  recoverProcessing(generationId: string): void;
  resolveRouteToken(generationId: string, routeTokenId?: string): string | undefined;
  collectUnreferencedRouteTokens(generationId: string): number;
}
```

Persist only bounded normalized authorized fields. Store the context token solely in `weixin_route_tokens`; generic destinations contain its opaque record ID.

- [ ] **Step 4: Run targeted tests**

Run: `npm test -- tests/weixin/event-classifier.test.ts tests/weixin/inbox-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/weixin/event-classifier.ts src/weixin/inbox-store.ts tests/weixin/event-classifier.test.ts tests/weixin/inbox-store.test.ts
git commit -m "feat: persist the WeChat owner inbox"
```

### Task 9: Implement bounded WeChat media crypto and inbox attachment holds

**Files:**
- Create: `src/weixin/media.ts`
- Create: `tests/weixin/media.test.ts`
- Modify: `src/attachments/store.ts`
- Modify: `tests/attachments/store.test.ts`
- Modify: `src/weixin/inbox-store.ts`
- Modify: `tests/weixin/inbox-store.test.ts`

- [ ] **Step 1: Write failing crypto and hold tests**

Cover 32-hex, raw-byte base64, ASCII-hex base64 keys; invalid keys; AES-128-ECB encryption/decryption; strict PKCS#7/block checks; ciphertext/plaintext caps; keyless HTTPS images; keyed generic files; safe names; deterministic attachment IDs; checkpoint+hold atomicity; TTL cleanup while held; crash before/after checkpoint; duplicate checkpoint; and exact hold transfer/release. Add matching and mismatching lowercase MD5, declared plaintext length, declared ciphertext size, and supported image-signature fixtures; every mismatch is a permanent bounded failed-attachment descriptor.

```ts
assert.equal(decodeAesKey(Buffer.from("00112233445566778899aabbccddeeff").toString("base64")).toString("hex"), "00112233445566778899aabbccddeeff");
inbox.checkpointAttachment(row.id, item.id, attachment);
assert.equal(await attachments.cleanupExpired(), 0);
inbox.acceptSourceAndComplete(row.id, effects);
assert.equal(inbox.attachmentHoldCount(row.id), 0);
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/weixin/media.test.ts tests/weixin/inbox-store.test.ts tests/attachments/store.test.ts`

Expected: FAIL for missing crypto and hold primitives.

- [ ] **Step 3: Implement crypto streams and transaction-only hold APIs**

```ts
export function decodeWeixinAesKey(value: string): Buffer;
export function encryptWeixinMedia(source: AsyncIterable<Uint8Array>, key: Buffer, maxPlaintextBytes: number): AsyncIterable<Uint8Array>;
export function decryptWeixinMedia(source: AsyncIterable<Uint8Array>, key: Buffer, limits: WeixinMediaLimits): AsyncIterable<Uint8Array>;
export function verifyWeixinMediaIntegrity(input: { bytes: Uint8Array; md5?: string; plaintextSize?: number; ciphertextSize?: number; kind: "image" | "file" }): void;
export function deterministicWeixinAttachmentId(generationId: string, identity: WeixinMessageIdentity, itemOrdinal: number): FileHandleId;

// AttachmentStore methods invoked only inside an existing SQLite transaction:
retainInboxAttachmentInTransaction(holdId: string, scopeId: string, id: FileHandleId): void;
transferInboxAttachmentsToAcceptedSourceInTransaction(holdId: string, scopeId: string, ids: readonly FileHandleId[]): void;
releaseInboxAttachmentsInTransaction(holdId: string): void;
```

Make checkpoint insertion and ref-count increment one transaction. Fail closed on any hold/checkpoint inconsistency.

- [ ] **Step 4: Run targeted tests**

Run: `npm test -- tests/weixin/media.test.ts tests/weixin/inbox-store.test.ts tests/attachments/store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/weixin/media.ts src/weixin/inbox-store.ts src/attachments/store.ts tests/weixin/media.test.ts tests/weixin/inbox-store.test.ts tests/attachments/store.test.ts
git commit -m "feat: secure WeChat media checkpoints"
```

### Task 10: Build ordered WeChat ingress and canonical-source acceptance

**Files:**
- Create: `src/weixin/ingress-worker.ts`
- Create: `tests/weixin/ingress-worker.test.ts`

- [ ] **Step 1: Write failing ingress tests**

Test image/file success, keyless image, transient head retry and backoff, permanent integrity/format failed descriptors, voice transcription, missing voice transcription, unsupported video, text plus mixed media order, duplicate/restart reuse, atomic source/route/hold/processed commit, rollback, later rows not overtaking a poisoned transient head, and equal Tencent identity kind/value from two account generations producing two different accepted canonical sources.

```ts
await worker.drain();
assert.deepEqual(accepted[0]?.attachments.map((item) => item.kind), ["image", "document", "failed"]);
assert.equal(inbox.get(first.id)?.state, "processed");
assert.equal(inbox.get(second.id)?.state, "pending");
```

- [ ] **Step 2: Run tests to verify missing worker fails**

Run: `npm test -- tests/weixin/ingress-worker.test.ts`

Expected: FAIL because the worker and acceptance effects are missing.

- [ ] **Step 3: Implement the ordered worker and atomic acceptance hook**

```ts
export class WeixinIngressWorker {
  recoverAndDrain(): Promise<void>;
  drain(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

const effects: ChatAcceptanceEffects = {
  commitNativeCheckpoint: () => inbox.completeAndTransferHoldsInTransaction(row.id, source.id),
};
```

Classify failures before logging; log only category/operation/count. Use the existing generic `ConversationStore.acceptChatSource` and `ChatAcceptanceEffects.commitNativeCheckpoint` transaction hook so queue/steer behavior and layer boundaries remain unchanged.

- [ ] **Step 4: Run targeted tests**

Run: `npm test -- tests/weixin/ingress-worker.test.ts tests/storage/conversation-store.test.ts tests/assistant/conversation-dispatcher.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/weixin/ingress-worker.ts tests/weixin/ingress-worker.test.ts
git commit -m "feat: ingest personal WeChat messages durably"
```

### Task 11: Make uncertain delivery reconciliation generic

**Files:**
- Modify: `src/chat/contracts.ts`
- Modify: `src/chat/delivery-worker.ts`
- Modify: `src/storage/delivery-store.ts`
- Modify: `tests/chat/delivery-worker.test.ts`
- Modify: `tests/storage/delivery-store.test.ts`
- Modify: `tests/telegram/delivery-worker.test.ts`
- Modify: `tests/slack/delivery-adapter.test.ts`

- [ ] **Step 1: Write failing generic recovery tests**

Test `confirmed`, `resume_safe`, and `unresolved` for both mandatory and optional deliveries; unresolved never redispatches or releases its attachment; confirmed finalizes; resume-safe returns to prepared; adapters without a hook retain existing Telegram mandatory and Slack optional policies.

```ts
export type UncertainDeliveryResolution =
  | { outcome: "confirmed"; receipt: JsonValue }
  | { outcome: "resume_safe" }
  | { outcome: "unresolved" };
export interface UncertainDeliveryContext {
  id: string;
  binding: ConversationBinding;
  mandatory: boolean;
  hasAttachment: boolean;
}
```

- [ ] **Step 2: Run tests to verify contract failure**

Run: `npm test -- tests/chat/delivery-worker.test.ts tests/storage/delivery-store.test.ts tests/telegram/delivery-worker.test.ts tests/slack/delivery-adapter.test.ts`

Expected: FAIL because `reconcileUncertain` is not part of the contract.

- [ ] **Step 3: Implement reconciliation before generic policy**

```ts
export interface ChatDeliveryAdapter {
  readonly id: string;
  reconcileUncertain?(delivery: UncertainDeliveryContext): Promise<UncertainDeliveryResolution>;
  // existing send methods remain unchanged
}
```

Have `DeliveryWorker` call the hook first for every uncertain delivery. Add a store state transition that leaves unresolved rows and attachment references intact. Preserve existing behavior byte-for-byte when the hook is absent.

- [ ] **Step 4: Run targeted and regression tests**

Run: `npm test -- tests/chat/delivery-worker.test.ts tests/storage/delivery-store.test.ts tests/telegram/delivery-worker.test.ts tests/slack/delivery-adapter.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/chat/contracts.ts src/chat/delivery-worker.ts src/storage/delivery-store.ts tests/chat/delivery-worker.test.ts tests/storage/delivery-store.test.ts tests/telegram/delivery-worker.test.ts tests/slack/delivery-adapter.test.ts
git commit -m "feat: reconcile uncertain adapter deliveries"
```

### Task 12: Persist immutable WeChat outbound plans and text delivery

**Files:**
- Create: `src/weixin/outbound-store.ts`
- Create: `src/weixin/delivery-adapter.ts`
- Create: `tests/weixin/outbound-store.test.ts`
- Create: `tests/weixin/delivery-adapter.test.ts`

- [ ] **Step 1: Write failing plan/checkpoint tests**

Cover Unicode-safe 4,000-byte splitting, deterministic client IDs, frozen generation/owner/route token, immutable request hashes, prepared/dispatching/succeeded/uncertain states, crash before/after each text chunk, nonzero terminal failure, `-14` passed exactly once to an injected `WeixinAuthorizationIncidentSink`, credential-pin failure passed as `credential_changed`, no unresolved redispatch for mandatory or optional delivery, all-succeeded confirmation, and partial succeeded-step resume.

```ts
const chunks = splitWeixinText("🙂".repeat(2_001), 4_000);
assert.equal(chunks.every((chunk) => Buffer.byteLength(chunk) <= 4_000), true);
assert.equal(chunks.join(""), "🙂".repeat(2_001));
assert.equal((await adapter.reconcileUncertain(delivery)).outcome, "unresolved");
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/weixin/outbound-store.test.ts tests/weixin/delivery-adapter.test.ts`

Expected: FAIL because outbound planning/delivery is absent.

- [ ] **Step 3: Implement plan-first text dispatch**

```ts
export type WeixinOutboundStepState = "prepared" | "dispatching" | "succeeded" | "uncertain";
export class WeixinOutboundStore {
  prepareText(delivery: DeliveryRecord, target: WeixinFrozenDestination): readonly WeixinOutboundStep[];
  begin(stepId: string): void;
  succeed(stepId: string, receipt: JsonValue): void;
  markDispatchingUncertain(): number;
  reconcile(deliveryId: string): UncertainDeliveryResolution;
}
export function splitWeixinText(value: string, maxUtf8Bytes?: number): readonly string[];
```

Persist `dispatching` before each API call. Treat transport/malformed success as uncertain and syntactically valid nonzero Tencent responses as terminal failures. Freeze the route-token ID, never its secret value, into the plan.

- [ ] **Step 4: Run targeted tests**

Run: `npm test -- tests/weixin/outbound-store.test.ts tests/weixin/delivery-adapter.test.ts tests/chat/delivery-worker.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/weixin/outbound-store.ts src/weixin/delivery-adapter.ts tests/weixin/outbound-store.test.ts tests/weixin/delivery-adapter.test.ts
git commit -m "feat: deliver WeChat text without unsafe retries"
```

### Task 13: Add encrypted image/file delivery checkpoints

**Files:**
- Modify: `src/weixin/outbound-store.ts`
- Modify: `src/weixin/delivery-adapter.ts`
- Modify: `tests/weixin/outbound-store.test.ts`
- Modify: `tests/weixin/delivery-adapter.test.ts`

- [ ] **Step 1: Write failing canonical attachment fixtures**

Test fresh random 16-byte AES keys persisted before dispatch and reused after restart; deterministic 32-hex filekey/client IDs; exact `getuploadurl` body; both upload fields allowed with full URL preference; encrypted `POST`; 200 plus bounded `x-encrypted-param`; optional caption; exact image/file send bodies; audio/video rejection; retained snapshot reuse; and process death before/after parameter, upload, caption, and media checkpoints.

```ts
assert.notEqual(firstPlan.aesKeyHex, secondDeliveryPlan.aesKeyHex);
assert.equal(reloadedPlan.aesKeyHex, firstPlan.aesKeyHex);
assert.equal(observedUpload.method, "POST");
assert.equal(observedUpload.headers.authorization, undefined);
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/weixin/outbound-store.test.ts tests/weixin/delivery-adapter.test.ts`

Expected: FAIL because only text plans exist.

- [ ] **Step 3: Implement attachment plan creation and execution**

```ts
export interface WeixinAttachmentPlan {
  readonly aesKeyHex: string;
  readonly fileKey: string;
  readonly plaintextMd5: string;
  readonly plaintextSize: number;
  readonly ciphertextSize: number;
  readonly steps: readonly WeixinOutboundStep[];
}
```

Generate the random AES key inside the same transaction that inserts the immutable plan. Reopen only the retained `AttachmentStore` snapshot. Persist the validated upload receipt before sending caption/media. Ensure every post-dispatch ambiguity returns unresolved reconciliation.

- [ ] **Step 4: Run targeted tests**

Run: `npm test -- tests/weixin/outbound-store.test.ts tests/weixin/delivery-adapter.test.ts tests/attachments/store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/weixin/outbound-store.ts src/weixin/delivery-adapter.ts tests/weixin/outbound-store.test.ts tests/weixin/delivery-adapter.test.ts
git commit -m "feat: deliver encrypted WeChat attachments"
```

### Task 14: Compose polling, health, authorization incidents, and adapter lifecycle

**Files:**
- Create: `src/weixin/chat-adapter.ts`
- Create: `src/weixin/incident-coordinator.ts`
- Create: `tests/weixin/chat-adapter.test.ts`
- Create: `tests/weixin/incident-coordinator.test.ts`
- Modify: `src/weixin/account-store.ts`
- Modify: `tests/weixin/account-store.test.ts`
- Modify: `src/weixin/delivery-adapter.ts`
- Modify: `tests/weixin/delivery-adapter.test.ts`
- Modify: `src/chat/owner-route-store.ts`
- Modify: `tests/chat/owner-route-store.test.ts`
- Modify: `src/production-app.ts`
- Modify: `tests/production-app.test.ts`
- Modify: `tests/production-startup.test.ts`

- [ ] **Step 1: Write failing lifecycle and route-catalog tests**

Test authenticated startup probe/activation, primary owner binding before inbound traffic, single long poll, empty/committed cursors, bounded server timeout, exponential backoff+jitter/reset, concurrent Telegram/Slack independence, abortable stop, best-effort typing/notify, and a shared incident sink used by poll, media download, upload, and delivery for credential-pin and `-14` failures. Inject failures immediately before and after alternate warning preparation and prove latch, incident, route result, and warning delivery all roll back or commit together; also test no-route commit, startup reconciliation after an adapter becomes available, and alternate route priority excluding WeChat.

```ts
const catalog = new OwnerRouteCatalog([telegramBinding, slackBinding, weixinBinding], "weixin");
assert.deepEqual(catalog.warningRoute({ failedAdapterId: "weixin", current: slackBinding }), slackBinding);
await adapter.stop();
assert.equal(fakePoll.signal.aborted, true);
```

- [ ] **Step 2: Run tests to verify missing composition fails**

Run: `npm test -- tests/weixin/chat-adapter.test.ts tests/weixin/incident-coordinator.test.ts tests/weixin/account-store.test.ts tests/weixin/delivery-adapter.test.ts tests/chat/owner-route-store.test.ts tests/production-app.test.ts tests/production-startup.test.ts`

Expected: FAIL because no WeChat lifecycle or owner route catalog exists.

- [ ] **Step 3: Implement the adapter and administrative route catalog**

```ts
export class OwnerRouteCatalog {
  constructor(bindings: readonly ConversationBinding[], primaryAdapterId: string);
  warningRoute(input: { failedAdapterId: string; current?: ConversationBinding }): ConversationBinding | undefined;
}
export class WeixinIncidentCoordinator implements WeixinAuthorizationIncidentSink {
  transition(input: { generationId: string; state: "relogin_required" | "credential_changed"; category: string }): Promise<void>;
  reconcileUnwarned(): Promise<void>;
}
export class WeixinChatAdapter implements ChatAdapter {
  readonly delivery: WeixinDeliveryAdapter;
  readonly primaryBinding: ConversationBinding;
  initialize(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}
```

`WeixinIncidentCoordinator.transition` opens the only `BEGIN IMMEDIATE`, calls `WeixinAccountStore.latchInactiveInTransaction`, selects an alternate binding, calls transaction-safe `DeliveryStore.prepare`, then records either the warning delivery ID or `no_route` before commit. Inject this same coordinator into the poll loop, ingress media client, and `WeixinDeliveryAdapter`; no network consumer may mutate the latch directly. Never warn through the failed WeChat adapter. Keep health/status values body-free and secret-free.

- [ ] **Step 4: Run targeted tests**

Run: `npm test -- tests/weixin/chat-adapter.test.ts tests/weixin/incident-coordinator.test.ts tests/weixin/account-store.test.ts tests/weixin/delivery-adapter.test.ts tests/chat/owner-route-store.test.ts tests/production-app.test.ts tests/production-startup.test.ts tests/app.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/weixin/chat-adapter.ts src/weixin/incident-coordinator.ts src/weixin/account-store.ts src/weixin/delivery-adapter.ts src/chat/owner-route-store.ts src/production-app.ts tests/weixin/chat-adapter.test.ts tests/weixin/incident-coordinator.test.ts tests/weixin/account-store.test.ts tests/weixin/delivery-adapter.test.ts tests/chat/owner-route-store.test.ts tests/production-app.test.ts tests/production-startup.test.ts
git commit -m "feat: run WeChat alongside existing adapters"
```

### Task 15: Prove cross-adapter behavior and generic tools

**Files:**
- Create: `tests/integration/weixin.test.ts`
- Modify: `tests/integration/multi-chat.test.ts`
- Modify: `tests/assistant/tools.test.ts`
- Modify: `tests/chat/adapter-registry.test.ts`

- [ ] **Step 1: Write failing integration tests**

Exercise WeChat-only startup, all three adapters with required primary, active WeChat steering, Telegram/Slack losing queue notices, later continuation from another app, immutable reply routing, generic message/image/file tools through WeChat, unsupported WeChat history, no WeChat-specific MCP tool, restart cursor recovery, and old-generation delivery fencing.

```ts
await harness.receiveWeixin(ownerText("continue the novel"));
await harness.receiveTelegram("what is its status?");
assert.deepEqual(harness.telegramMessages.at(-1)?.body, "[system] queued");
assert.throws(() => registry.getHistory(weixinBinding, { scope: "conversation", count: 10 }), /UNSUPPORTED_CAPABILITY/);
```

- [ ] **Step 2: Run tests to verify integration gaps**

Run: `npm test -- tests/integration/weixin.test.ts tests/integration/multi-chat.test.ts tests/assistant/tools.test.ts tests/chat/adapter-registry.test.ts`

Expected: FAIL until all composition/tool paths use the third adapter.

- [ ] **Step 3: Build the integrated fake-transport harness**

Construct all three fake adapters through the production composition seam, drive their canonical sources through the real conversation dispatcher, and capture deliveries through the real registry. Do not add WeChat history/search tools or adapter-ID branches to assistant code; routing stays through `ConversationBinding` and `ChatAdapterRegistry`.

```ts
const adapters: ChatAdapter[] = [
  ...(telegram ? [telegram] : []),
  ...(slack ? [slack] : []),
  ...(weixin ? [weixin] : []),
];
```

- [ ] **Step 4: Run integration tests**

Run: `npm test -- tests/integration/weixin.test.ts tests/integration/multi-chat.test.ts tests/assistant/tools.test.ts tests/chat/adapter-registry.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add tests/integration/weixin.test.ts tests/integration/multi-chat.test.ts tests/assistant/tools.test.ts tests/chat/adapter-registry.test.ts
git commit -m "test: verify cross-app personal WeChat behavior"
```

### Task 16: Document and package the supported personal-WeChat release

**Files:**
- Modify: `package.json`
- Modify: `docs/chat-apps/wechat.md`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docs/setup.md`
- Modify: `docs/installation.md`
- Modify: `docs/upgrading-to-v0.3.md`
- Modify: `tests/docs.test.ts`
- Modify: `tests/rename-contract.test.ts`
- Modify: `tests/distribution/package-info.test.ts`
- Modify: `tests/distribution/release-workflow.test.ts`
- Create: `tests/integration/weixin-live.test.ts`

- [ ] **Step 1: Write failing docs/package/live-harness tests**

Require login/setup/restart/relogin, primary examples, supported text/image/file/voice transcription, explicit group/raw voice/raw video/history limitations, credential backup/revocation cautions, endpoint/QR/attachment/poll troubleshooting, Tencent credit+revision, no endorsement claim, runtime-only package, bundled dependencies, clean-prefix `--version` and `config-check`, and an opt-in redacted live test. Remove every Telegram/Slack-only implementation or `PRIMARY_CHAT_APP` claim from setup/installation docs, and extend upgrade backup/secret-unset guidance for the managed credential file without suggesting environment tokens. The live result schema must assert distinct authorization identities without exposing them; inbound and outbound text/image/file; voice transcription; unsupported video; unauthorized-user discard; cross-adapter continuation; stop/restart cursor recovery; prohibited token, QR, verification, context-token, signed-query, ID, body, and attachment-content leak classes; and UTF-8 text just below, at, and above 4,000 bytes.

```ts
assert.match(wechatGuide, /qiyan-bot weixin-login/);
assert.match(wechatGuide, /cef0bfc390393f716903e16d50408118047f87e0/);
assert.doesNotMatch(wechatGuide, /groups are supported/i);
assert.equal(packagedPaths.includes("package/docs/chat-apps/wechat.md"), true);
assert.equal(packagedPaths.some((path) => path.includes("openclaw")), false);
```

- [ ] **Step 2: Run tests to verify documentation/package failure**

Run: `npm test -- tests/docs.test.ts tests/rename-contract.test.ts tests/distribution/package-info.test.ts tests/distribution/release-workflow.test.ts tests/integration/weixin-live.test.ts`

Expected: FAIL because the guide/package assertions and live harness are absent.

- [ ] **Step 3: Write final documentation and opt-in live harness**

Add `docs/chat-apps/wechat.md` to the exact npm `files` allowlist. The live test must skip unless `QIYAN_WEIXIN_LIVE=1`, use the normal credential store rather than environment secrets, record only IDs/counts/states/timings, and assert redaction. It must never commit credentials, owner IDs, message bodies, or attachment contents.

```ts
test("live personal WeChat owner round trip", { skip: process.env.QIYAN_WEIXIN_LIVE !== "1" }, async () => {
  const result = await runRedactedWeixinAcceptance();
  assert.equal(result.authorizationIdentitiesDistinct, true);
  assert.deepEqual(result.inboundKinds, ["text", "image", "file", "voice_transcription", "unsupported_video"]);
  assert.deepEqual(result.outboundKinds, ["text_3999", "text_4000", "text_4001", "image", "file"]);
  assert.equal(result.unauthorizedInputCount, 0);
  assert.equal(result.crossAdapterContinuation, true);
  assert.equal(result.restartCursorRecovered, true);
  assert.equal(result.duplicateAssistantInputs, 0);
  assert.equal(result.secretLeakCount, 0);
});
```

- [ ] **Step 4: Run docs, package, and full verification**

Run: `npm test -- tests/docs.test.ts tests/rename-contract.test.ts tests/distribution/package-info.test.ts tests/distribution/release-workflow.test.ts tests/integration/weixin-live.test.ts`

Expected: PASS with the live test skipped by default.

Run: `npm run check`

Expected: typecheck succeeds; every non-live test passes; only documented opt-in integration tests are skipped.

Run: `npm pack --dry-run`

Expected: package contains the compiled executable and documented runtime assets only, with no credentials, source tree, temp fixtures, or OpenClaw runtime.

- [ ] **Step 5: Commit**

```bash
npm run check
git add package.json docs/chat-apps/wechat.md README.md .env.example docs/setup.md docs/installation.md docs/upgrading-to-v0.3.md tests/docs.test.ts tests/rename-contract.test.ts tests/distribution/package-info.test.ts tests/distribution/release-workflow.test.ts tests/integration/weixin-live.test.ts
git commit -m "docs: publish personal WeChat setup and acceptance"
```

### Task 17: Final security, protocol, and recovery verification

**Files:**
- Modify only files required by concrete review findings.

- [ ] **Step 1: Run static secret and scope audits**

Run: `rg -n "console\.|process\.(stdout|stderr)|Authorization|context_token|encrypt_query_param|verification" src/weixin tests/weixin`

Expected: every production output site is category-only; bearer/context/signed values occur only in request construction or redaction tests.

Run: `rg -n -i "openclaw|group support|raw voice|raw video|wechat history|weixin history" src package.json README.md docs`

Expected: OpenClaw appears only in provenance/credit text; deferred capabilities are not claimed as implemented.

- [ ] **Step 2: Run all WeChat and adjacent recovery tests together**

Run: `npm test -- tests/weixin tests/storage/weixin-schema.test.ts tests/chat/delivery-worker.test.ts tests/attachments/store.test.ts tests/integration/weixin.test.ts tests/integration/multi-chat.test.ts tests/production-app.test.ts`

Expected: PASS.

- [ ] **Step 3: Run the complete repository gate from a clean process**

Run: `npm run check`

Expected: PASS with zero failures.

- [ ] **Step 4: Build and inspect the distributable**

Run: `npm run build`

Expected: PASS and `dist/qiyan-bot` is executable.

Run: `env -i HOME="$HOME" PATH="$PATH" ./dist/qiyan-bot --version`

Expected: prints the package version without loading credentials or starting App Servers.

- [ ] **Step 5: Commit only evidence-driven fixes**

If review or verification required code changes, stage only those named files, rerun their targeted tests and `npm run check`, then commit with a message describing the concrete fix. If no files changed, do not create an empty commit.

## Live acceptance handoff

Do not restart the running QiYan service during implementation. After all automated checks and independent reviews pass, give the user these explicit manual gates:

1. Run `qiyan-bot weixin-login --home ~/.qiyan-bot` in an interactive terminal and scan the QR with the intended personal WeChat owner.
2. Restart the service through the repository-documented operational procedure.
3. Run `QIYAN_WEIXIN_LIVE=1 npm test -- tests/integration/weixin-live.test.ts` while following its redacted prompts.
4. Confirm text, image, generic file, voice transcription, unsupported video, unauthorized-user ignore, cross-app continuation, restart cursor recovery, and log/status redaction.
