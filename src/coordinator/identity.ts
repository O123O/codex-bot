import { realpath } from "node:fs/promises";
import { AppError } from "../core/errors.ts";
import type { SessionRegistry } from "../registry/session-registry.ts";

interface CoordinatorEndpoint {
  id: string;
  request<T>(method: string, params: unknown): Promise<T>;
}

interface ThreadResponse {
  thread: { id: string; cwd: string; status?: { type?: string } };
}

export async function resumeCoordinatorIdentity(input: {
  registry: SessionRegistry;
  endpoint: CoordinatorEndpoint;
  legacyEndpointId: string;
  coordinatorDir: string;
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  config: Record<string, unknown>;
}): Promise<{ threadId: string; nativeStatus: string }> {
  const identity = input.registry.snapshot().coordinator;
  if (identity.endpoint !== input.endpoint.id && identity.endpoint !== input.legacyEndpointId) {
    throw new AppError("CONFIGURATION_ERROR", "the coordinator registry entry uses an unknown endpoint");
  }
  const configuredDir = await realpath(input.coordinatorDir);
  if (!await sameDirectory(identity.project_dir, configuredDir)) {
    throw new AppError("CONFIGURATION_ERROR", `the coordinator registry does not match configured workdir ${configuredDir}`);
  }
  const response = identity.thread_id === "pending"
    ? await input.endpoint.request<ThreadResponse>("thread/start", { cwd: input.coordinatorDir, approvalPolicy: "never", sandbox: input.sandboxMode, config: input.config, ephemeral: false })
    : await input.endpoint.request<ThreadResponse>("thread/resume", { threadId: identity.thread_id, cwd: input.coordinatorDir, approvalPolicy: "never", sandbox: input.sandboxMode, config: input.config });
  const threadId = String(response.thread.id);
  if (identity.thread_id !== "pending" && threadId !== identity.thread_id) throw new AppError("CONFIGURATION_ERROR", "coordinator resume returned a different thread identity");
  if (!await sameDirectory(response.thread.cwd, configuredDir)) throw new AppError("CONFIGURATION_ERROR", `coordinator app-server did not use configured working directory ${configuredDir}`);
  await input.registry.setCoordinator({ endpoint: input.endpoint.id, thread_id: threadId, project_dir: input.coordinatorDir });
  return { threadId, nativeStatus: response.thread.status?.type ?? "idle" };
}

async function sameDirectory(candidate: string, expected: string): Promise<boolean> {
  try { return await realpath(candidate) === expected; }
  catch { return false; }
}
