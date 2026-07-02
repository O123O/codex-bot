import { z } from "zod";
import { AppError } from "./core/errors.ts";

export type CliCommand =
  | { command: "run"; assistantWorkdir?: string }
  | { command: "assistant-login" }
  | { command: "update" }
  | { command: "version" };

export function parseCliArgs(argv: readonly string[]): CliCommand {
  if (argv[0] === "--update" || argv[0] === "--version") {
    if (argv.length !== 1) throw new AppError("CONFIGURATION_ERROR", "unknown argument");
    return { command: argv[0] === "--update" ? "update" : "version" };
  }
  if (argv[0] === "assistant-login") {
    if (argv.length !== 1) throw new AppError("CONFIGURATION_ERROR", "unknown argument");
    return { command: "assistant-login" };
  }
  let assistantWorkdir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument !== "--workdir") throw new AppError("CONFIGURATION_ERROR", "unknown argument");
    if (assistantWorkdir !== undefined) throw new AppError("CONFIGURATION_ERROR", "--workdir may be specified only once");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new AppError("CONFIGURATION_ERROR", "--workdir requires a path");
    assistantWorkdir = value;
    index += 1;
  }
  return assistantWorkdir === undefined ? { command: "run" } : { command: "run", assistantWorkdir };
}

export function formatStartupError(error: unknown): string {
  if (error instanceof AppError && error.code === "CONFIGURATION_ERROR") return `${error.code}: ${error.message}`;
  if (error instanceof z.ZodError) {
    const issues = error.issues.map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`).join("; ");
    return `CONFIGURATION_ERROR: ${issues}`;
  }
  return "startup failed";
}
