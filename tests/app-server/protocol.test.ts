import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import { GENERATED_CODEX_PROTOCOL_VERSION, MINIMUM_SUPPORTED_CODEX_VERSION } from "../../src/app-server/protocol.ts";

test("the generated experimental protocol and runtime require Codex 0.144.4", async () => {
  const manifest = JSON.parse(await readFile("src/app-server/protocol-manifest.json", "utf8")) as {
    version: string;
    sha256: string;
  };
  assert.equal(GENERATED_CODEX_PROTOCOL_VERSION, "0.144.4");
  assert.equal(MINIMUM_SUPPORTED_CODEX_VERSION, "0.144.4");
  assert.equal(manifest.version, "codex-cli 0.144.4");
  const generated = "src/app-server/generated";
  const digest = createHash("sha256");
  for (const path of await files(generated)) {
    digest.update(relative(generated, path));
    digest.update(await readFile(path));
  }
  assert.equal(manifest.sha256, digest.digest("hex"));
});

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else result.push(path);
  }
  return result.sort();
}
