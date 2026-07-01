import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { isDirectExecution } from "../src/main.ts";

test("detects direct execution for URL-sensitive filesystem paths", () => {
  const path = "/tmp/codex bot#入口/main.ts";
  assert.equal(isDirectExecution(pathToFileURL(path).href, path), true);
  assert.equal(isDirectExecution("file:///other/main.ts", path), false);
});
