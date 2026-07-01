import { z } from "zod";
import { AppError } from "./core/errors.ts";

export interface CliOptions { coordinatorWorkdir?: string }

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let coordinatorWorkdir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument !== "--workdir") throw new AppError("CONFIGURATION_ERROR", "unknown argument");
    if (coordinatorWorkdir !== undefined) throw new AppError("CONFIGURATION_ERROR", "--workdir may be specified only once");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new AppError("CONFIGURATION_ERROR", "--workdir requires a path");
    coordinatorWorkdir = value;
    index += 1;
  }
  return coordinatorWorkdir === undefined ? {} : { coordinatorWorkdir };
}

export function formatStartupError(error: unknown): string {
  if (error instanceof AppError && error.code === "CONFIGURATION_ERROR") return `${error.code}: ${error.message}`;
  if (error instanceof z.ZodError) {
    const issues = error.issues.map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`).join("; ");
    return `CONFIGURATION_ERROR: ${issues}`;
  }
  return "startup failed";
}
