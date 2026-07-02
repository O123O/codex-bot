import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { AssistantLoginConfig } from "../config.ts";
import { AppError } from "../core/errors.ts";
import { buildAssistantChildEnvironment, prepareAssistantProfile } from "./profile.ts";

type LoginSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export async function runAssistantLogin(
  config: AssistantLoginConfig,
  host: NodeJS.ProcessEnv = process.env,
  spawn: LoginSpawn = nodeSpawn,
): Promise<void> {
  const profile = await prepareAssistantProfile(config.dataDir);
  await profile.assertIntact();
  const child = spawn(config.codexBinary, ["login", "--device-auth"], {
    env: buildAssistantChildEnvironment(host, profile),
    stdio: "inherit",
  });
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (outcome.code !== 0) {
    throw new AppError("CONFIGURATION_ERROR", outcome.signal
      ? `assistant login exited from signal ${outcome.signal}`
      : `assistant login exited with status ${String(outcome.code)}`);
  }
}
