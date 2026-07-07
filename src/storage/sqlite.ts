import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../core/errors.ts";

const require = createRequire(import.meta.url);

export type DatabaseSyncConstructor = typeof DatabaseSync;

export function loadDatabaseSync(load: () => unknown = () => require("node:sqlite")): DatabaseSyncConstructor {
  let loaded: unknown;
  try {
    loaded = load();
  } catch {
    throw unsupportedNode();
  }
  if (!isSqliteModule(loaded)) throw unsupportedNode();
  return loaded.DatabaseSync;
}

function isSqliteModule(value: unknown): value is { DatabaseSync: DatabaseSyncConstructor } {
  return typeof value === "object" && value !== null
    && "DatabaseSync" in value && typeof value.DatabaseSync === "function";
}

function unsupportedNode(): AppError {
  return new AppError("CONFIGURATION_ERROR", "Node.js 24 or newer is required to run QiYan Bot");
}
