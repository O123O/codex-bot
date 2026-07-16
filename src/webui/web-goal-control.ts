import type { AssistantToolName, ToolHandler } from "../assistant/tools.ts";
import { AppError } from "../core/errors.ts";
import type { OperationRecord, OperationStore } from "../storage/operation-store.ts";

export type WebGoalAction = "set" | "pause" | "resume" | "cancel";
export type WebGoalControlInput =
  | { requestId: string; nickname: string; action: "set"; objective: string }
  | { requestId: string; nickname: string; action: Exclude<WebGoalAction, "set"> };
export interface WebGoalControlResult { ok: boolean; error?: string }

export interface WebGoalControl {
  control(input: WebGoalControlInput): Promise<WebGoalControlResult>;
  openAdmission(): void;
  closeAdmission(): void;
  waitForActive(): Promise<void>;
  hasActiveAttempt(attemptId: string): boolean;
  repairAwareness(): number;
}

interface WebGoalControlDeps {
  operations: Pick<OperationStore,
    "createWebGoalIntent" | "findForCall" | "getSourceContext" | "listHeldSourceContexts" | "releaseHeldSourceContext">;
  tools: Readonly<Record<AssistantToolName, ToolHandler>>;
  wake(): void;
  requestReconciliation(attemptId: string): void;
}

const TOOL: Record<WebGoalAction, AssistantToolName> = {
  set: "set_goal", pause: "pause_goal", resume: "resume_goal", cancel: "cancel_goal",
};
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function canonical(input: WebGoalControlInput): string {
  return JSON.stringify({ nickname: input.nickname, action: input.action, ...(input.action === "set" ? { objective: input.objective } : {}) });
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function parseIntent(id: string, sourceId: string, rawText: string): WebGoalControlInput | undefined {
  const requestId = sourceId.startsWith("awareness:") ? sourceId.slice("awareness:".length) : "";
  if (!REQUEST_ID.test(requestId) || id !== `web-goal-awareness:${requestId}`) return undefined;
  let value: unknown;
  try { value = JSON.parse(rawText); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const command = value as Record<string, unknown>;
  const nickname = command.nickname;
  const action = command.action;
  if (typeof nickname !== "string" || (action !== "set" && action !== "pause" && action !== "resume" && action !== "cancel")) return undefined;
  if (action === "set") return typeof command.objective === "string"
    ? { requestId, nickname, action, objective: command.objective }
    : undefined;
  return { requestId, nickname, action };
}

function durableOutcome(operation: OperationRecord | undefined): string {
  if (operation?.state === "succeeded") return "succeeded";
  if (operation?.state === "failed") return "did not return success";
  if (operation?.state === "dispatched" || operation?.state === "uncertain") {
    return "is uncertain; durable backend recovery remains authoritative";
  }
  return "did not complete before dispatch was confirmed";
}

function awarenessText(input: WebGoalControlInput, operation: OperationRecord | undefined): string {
  const action = input.action === "set" ? `set worker "${input.nickname}"'s goal` : `${input.action} worker "${input.nickname}"'s goal`;
  const objective = input.action === "set" ? `\nObjective (quoted user data): ${input.objective}` : "";
  return `[web_goal awareness: the user directly asked the Web UI to ${action}; backend goal control ${durableOutcome(operation)}; for your awareness only — do not reply or repeat or repair the action]${objective}`;
}

export function createWebGoalControl(deps: WebGoalControlDeps): WebGoalControl {
  const activeAttempts = new Set<string>();
  const activeRequests = new Set<Promise<WebGoalControlResult>>();
  const inFlight = new Map<string, { command: string; promise: Promise<WebGoalControlResult> }>();
  let accepting = false;

  const repairAwareness = (): number => {
    let released = 0;
    for (const held of deps.operations.listHeldSourceContexts("web_goal")) {
      const input = parseIntent(held.id, held.sourceId, held.rawText);
      if (!input) throw new AppError("OPERATION_CONFLICT", "stored Web goal awareness intent is invalid");
      const attemptId = `web-goal:${input.requestId}`;
      if (activeAttempts.has(attemptId)) continue;
      const operation = deps.operations.findForCall(attemptId, "web-goal-control", TOOL[input.action]);
      const exact = operation?.contextId === `web-goal-operation:${input.requestId}` ? operation : undefined;
      if (deps.operations.releaseHeldSourceContext(held.id, awarenessText(input, exact))) {
        released += 1;
        deps.wake();
      }
    }
    return released;
  };

  const execute = async (input: WebGoalControlInput, command: string): Promise<WebGoalControlResult> => {
    const operationContextId = `web-goal-operation:${input.requestId}`;
    const awarenessContextId = `web-goal-awareness:${input.requestId}`;
    const accepted = deps.operations.createWebGoalIntent({
      operation: { id: operationContextId, kind: "web_goal", sourceId: `operation:${input.requestId}`, rawText: command, attachmentIds: [] },
      awareness: { id: awarenessContextId, kind: "web_goal", sourceId: `awareness:${input.requestId}`, rawText: command, attachmentIds: [] },
    });
    const stored = deps.operations.getSourceContext(operationContextId);
    if (!accepted || !stored || stored.kind !== "web_goal" || stored.sourceId !== `operation:${input.requestId}` || stored.rawText !== command) {
      return { ok: false, error: "request ID was already used for a different goal command" };
    }

    const attemptId = `web-goal:${input.requestId}`;
    activeAttempts.add(attemptId);
    let result: WebGoalControlResult;
    try {
      const args = input.action === "set"
        ? { nickname: input.nickname, objective: input.objective }
        : { nickname: input.nickname };
      await deps.tools[TOOL[input.action]]({ sourceContextId: operationContextId, attemptId, callId: "web-goal-control" }, args);
      result = { ok: true };
    } catch (error) {
      result = { ok: false, error: errorMessage(error) };
    } finally {
      activeAttempts.delete(attemptId);
    }

    try {
      repairAwareness();
    } catch (error) {
      const detail = `QiYan awareness copy is pending durable repair: ${errorMessage(error)}`;
      result = { ok: false, error: result.error ? `${result.error}; ${detail}` : `goal control succeeded, but ${detail}` };
    } finally {
      deps.requestReconciliation(attemptId);
    }
    return result;
  };

  const control = (input: WebGoalControlInput): Promise<WebGoalControlResult> => {
    if (!accepting) return Promise.resolve({ ok: false, error: "goal control is shutting down" });
    const command = canonical(input);
    const current = inFlight.get(input.requestId);
    if (current) return current.command === command
      ? current.promise
      : Promise.resolve({ ok: false, error: "request ID was already used for a different goal command" });
    const promise = execute(input, command).finally(() => {
      if (inFlight.get(input.requestId)?.promise === promise) inFlight.delete(input.requestId);
    });
    inFlight.set(input.requestId, { command, promise });
    activeRequests.add(promise);
    void promise.then(() => { activeRequests.delete(promise); }, () => { activeRequests.delete(promise); });
    return promise;
  };

  return {
    control,
    openAdmission: () => { accepting = true; },
    closeAdmission: () => { accepting = false; },
    waitForActive: async () => { await Promise.allSettled([...activeRequests]); },
    hasActiveAttempt: (attemptId) => activeAttempts.has(attemptId),
    repairAwareness,
  };
}
