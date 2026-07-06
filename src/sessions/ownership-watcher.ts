import { AppError } from "../core/errors.ts";
import type { EndpointWorkLease } from "../endpoints/types.ts";
import type { MappingIdentity, SessionRegistry } from "../registry/session-registry.ts";
import type { OwnershipInspection } from "./rollout-ownership.ts";

interface OwnershipInspector {
  inspect(identity: MappingIdentity, lease?: EndpointWorkLease): Promise<OwnershipInspection>;
}

interface SessionUnadopter {
  unadopt(nickname: string): Promise<void>;
}

interface OwnershipGate {
  run<T>(endpointId: string, threadId: string, operation: () => Promise<T>): Promise<T>;
}

export interface ExternalTurnIncident extends MappingIdentity {
  nickname: string;
  turnId: string;
}

export type ExternalOwnershipReleaseStatus = "pending" | "completed";

export function externalOwnershipEventPayload(
  incident: ExternalTurnIncident,
  releaseStatus: ExternalOwnershipReleaseStatus,
): {
  event: "external_worker_turn_detected" | "external_worker_session_released";
  releaseStatus: ExternalOwnershipReleaseStatus;
  nickname: string;
  mappingId: string;
  turnId: string;
} {
  return {
    event: releaseStatus === "pending" ? "external_worker_turn_detected" : "external_worker_session_released",
    releaseStatus,
    nickname: incident.nickname,
    mappingId: incident.mapping_id,
    turnId: incident.turnId,
  };
}

export class SessionOwnershipWatcher {
  constructor(
    private readonly registry: SessionRegistry,
    private readonly ownership: OwnershipInspector,
    private readonly lifecycle: SessionUnadopter,
    private readonly options: {
      onExternal(incident: ExternalTurnIncident): void | Promise<void>;
      onReleased(incident: ExternalTurnIncident): void | Promise<void>;
      isInspectable?(identity: MappingIdentity): boolean;
    },
    private readonly gate?: OwnershipGate,
  ) {}

  async reconcileEndpoint(endpointId: string, lease?: EndpointWorkLease): Promise<void> {
    await this.release(await this.detectEndpoint(endpointId, lease));
  }

  async detectEndpoint(endpointId: string, lease?: EndpointWorkLease): Promise<ExternalTurnIncident[]> {
    const incidents: ExternalTurnIncident[] = [];
    const sessions = Object.entries(this.registry.snapshot().sessions)
      .filter(([, session]) => session.endpoint === endpointId && session.lifecycle_state === "managed");
    for (const [nickname, session] of sessions) {
      if (this.options.isInspectable && !this.options.isInspectable(session)) continue;
      const inspect = () => this.ownership.inspect(session, lease);
      const result = this.gate
        ? await this.gate.run(session.endpoint, session.thread_id, inspect)
        : await inspect();
      if (result.state !== "external") continue;
      await this.options.onExternal({
        nickname,
        endpoint: session.endpoint,
        thread_id: session.thread_id,
        mapping_id: session.mapping_id,
        turnId: result.turnId,
      });
      incidents.push({
        nickname,
        endpoint: session.endpoint,
        thread_id: session.thread_id,
        mapping_id: session.mapping_id,
        turnId: result.turnId,
      });
    }
    return incidents;
  }

  async release(incidents: readonly ExternalTurnIncident[]): Promise<void> {
    const seen = new Set<string>();
    for (const incident of incidents) {
      const key = `${incident.endpoint}\0${incident.thread_id}\0${incident.mapping_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const current = this.registry.get(incident.nickname);
      if (!current || current.endpoint !== incident.endpoint || current.thread_id !== incident.thread_id
        || current.mapping_id !== incident.mapping_id || current.lifecycle_state !== "managed") continue;
      try {
        await this.lifecycle.unadopt(incident.nickname);
        await this.options.onReleased(incident);
      } catch (error) {
        if (error instanceof AppError && error.code === "SESSION_BUSY") continue;
        throw error;
      }
    }
  }
}
