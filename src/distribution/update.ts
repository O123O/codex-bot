import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { AppError } from "../core/errors.ts";
import { readPackageInfo } from "./package-info.ts";

export const LATEST_RELEASE_URL = "https://github.com/O123O/qiyan-bot/releases/latest/download/qiyan-bot.tgz";

const inheritedEnvironmentKeys = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "TERM",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
]);

export interface UpdateSpawnOptions {
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: "inherit";
}

export interface UpdateOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export type UpdateRunner = (
  command: string,
  args: readonly string[],
  options: UpdateSpawnOptions,
) => Promise<UpdateOutcome>;

export interface UpdateOptions {
  moduleUrl?: string;
  env?: NodeJS.ProcessEnv;
  runner?: UpdateRunner;
}

export function globalPrefixForPackage(packageRoot: string): string {
  const root = resolve(packageRoot);
  const nodeModules = dirname(root);
  const lib = dirname(nodeModules);
  const prefix = dirname(lib);
  const valid = basename(root) === "qiyan-bot"
    && basename(nodeModules) === "node_modules"
    && basename(lib) === "lib"
    && resolve(prefix, "lib", "node_modules", "qiyan-bot") === root;
  if (!valid) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      "--update requires qiyan-bot to be globally installed in a user-owned npm prefix",
    );
  }
  return prefix;
}

export function buildUpdateEnvironment(host: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(host)) {
    if (value !== undefined && (inheritedEnvironmentKeys.has(key) || key.startsWith("LC_"))) result[key] = value;
  }
  return result;
}

export async function updateFromLatestRelease(options: UpdateOptions = {}): Promise<{ version: string; prefix: string }> {
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const current = await readPackageInfo(moduleUrl);
  const prefix = globalPrefixForPackage(current.root);
  const runner = options.runner ?? runUpdateChild;
  let outcome: UpdateOutcome;
  try {
    outcome = await runner("npm", [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      LATEST_RELEASE_URL,
    ], {
      env: buildUpdateEnvironment(options.env ?? process.env),
      shell: false,
      stdio: "inherit",
    });
  } catch {
    throw new AppError("CONFIGURATION_ERROR", "update failed: could not start npm");
  }
  if (outcome.signal !== null) {
    throw new AppError("CONFIGURATION_ERROR", `update failed: npm exited from signal ${outcome.signal}`);
  }
  if (outcome.code !== 0) {
    throw new AppError("CONFIGURATION_ERROR", `update failed: npm exited with status ${String(outcome.code)}`);
  }
  const updated = await readPackageInfo(moduleUrl);
  return { prefix, version: updated.version };
}

const runUpdateChild: UpdateRunner = async (command, args, options) => {
  const child = spawn(command, [...args], options);
  return await new Promise<UpdateOutcome>((resolveOutcome, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveOutcome({ code, signal }));
  });
};
