import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { readPackageInfo } from "../../src/distribution/package-info.ts";

test("finds the nearest codex-bot package manifest from a module URL", async (context) => {
  const temp = await mkdtemp(join(tmpdir(), "codex-bot-package-info-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const packageRoot = join(temp, "package");
  const modulePath = join(packageRoot, "dist", "codex-bot");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "codex-chat-bot", version: "1.2.3-beta.1" }));

  assert.deepEqual(await readPackageInfo(pathToFileURL(modulePath).href), {
    root: packageRoot,
    name: "codex-chat-bot",
    version: "1.2.3-beta.1",
  });
});

test("rejects a nearest manifest for another package and a missing manifest", async (context) => {
  const temp = await mkdtemp(join(tmpdir(), "codex-bot-package-info-invalid-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const wrongRoot = join(temp, "wrong");
  await mkdir(join(wrongRoot, "dist"), { recursive: true });
  await writeFile(join(wrongRoot, "package.json"), JSON.stringify({ name: "another-package", version: "1.0.0" }));

  await assert.rejects(readPackageInfo(pathToFileURL(join(wrongRoot, "dist", "entry")).href), /not a codex-chat-bot package/);
  await assert.rejects(readPackageInfo(pathToFileURL(join(temp, "missing", "entry")).href), /could not locate codex-chat-bot package metadata/);
});

test("rejects invalid codex-bot package metadata", async (context) => {
  const temp = await mkdtemp(join(tmpdir(), "codex-bot-package-info-version-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  await mkdir(join(temp, "dist"));
  await writeFile(join(temp, "package.json"), JSON.stringify({ name: "codex-chat-bot", version: "latest" }));

  await assert.rejects(readPackageInfo(pathToFileURL(join(temp, "dist", "entry")).href), /invalid codex-chat-bot package metadata/);
});
