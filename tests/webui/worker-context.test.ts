import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("renders the same compact model and effort context for QiYan and workers below the composer", async () => {
  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../../webui-client/src/styles.ts", import.meta.url), "utf8");
  const composer = source.indexOf('<div className="composer">');
  const context = source.indexOf('{selectedSession && <div className="worker-context"');
  assert.notEqual(context, -1, "selected worker context is rendered");
  assert.ok(composer < context, "worker context follows the composer");
  assert.match(source, /selected === null \? assistantSession : sessions\.find/u, "QiYan selects its own session metadata");
  for (const field of ["provider", "model", "effort", "projectDir", "host"]) assert.match(source, new RegExp(`selectedSession\\.${field}`, "u"));
  assert.match(styles, /\.worker-context \{[^}]*font-size:11px/u);

  const shipped = await readFile(new URL("../../assets/webui/index.html", import.meta.url), "utf8");
  assert.match(shipped, /worker-context/u, "the shipped client contains the worker context footer");
});
