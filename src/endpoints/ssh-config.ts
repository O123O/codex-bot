import { createHash } from "node:crypto";
import { join } from "node:path";
import { AppError } from "../core/errors.ts";
import type { SshDestination } from "./binding-store.ts";

export interface EffectiveSshConfig extends SshDestination {
  controlMaster: string;
  controlPath?: string;
}

export interface SshConnectionPlan {
  alias: string;
  destination: SshDestination;
  commonArgs: readonly string[];
  controlPath?: string;
  ownsControlMaster: boolean;
}

export function parseSshConfig(output: string): EffectiveSshConfig {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    const index = line.indexOf(" ");
    if (index <= 0) continue;
    values.set(line.slice(0, index).toLowerCase(), line.slice(index + 1).trim());
  }
  const hostname = values.get("hostname");
  const user = values.get("user");
  const port = Number(values.get("port"));
  if (!hostname) throw new AppError("CONFIGURATION_ERROR", "effective SSH hostname is missing");
  if (!user) throw new AppError("CONFIGURATION_ERROR", "effective SSH user is missing");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new AppError("CONFIGURATION_ERROR", "effective SSH port is invalid");
  const controlPath = values.get("controlpath");
  return {
    hostname,
    user,
    port,
    controlMaster: values.get("controlmaster")?.toLowerCase() ?? "no",
    ...(controlPath && controlPath !== "none" ? { controlPath } : {}),
  };
}

export function planSshConnection(alias: string, effective: EffectiveSshConfig, runtimeDir: string): SshConnectionPlan {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(alias)) throw new AppError("CONFIGURATION_ERROR", "invalid SSH endpoint alias");
  const userMaster = effective.controlPath !== undefined && effective.controlMaster !== "no";
  const ownedPath = join(runtimeDir, "ssh", createHash("sha256").update(`${alias}\0${effective.hostname}\0${effective.user}\0${effective.port}`).digest("hex").slice(0, 24));
  if (!userMaster && Buffer.byteLength(ownedPath) > 100) throw new AppError("CONFIGURATION_ERROR", "QiYan SSH control path is too long");
  return {
    alias,
    destination: { hostname: effective.hostname, user: effective.user, port: effective.port },
    commonArgs: [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
    ],
    controlPath: userMaster ? effective.controlPath! : ownedPath,
    ownsControlMaster: !userMaster,
  };
}

export function buildSshArgs(plan: SshConnectionPlan, operationArgs: readonly string[]): string[] {
  const pinned = ["-o", `HostName=${plan.destination.hostname}`, "-l", plan.destination.user, "-p", String(plan.destination.port)];
  const control = plan.ownsControlMaster
    ? ["-S", plan.controlPath!, "-o", "ControlMaster=auto", "-o", "ControlPersist=60"]
    : [];
  return [...plan.commonArgs, ...pinned, ...control, ...operationArgs, plan.alias];
}
