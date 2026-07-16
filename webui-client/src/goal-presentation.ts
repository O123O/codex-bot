export interface WorkerGoal {
  objective: string;
  status: string;
}

export function selectedWorkerGoal(
  sessions: readonly { nickname: string; goal: WorkerGoal | null }[],
  selected: string | null,
): WorkerGoal | null {
  if (selected === null) return null;
  return sessions.find((session) => session.nickname === selected)?.goal ?? null;
}

export function formatGoalStatus(status: string): string {
  return status.replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase();
}
