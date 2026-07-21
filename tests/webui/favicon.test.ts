import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the Web UI ships the QiYan logo as an embedded favicon", async () => {
  const source = await readFile(new URL("../../webui-client/index.html", import.meta.url), "utf8");
  assert.match(source, /<link rel="icon" type="image\/png" href="\/src\/favicon\.png" \/>/);

  const favicon = await readFile(new URL("../../webui-client/src/favicon.png", import.meta.url));
  assert.deepEqual(favicon.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(favicon.readUInt32BE(16), 64);
  assert.equal(favicon.readUInt32BE(20), 64);

  const shipped = await readFile(new URL("../../assets/webui/index.html", import.meta.url), "utf8");
  assert.match(shipped, /<link rel="icon" type="image\/png" href="data:image\/png;base64,/);
});
