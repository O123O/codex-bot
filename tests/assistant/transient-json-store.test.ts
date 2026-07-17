import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { TransientJsonStore } from "../../src/assistant/transient-json-store.ts";

test("transient JSON results are private, bounded, and removed on stop", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "qiyan-tool-results-test-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const store = new TransientJsonStore(parent);
  await store.start();

  const paths: string[] = [];
  for (let index = 0; index < 33; index += 1) paths.push(await store.write({ index, body: "private" }));
  const root = dirname(paths.at(-1)!);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.at(-1)!)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(paths.at(-1)!, "utf8")), { index: 32, body: "private" });
  assert.equal((await readdir(root)).length, 32);
  await assert.rejects(access(paths[0]!));

  await store.stop();
  await assert.rejects(access(root));
});
