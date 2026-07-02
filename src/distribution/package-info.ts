import { readFile } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../core/errors.ts";

const packageName = "codex-chat-bot" as const;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export interface PackageInfo {
  root: string;
  name: typeof packageName;
  version: string;
}

export async function readPackageInfo(moduleUrl: string = import.meta.url): Promise<PackageInfo> {
  let directory = dirname(fileURLToPath(moduleUrl));
  const filesystemRoot = parse(directory).root;
  while (true) {
    const manifestPath = resolve(directory, "package.json");
    let source: string | undefined;
    try {
      source = await readFile(manifestPath, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw new AppError("CONFIGURATION_ERROR", "could not read codex-chat-bot package metadata");
    }
    if (source !== undefined) {
      let manifest: unknown;
      try {
        manifest = JSON.parse(source);
      } catch {
        throw new AppError("CONFIGURATION_ERROR", "invalid codex-chat-bot package metadata");
      }
      if (!isRecord(manifest) || manifest.name !== packageName) {
        throw new AppError("CONFIGURATION_ERROR", "executable is not a codex-chat-bot package");
      }
      if (typeof manifest.version !== "string" || !versionPattern.test(manifest.version)) {
        throw new AppError("CONFIGURATION_ERROR", "invalid codex-chat-bot package metadata");
      }
      return { root: directory, name: packageName, version: manifest.version };
    }
    if (directory === filesystemRoot) break;
    directory = dirname(directory);
  }
  throw new AppError("CONFIGURATION_ERROR", "could not locate codex-chat-bot package metadata");
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
