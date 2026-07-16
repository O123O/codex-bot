export type WorkerGoalAction = "set" | "pause" | "resume" | "cancel";

export type WorkerCommand =
  | { kind: "goal"; action: "set"; objective: string }
  | { kind: "goal"; action: Exclude<WorkerGoalAction, "set"> }
  | { kind: "help" }
  | { kind: "error"; message: string };

export const WORKER_GOAL_HELP = [
  "/goal <objective> — set or replace",
  "/goal pause · /goal resume · /goal cancel",
  "/goal set <objective> — explicit form for reserved words",
].join("\n");

// Own only QiYan's /goal namespace. Every other slash command remains native worker input.
export function parseWorkerCommand(text: string): WorkerCommand | null {
  const value = text.trim();
  if (!/^\/goal(?:\s|$)/u.test(value)) return null;
  const rest = value.slice("/goal".length).trim();
  if (!rest || rest === "help") return { kind: "help" };
  if (rest === "pause" || rest === "resume" || rest === "cancel") return { kind: "goal", action: rest };
  if (rest === "set") return { kind: "error", message: "goal objective is required" };
  if (/^set\s/u.test(rest)) {
    const objective = rest.slice("set".length).trim();
    return objective ? { kind: "goal", action: "set", objective } : { kind: "error", message: "goal objective is required" };
  }
  return { kind: "goal", action: "set", objective: rest };
}
