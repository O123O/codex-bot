import { randomBytes } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AttachmentStore } from "./attachments/store.ts";
import { LocalEndpoint } from "./app-server/local-endpoint.ts";
import { AppServerPool } from "./app-server/pool.ts";
import { SUPPORTED_CODEX_VERSION } from "./app-server/protocol.ts";
import { composeApp, TerminalInbox, type AppPhase, type BotApp } from "./app.ts";
import type { BotConfig } from "./config.ts";
import { CoordinatorNotebook } from "./coordinator/notebook.ts";
import { CoordinatorRuntime } from "./coordinator/runtime.ts";
import { CoordinatorScheduler, type CoordinatorJob } from "./coordinator/scheduler.ts";
import { createCoordinatorTools, type CoordinatorToolName } from "./coordinator/tools.ts";
import { EventRelay } from "./events/relay.ts";
import { buildCodexChildEnvironment, coordinatorTurnConfig, LoopbackMcpServer } from "./mcp/server.ts";
import { SessionRegistry, type RegistryDocument } from "./registry/session-registry.ts";
import { SessionDiscovery } from "./sessions/discovery.ts";
import { FinalMessageStore } from "./sessions/final-messages.ts";
import { SessionLifecycle } from "./sessions/lifecycle.ts";
import { SessionService } from "./sessions/service.ts";
import { openDatabase, type Database } from "./storage/database.ts";
import { DeliveryStore } from "./storage/delivery-store.ts";
import { OperationStore } from "./storage/operation-store.ts";
import { RuntimeStore } from "./storage/runtime-store.ts";
import { TelegramApi } from "./telegram/api.ts";
import { DeliveryWorker } from "./telegram/delivery-worker.ts";
import { TelegramPoller } from "./telegram/poller.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function buildProductionApp(config: BotConfig): Promise<BotApp> {
  const coordinatorDir = join(repositoryRoot, "coordinator");
  const notebookPath = join(coordinatorDir, "session-status.json");
  const notebookExample = join(coordinatorDir, "session-status.example.json");
  const token = randomBytes(32).toString("base64url");

  let db!: Database;
  let registry!: SessionRegistry;
  let notebook!: CoordinatorNotebook;
  let attachments!: AttachmentStore;
  let operations!: OperationStore;
  let deliveries!: DeliveryStore;
  let runtime!: RuntimeStore;
  let finals!: FinalMessageStore;
  let endpoint!: LocalEndpoint;
  let pool!: AppServerPool;
  let discovery!: SessionDiscovery;
  let lifecycle!: SessionLifecycle;
  let sessions!: SessionService;
  let relay!: EventRelay;
  let coordinator!: CoordinatorRuntime;
  let scheduler!: CoordinatorScheduler;
  let mcp!: LoopbackMcpServer;
  let api!: TelegramApi;
  let poller!: TelegramPoller;
  let deliveryWorker!: DeliveryWorker;
  let acceptingReadyEvents = false;
  const unsubscribers: Array<() => void> = [];
  const terminalWaiters = new Map<string, { resolve(): void; reject(error: unknown): void; eventIds: string[] }>();
  const earlyCoordinatorTerminals = new TerminalInbox<any>();
  const enqueuedEvents = new Set<string>();
  const enqueuedSources = new Set<string>();
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let endpointIncident = 0;
  let stopping = false;
  let registryInvalid = false;

  const phases: AppPhase[] = [
    {
      name: "storage",
      start: async () => {
        await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
        await mkdir(coordinatorDir, { recursive: true, mode: 0o700 });
        db = openDatabase(join(config.dataDir, "bot.sqlite3"));
        operations = new OperationStore(db); deliveries = new DeliveryStore(db); runtime = new RuntimeStore(db); finals = new FinalMessageStore(db);
      },
      stop: async () => { db.close(); },
    },
    {
      name: "registry",
      start: async () => {
        registry = await SessionRegistry.open(config.sessionRegistryPath, {
          version: 1,
          coordinator: { endpoint: "local", thread_id: "pending", project_dir: coordinatorDir },
          sessions: {},
        });
        notebook = await CoordinatorNotebook.bootstrap(notebookPath, notebookExample);
      }, stop: async () => undefined,
    },
    {
      name: "attachments",
      start: async () => {
        attachments = new AttachmentStore(db, join(config.dataDir, "attachments"), { maxFileBytes: config.attachmentMaxBytes, maxStoreBytes: config.attachmentStoreMaxBytes });
        await attachments.initialize();
      }, stop: async () => undefined,
    },
    {
      name: "mcp",
      start: async () => {
        coordinator = new CoordinatorRuntime(db, operations, deliveries, { destination: String(config.telegramDestinationChatId) });
        const actions = buildActions();
        const tools = createCoordinatorTools(operations, actions, { maxCollectCount: config.maxCollectCount });
        mcp = new LoopbackMcpServer(tools, { current: () => coordinator.current() }, { host: config.mcpHost, port: config.mcpPort, token });
        await mcp.start();
      }, stop: async () => { await mcp.stop(); },
    },
    {
      name: "subscriptions",
      start: async () => {
        endpoint = new LocalEndpoint({ codexBinary: config.codexBinary, env: buildCodexChildEnvironment(process.env, token), expectedVersion: SUPPORTED_CODEX_VERSION });
        pool = new AppServerPool([endpoint], { maxConcurrentTurns: config.maxConcurrentTurns });
        discovery = new SessionDiscovery(db, pool);
        lifecycle = new SessionLifecycle(pool, registry, runtime, { now: () => Date.now() }, { sandboxMode: config.sandboxMode });
        sessions = new SessionService(pool, registry, runtime, finals, deliveries);
        relay = new EventRelay(db, pool, registry, runtime, finals, deliveries, { destination: String(config.telegramDestinationChatId), clock: { now: () => Date.now() } });
        scheduler = new CoordinatorScheduler(runCoordinatorJob);
        unsubscribers.push(endpoint.onNotification((method, params) => void onNotification(method, params)));
        unsubscribers.push(endpoint.onPermissionBlocked((event) => void relay.handlePermissionBlocked(endpoint.id, event)));
        unsubscribers.push(endpoint.onReady(() => { if (acceptingReadyEvents) void relay.reconcileEndpoint(endpoint.id); }));
        unsubscribers.push(endpoint.onUnavailable(() => void handleEndpointUnavailable()));
      }, stop: async () => { for (const unsubscribe of unsubscribers.splice(0)) unsubscribe(); },
    },
    {
      name: "endpoint",
      start: async () => { stopping = false; await endpoint.start(); },
      stop: async () => { stopping = true; if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = undefined; await endpoint.stop(); },
    },
    {
      name: "reconciliation",
      start: async () => {
        await lifecycle.reconcileStartup();
        await resumeManagedSessions();
        await relay.reconcileEndpoint(endpoint.id);
        deliveries.recoverAfterCrash();
        acceptingReadyEvents = true;
      }, stop: async () => { acceptingReadyEvents = false; },
    },
    {
      name: "coordinator",
      start: async () => {
        await startOrResumeCoordinator();
        await reconcileCoordinatorAttempts();
      }, stop: async () => undefined,
    },
    {
      name: "scheduler",
      start: async () => { await enqueuePendingEvents(); await enqueuePendingSources(); },
      stop: async () => {
        stopping = true;
        const active = coordinator.current();
        if (active && !active.turnId.startsWith("pending:")) await pool.interrupt(endpoint.id, registry.snapshot().coordinator.thread_id, active.turnId).catch(() => undefined);
        for (const [turnId, waiter] of terminalWaiters) {
          terminalWaiters.delete(turnId);
          waiter.reject(new Error("bot is stopping"));
        }
        await scheduler.idle();
      },
    },
    {
      name: "delivery",
      start: async () => { api = new TelegramApi(config.telegramBotToken); deliveryWorker = new DeliveryWorker(deliveries, api, attachments); deliveryWorker.start(); },
      stop: async () => { deliveryWorker.stop(); },
    },
    { name: "maintenance", start: async () => undefined, stop: async () => undefined },
    {
      name: "polling",
      start: async () => {
        poller = new TelegramPoller(db, api, operations, attachments, {
          ownerId: config.telegramOwnerId,
          maxMessageBytes: config.attachmentMaxBytes,
          onAccepted: async (contextId) => { enqueueSource(contextId); },
        });
        poller.start();
      }, stop: async () => { await poller.stop(); },
    },
  ];

  function buildActions(): Partial<Record<CoordinatorToolName, (args: any, context: any) => Promise<any>>> {
    return {
      list_managed_sessions: async () => registry.snapshot(),
      discover_sessions: async (args) => discovery.list({ endpointId: args.endpoint ?? "local", ...(args.search ? { search: args.search } : {}), ...(args.cwd ? { cwd: args.cwd } : {}), ...(args.limit ? { limit: args.limit } : {}), ...(args.cursor ? { cursor: args.cursor } : {}) }),
      get_session_status: async (args) => sessions.status(args.nickname),
      create_session: async (args) => { await lifecycle.create(args.nickname, args.endpoint ?? "local", args.project_dir); return { nickname: args.nickname }; },
      register_session: async (args) => { await lifecycle.register(args.nickname, args.endpoint ?? "local", args.thread_id, args.project_dir); return { nickname: args.nickname }; },
      adopt_session: async (args) => {
        const endpointId = args.endpoint ?? "local";
        const projectDir = args.project_dir ?? String((await pool.request<any>(endpointId, "thread/read", { threadId: args.thread_id, includeTurns: false })).thread.cwd);
        await lifecycle.adopt(args.nickname, endpointId, args.thread_id, projectDir); return { nickname: args.nickname };
      },
      rename_session: async (args) => { await registry.rename(args.old_nickname, args.new_nickname); await reconcileNotebook(); return { nickname: args.new_nickname }; },
      detach_session: async (args) => { await lifecycle.detach(args.nickname); return { nickname: args.nickname }; },
      attach_session: async (args) => { await lifecycle.attach(args.nickname); return { nickname: args.nickname }; },
      archive_session: async (args) => { await lifecycle.archive(args.nickname); return { nickname: args.nickname }; },
      send_to_session: async (args, context) => {
        const files = args.attachment_ids.map((id: any) => attachments.toUserInput(context.sourceContextId, id));
        const input = [...(args.content.length > 0 ? [{ type: "text", text: args.content, text_elements: [] }] : []), ...files];
        return sessions.send(args.nickname, args.content, { mode: args.mode, clientUserMessageId: `${context.sourceContextId}:${context.callId}`, input });
      },
      read_worker_message: async (args) => {
        const session = registry.get(args.nickname);
        if (!session) throw new Error(`unknown session: ${args.nickname}`);
        const message = finals.getById(args.message_id);
        if (!message || message.endpointId !== session.endpoint || message.threadId !== session.thread_id) throw new Error("worker message does not belong to that nickname");
        return message;
      },
      collect_messages: async (args, context) => args.direct
        ? sessions.collect(args.nickname, args.count, { direct: true, destination: String(config.telegramDestinationChatId), deliveryKey: context.sourceContextId })
        : sessions.collect(args.nickname, args.count),
      interrupt_session: async (args) => { await sessions.interrupt(args.nickname, args.turn_id); return { interrupted: true }; },
      list_models: async (args) => sessions.models(args.endpoint ?? "local"),
      set_session_model: async (args) => { await sessions.setModel(args.nickname, args.model); return { pending: true }; },
      set_reasoning_effort: async (args) => { await sessions.setEffort(args.nickname, args.effort); return { pending: true }; },
      get_goal: async (args) => sessions.getGoal(args.nickname),
      set_goal: async (args) => sessions.setGoal(args.nickname, args.objective, args.token_budget),
      pause_goal: async (args) => sessions.pauseGoal(args.nickname), resume_goal: async (args) => sessions.resumeGoal(args.nickname),
      cancel_goal: async (args) => { if (args.interrupt_active_turn) await sessions.interrupt(args.nickname).catch(() => undefined); return sessions.cancelGoal(args.nickname); },
      send_chat_message: async (args) => ({ deliveryId: deliveries.prepare({ kind: "chat", destination: String(config.telegramDestinationChatId), body: args.content, mandatory: false, replyTo: args.reply_to }).id }),
      prepare_chat_attachment: async (args, context) => {
        const ownerRoot = args.owner === "coordinator" ? coordinatorDir : registry.get(args.owner)?.project_dir;
        if (!ownerRoot) throw new Error("unknown attachment owner");
        return attachments.prepareOutbound(context.sourceContextId, ownerRoot, args.relative_path);
      },
      send_chat_attachment: async (args, context) => {
        const attachment = attachments.toUserInput(context.sourceContextId, args.file_handle);
        void attachment;
        const delivery = deliveries.prepareAttachment({
          kind: "attachment", destination: String(config.telegramDestinationChatId), body: args.caption ?? "", mandatory: false,
          attachmentId: args.file_handle, attachmentScopeId: context.sourceContextId,
          replyTo: args.reply_to,
        });
        return { deliveryId: delivery.id };
      },
    };
  }

  async function reconcileNotebook(): Promise<void> {
    const map = new Map(Object.entries(registry.snapshot().sessions).map(([name, session]) => [session.thread_id, name]));
    await notebook.reconcileNicknames(map);
  }

  async function runCoordinatorJob(job: CoordinatorJob): Promise<void> {
    const isEventBatch = "events" in job;
    const eventIds = isEventBatch ? job.events.map((event) => event.id) : [];
    const contextId = isEventBatch ? `batch:${eventIds.join(",")}` : String((job.payload as any).contextId);
    if (isEventBatch && !operations.getSourceContext(contextId)) operations.createSourceContext({ id: contextId, kind: "event_batch", sourceId: job.id, rawText: JSON.stringify(job.payload), attachmentIds: [] });
    const source = operations.getSourceContext(contextId);
    if (!source) throw new Error(`missing source context ${contextId}`);
    const isInternal = source.kind !== "telegram";
    const identity = registry.snapshot().coordinator;
    const internalLabel = source.kind === "recovery" ? "Recovery metadata for a previous coordinator attempt" : "Project session event metadata";
    const input: any[] = [{ type: "text", text: isInternal ? `${internalLabel}:\n${source.rawText}` : source.rawText, text_elements: [] }];
    if (!isInternal) input.push(...source.attachmentIds.map((id) => attachments.toUserInput(contextId, id as any)));
    const attemptId = `attempt_${crypto.randomUUID()}`;
    coordinator.prepareAttempt(contextId, attemptId, isInternal ? "internal" : "user");
    try {
      const response = await pool.startTurn<any>(identity.endpoint, { threadId: identity.thread_id, clientUserMessageId: contextId, input });
      const turnId = String(response.turn.id);
      coordinator.bindTurn(attemptId, turnId);
      const terminal = new Promise<void>((resolvePromise, rejectPromise) => terminalWaiters.set(turnId, { resolve: resolvePromise, reject: rejectPromise, eventIds }));
      const early = earlyCoordinatorTerminals.take(turnId);
      if (early) await processCoordinatorTerminal(early);
      else if (isTerminalStatus(response.turn.status)) await processCoordinatorTerminal({ threadId: identity.thread_id, turn: response.turn });
      await terminal;
    } catch (error) {
      const active = coordinator.current();
      if (active?.attemptId === attemptId) terminalWaiters.delete(active.turnId);
      const recovery = active?.attemptId === attemptId ? coordinator.failAttempt(active.turnId, error) : undefined;
      await requeueFailedContext(contextId, eventIds, recovery);
    }
  }

  async function onNotification(method: string, params: any): Promise<void> {
    const identity = registry.snapshot().coordinator;
    if (method === "turn/completed" && params.threadId === identity.thread_id) {
      pool.markTurnTerminal(endpoint.id, identity.thread_id, params.turn.id);
      if (!terminalWaiters.has(params.turn.id)) earlyCoordinatorTerminals.publish(params.turn.id, params);
      else await processCoordinatorTerminal(params);
      return;
    }
    await relay.handleNotification(endpoint.id, method, params);
    await enqueuePendingEvents();
  }

  async function processCoordinatorTerminal(params: any): Promise<void> {
    const identity = registry.snapshot().coordinator;
    const history = await pool.request<any>(identity.endpoint, "thread/read", { threadId: identity.thread_id, includeTurns: true });
    const turn = history.thread.turns.find((candidate: any) => candidate.id === params.turn.id) ?? params.turn;
    const messages = finals.persistTerminalTurn(endpoint.id, identity.thread_id, turn, Date.now());
    const attempt = coordinator.contextForTurn(turn.id);
    let recovery: ReturnType<CoordinatorRuntime["failAttempt"]>;
    if (turn.status === "completed") {
      coordinator.handleTerminal(turn.id, messages.map((message) => message.body).join("\n") || undefined);
      if (attempt) {
        operations.setSourceState(attempt.contextId, "completed");
        enqueuedSources.delete(attempt.contextId);
      }
    } else {
      recovery = coordinator.failAttempt(turn.id, turn.error);
    }
    const waiter = terminalWaiters.get(turn.id);
    if (!waiter) {
      if (turn.status !== "completed" && attempt) await requeueFailedContext(attempt.contextId, [], recovery);
      return;
    }
    if (turn.status === "completed") completeEvents(waiter.eventIds);
    else if (attempt) await requeueFailedContext(attempt.contextId, waiter.eventIds, recovery);
    terminalWaiters.delete(turn.id); waiter.resolve();
  }

  async function enqueuePendingEvents(): Promise<void> {
    const rows = db.prepare("SELECT id, endpoint_id, thread_id, payload_json FROM events WHERE state = 'pending' ORDER BY created_at, id").all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const id = String(row.id); if (enqueuedEvents.has(id)) continue;
      enqueuedEvents.add(id);
      scheduler.enqueueEvent({ id, sessionKey: `${row.endpoint_id}:${row.thread_id}`, payload: JSON.parse(String(row.payload_json)) });
    }
  }

  async function enqueuePendingSources(): Promise<void> {
    for (const source of operations.listPendingSourceContexts(["telegram", "recovery"])) enqueueSource(source.id);
  }

  function enqueueSource(contextId: string): void {
    if (enqueuedSources.has(contextId)) return;
    enqueuedSources.add(contextId);
    scheduler.enqueueUser({ id: contextId, payload: { contextId } });
  }

  function completeEvents(eventIds: readonly string[]): void {
    if (eventIds.length === 0) return;
    const placeholders = eventIds.map(() => "?").join(",");
    db.prepare(`UPDATE events SET state = 'processed' WHERE id IN (${placeholders})`).run(...eventIds);
    for (const id of eventIds) enqueuedEvents.delete(id);
  }

  async function requeueFailedContext(contextId: string, eventIds: readonly string[], recovery: ReturnType<CoordinatorRuntime["failAttempt"]>): Promise<void> {
    enqueuedSources.delete(contextId);
    for (const id of eventIds) enqueuedEvents.delete(id);
    if (recovery) {
      if (eventIds.length > 0) {
        const placeholders = eventIds.map(() => "?").join(",");
        db.prepare(`UPDATE events SET state = 'superseded' WHERE id IN (${placeholders})`).run(...eventIds);
      }
      if (!stopping) enqueueSource(recovery.id);
      return;
    }
    operations.setSourceState(contextId, "pending");
    const retry = setTimeout(() => {
      if (stopping) return;
      if (eventIds.length > 0) void enqueuePendingEvents();
      else void enqueuePendingSources();
    }, 1_000);
    retry.unref?.();
  }

  function isTerminalStatus(status: unknown): boolean {
    return typeof status === "string" && new Set(["completed", "failed", "interrupted"]).has(status);
  }

  async function startOrResumeCoordinator(): Promise<void> {
    const identity = registry.snapshot().coordinator;
    const configOverride = coordinatorTurnConfig(mcp.url, token);
    const response = identity.thread_id === "pending"
      ? await endpoint.request<any>("thread/start", { cwd: coordinatorDir, approvalPolicy: "never", sandbox: config.sandboxMode, config: configOverride, ephemeral: false })
      : await endpoint.request<any>("thread/resume", { threadId: identity.thread_id, cwd: coordinatorDir, approvalPolicy: "never", sandbox: config.sandboxMode, config: configOverride });
    const threadId = String(response.thread.id);
    await registry.setCoordinator({ endpoint: endpoint.id, thread_id: threadId, project_dir: coordinatorDir });
    runtime.setSession(endpoint.id, threadId, "managed", response.thread.status?.type ?? "idle");
  }

  async function reconcileCoordinatorAttempts(): Promise<void> {
    const identity = registry.snapshot().coordinator;
    for (const attempt of coordinator.activeAttempts()) {
      if (attempt.turnId.startsWith("pending:")) {
        await requeueFailedContext(attempt.contextId, [], coordinator.failAttempt(attempt.turnId, "restart before turn binding"));
        continue;
      }
      let history = await pool.request<any>(identity.endpoint, "thread/read", { threadId: identity.thread_id, includeTurns: true });
      let turn = history.thread.turns.find((candidate: any) => candidate.id === attempt.turnId);
      if (!turn || !isTerminalStatus(turn.status)) {
        await pool.interrupt(identity.endpoint, identity.thread_id, attempt.turnId).catch(() => undefined);
        history = await pool.request<any>(identity.endpoint, "thread/read", { threadId: identity.thread_id, includeTurns: true });
        turn = history.thread.turns.find((candidate: any) => candidate.id === attempt.turnId);
      }
      if (turn && isTerminalStatus(turn.status)) await processCoordinatorTerminal({ threadId: identity.thread_id, turn });
      else await requeueFailedContext(attempt.contextId, [], coordinator.failAttempt(attempt.turnId, "restart reconciliation could not observe a terminal turn"));
    }
  }

  async function resumeManagedSessions(): Promise<void> {
    for (const [nickname, session] of Object.entries(registry.snapshot().sessions)) {
      if (session.endpoint !== endpoint.id) continue;
      const state = runtime.getSession(session.endpoint, session.thread_id);
      if (!state) {
        try {
          const response = await endpoint.request<any>("thread/read", { threadId: session.thread_id, includeTurns: false });
          await verifySessionCwd(response.thread.cwd, session.project_dir);
          runtime.setSession(session.endpoint, session.thread_id, "unavailable", response.thread.status?.type ?? "notLoaded");
        } catch {
          runtime.setSession(session.endpoint, session.thread_id, "unavailable", "notLoaded");
        }
        warnSessionUnavailable(nickname, session.endpoint, session.thread_id);
        continue;
      }
      if (state.managementState === "unavailable" && state.restoreState !== "managed") continue;
      if (state.managementState !== "managed" && state.managementState !== "unavailable") continue;
      try {
        const response = await endpoint.request<any>("thread/resume", {
          threadId: session.thread_id,
          cwd: session.project_dir,
          approvalPolicy: "never",
          sandbox: config.sandboxMode,
        });
        await verifySessionCwd(response.thread.cwd, session.project_dir);
        runtime.setSession(session.endpoint, session.thread_id, "managed", response.thread.status?.type ?? "idle");
      } catch {
        runtime.setSession(session.endpoint, session.thread_id, "unavailable", "notLoaded");
        warnSessionUnavailable(nickname, session.endpoint, session.thread_id);
      }
    }
  }

  async function handleEndpointUnavailable(): Promise<void> {
    if (stopping) return;
    endpointIncident += 1;
    acceptingReadyEvents = false;
    pool.markEndpointUnavailable(endpoint.id);
    for (const session of runtime.listSessions()) {
      if (session.endpointId === endpoint.id && session.managementState === "managed") {
        runtime.setSession(session.endpointId, session.threadId, "unavailable", "notLoaded");
      }
    }
    for (const [turnId, waiter] of terminalWaiters) {
      terminalWaiters.delete(turnId);
      waiter.reject(new Error("app-server became unavailable"));
    }
    const identity = registry.snapshot().coordinator;
    deliveries.prepare({
      id: `endpoint-unavailable:${endpoint.id}:${endpointIncident}`,
      kind: "system_warning",
      destination: String(config.telegramDestinationChatId),
      body: `[system] ${endpoint.id} app-server is unavailable; reconnecting`,
      mandatory: true,
    });
    db.prepare(`INSERT OR IGNORE INTO events(id, endpoint_id, thread_id, kind, payload_json, state, created_at)
      VALUES (?, ?, ?, 'endpoint_unavailable', ?, 'pending', ?)`)
      .run(`endpoint-unavailable:${endpoint.id}:${endpointIncident}`, endpoint.id, identity.thread_id, JSON.stringify({ endpointId: endpoint.id, status: "unavailable", incident: endpointIncident }), Date.now());
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (stopping || reconnectTimer) return;
    const delay = Math.min(1_000 * 2 ** reconnectAttempt, 30_000);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void recoverEndpoint().catch(() => scheduleReconnect());
    }, delay);
    reconnectTimer.unref?.();
  }

  async function recoverEndpoint(): Promise<void> {
    if (stopping) return;
    await endpoint.start();
    await resumeManagedSessions();
    await startOrResumeCoordinator();
    await relay.reconcileEndpoint(endpoint.id);
    acceptingReadyEvents = true;
    reconnectAttempt = 0;
    await enqueuePendingEvents();
    await enqueuePendingSources();
  }

  async function verifySessionCwd(actual: string, expected: string): Promise<void> {
    if (await realpath(actual) !== await realpath(expected)) throw new Error("registered project directory does not match thread cwd");
  }

  function warnSessionUnavailable(nickname: string, endpointId: string, threadId: string): void {
    deliveries.prepare({
      id: `session-unavailable:${endpointId}:${threadId}:${endpointIncident}`,
      kind: "worker_warning",
      destination: String(config.telegramDestinationChatId),
      body: `[${nickname}] unavailable; its registered thread and project directory require verification`,
      mandatory: true,
    });
  }

  return composeApp(phases, { maintenance: { intervalMs: 60_000, run: runMaintenance } });

  async function runMaintenance(): Promise<void> {
    await attachments.cleanupExpired();
    discovery.cleanupExpired();
    if (endpoint.state !== "ready") return;
    const accepted = await registry.reload(validateRegistryDocument);
    if (!accepted) {
      if (!registryInvalid) {
        deliveries.prepare({
          id: `registry-invalid:${Date.now()}`,
          kind: "system_warning",
          destination: String(config.telegramDestinationChatId),
          body: "[system] sessions.json replacement was rejected; the last valid registry remains active",
          mandatory: true,
        });
      }
      registryInvalid = true;
      return;
    }
    registryInvalid = false;
    await initializeNewRegistryMappings();
    await reconcileNotebook();
  }

  async function validateRegistryDocument(document: RegistryDocument): Promise<void> {
    const currentCoordinator = registry.snapshot().coordinator;
    if (document.coordinator.endpoint !== currentCoordinator.endpoint || document.coordinator.thread_id !== currentCoordinator.thread_id || document.coordinator.project_dir !== currentCoordinator.project_dir) {
      throw new Error("the live coordinator mapping cannot be externally repointed");
    }
    for (const session of Object.values(document.sessions)) {
      if (session.endpoint !== endpoint.id) throw new Error(`unknown endpoint: ${session.endpoint}`);
      const response = await endpoint.request<any>("thread/read", { threadId: session.thread_id, includeTurns: false });
      await verifySessionCwd(response.thread.cwd, session.project_dir);
    }
  }

  async function initializeNewRegistryMappings(): Promise<void> {
    for (const [nickname, session] of Object.entries(registry.snapshot().sessions)) {
      if (runtime.getSession(session.endpoint, session.thread_id)) continue;
      const response = await endpoint.request<any>("thread/read", { threadId: session.thread_id, includeTurns: false });
      runtime.setSession(session.endpoint, session.thread_id, "unavailable", response.thread.status?.type ?? "notLoaded");
      warnSessionUnavailable(nickname, session.endpoint, session.thread_id);
    }
  }
}
