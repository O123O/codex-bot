import { readFile } from "node:fs/promises";

export interface LinuxProcessIdentity {
  pid: number;
  startTime: string;
}

export async function readLinuxProcessIdentity(pid: number): Promise<LinuxProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("invalid Linux process id");
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const close = stat.lastIndexOf(")");
  const fields = close >= 0 ? stat.slice(close + 1).trim().split(/\s+/u) : [];
  const startTime = fields[19];
  if (!startTime || !/^\d+$/u.test(startTime)) throw new Error("invalid Linux process identity");
  return { pid, startTime };
}
