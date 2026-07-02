import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("packed codex-bot runs without source files or installed dependencies", async (context) => {
  const temp = await mkdtemp(join(tmpdir(), "codex-bot-package-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const packed = await execFileAsync("npm", ["pack", "--json", "--pack-destination", temp], { cwd: root });
  const metadata = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  assert.equal(metadata.length, 1);
  const archive = join(temp, metadata[0]!.filename);
  const listing = (await execFileAsync("tar", ["-tzf", archive])).stdout.split("\n").filter(Boolean);
  const requiredFiles = new Set([
    "package/README.md",
    "package/assets/coordinator/AGENTS.md",
    "package/assets/coordinator/session-status.example.json",
    "package/dist/codex-bot",
    "package/package.json",
  ]);
  for (const path of requiredFiles) assert.equal(listing.includes(path), true, `missing packed file: ${path}`);
  assert.deepEqual(listing.filter((path) => !requiredFiles.has(path) && !/^package\/(?:licen[cs]e|notice)(?:\.[^/]*)?$/iu.test(path)), []);

  const installRoot = join(temp, "install");
  await execFileAsync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installRoot, archive]);
  const packageRoot = join(installRoot, "node_modules", "codex-chat-bot");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  assert.deepEqual(manifest.dependencies ?? {}, {});
  const installedEntries = await readdir(packageRoot);
  const requiredEntries = ["README.md", "assets", "dist", "package.json"];
  for (const entry of requiredEntries) assert.equal(installedEntries.includes(entry), true, `missing installed entry: ${entry}`);
  assert.deepEqual(installedEntries.filter((entry) => !requiredEntries.includes(entry) && !/^(?:licen[cs]e|notice)(?:\..*)?$/iu.test(entry)), []);
  await assert.rejects(stat(join(packageRoot, "node_modules")));
  const tree = JSON.parse((await execFileAsync("npm", ["ls", "--all", "--json", "--prefix", installRoot])).stdout) as {
    dependencies?: Record<string, { dependencies?: Record<string, unknown> }>;
  };
  assert.deepEqual(Object.keys(tree.dependencies ?? {}), ["codex-chat-bot"]);
  assert.deepEqual(tree.dependencies?.["codex-chat-bot"]?.dependencies ?? {}, {});

  const executable = join(installRoot, "node_modules", ".bin", "codex-bot");
  assert.equal((await readFile(join(packageRoot, "dist", "codex-bot"), "utf8")).startsWith("#!/usr/bin/env node\n"), true);
  assert.notEqual((await stat(executable)).mode & 0o111, 0);

  const version = spawnSync(executable, ["--version"], {
    cwd: temp,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(version.status, 0);
  assert.equal(version.stdout, "0.1.0\n");
  assert.equal(version.stderr, "");

  const result = spawnSync(executable, ["--definitely-invalid"], {
    cwd: temp,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "codex-bot: CONFIGURATION_ERROR: unknown argument\n");

  const workdir = join(temp, "coordinator");
  const startup = spawnSync(executable, ["--workdir", workdir], {
    cwd: temp,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: temp,
      TELEGRAM_BOT_TOKEN: "pack-test-token",
      TELEGRAM_OWNER_ID: "1",
      TELEGRAM_DESTINATION_CHAT_ID: "1",
      DATA_DIR: join(temp, "data"),
      SESSION_REGISTRY_PATH: join(temp, "registry", "sessions.json"),
      CODEX_BINARY: join(temp, "missing-codex"),
      MCP_PORT: "0",
    },
  });
  assert.equal(startup.status, 1);
  assert.equal(startup.stderr, "codex-bot: startup failed\n");
  assert.equal(await readFile(join(workdir, "AGENTS.md"), "utf8"), await readFile(join(packageRoot, "assets", "coordinator", "AGENTS.md"), "utf8"));
  assert.deepEqual(JSON.parse(await readFile(join(workdir, "session-status.json"), "utf8")), { version: 2, sessions: {} });

  const globalRoot = join(temp, "global");
  await execFileAsync("npm", ["install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", globalRoot, archive]);
  const fakeHome = join(temp, "update-home");
  const fakeBin = join(temp, "fake-bin");
  await mkdir(fakeHome);
  await mkdir(fakeBin);
  const fakeNpm = join(fakeBin, "npm");
  await writeFile(fakeNpm, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
writeFileSync(join(process.env.HOME, "update-record.json"), JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
`);
  await chmod(fakeNpm, 0o755);
  const globalExecutable = join(globalRoot, "bin", "codex-bot");
  const update = spawnSync(globalExecutable, ["--update"], {
    cwd: temp,
    encoding: "utf8",
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      HOME: fakeHome,
      TELEGRAM_BOT_TOKEN: "telegram-secret",
      OPENAI_API_KEY: "openai-secret",
      CODEX_HOME: "/secret/codex-home",
      CODEX_BOT_MCP_TOKEN: "mcp-secret",
      NPM_TOKEN: "npm-secret",
      OTHER_SECRET: "other-secret",
    },
  });
  assert.equal(update.status, 0);
  assert.equal(update.stderr, "");
  assert.equal(update.stdout, `Updated codex-bot to 0.1.0 in ${globalRoot}.\nRestart any running codex-bot process to use this version.\n`);
  const updateRecord = JSON.parse(await readFile(join(fakeHome, "update-record.json"), "utf8")) as {
    argv: string[];
    env: NodeJS.ProcessEnv;
  };
  assert.deepEqual(updateRecord.argv, [
    "install", "--global", "--prefix", globalRoot, "--ignore-scripts", "--no-audit", "--no-fund",
    "https://github.com/O123O/codex-bot/releases/latest/download/codex-bot.tgz",
  ]);
  assert.equal(updateRecord.env.HOME, fakeHome);
  assert.match(updateRecord.env.PATH ?? "", new RegExp(`^${fakeBin.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:`));
  for (const key of ["TELEGRAM_BOT_TOKEN", "OPENAI_API_KEY", "CODEX_HOME", "CODEX_BOT_MCP_TOKEN", "NPM_TOKEN", "OTHER_SECRET"]) {
    assert.equal(updateRecord.env[key], undefined, `leaked update environment key: ${key}`);
  }
});
