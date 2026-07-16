import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assistantMessagePresentation } from "../../webui-client/src/chat-provenance.ts";

test("keys QiYan-panel presentation on trusted worker provenance, not file-routing origin", () => {
  assert.deepEqual(assistantMessagePresentation({ role: "assistant" }), { className: "qiyan", label: "QiYan" });
  assert.deepEqual(assistantMessagePresentation({ role: "assistant", worker: "payments" }), { className: "worker-relay", label: "Worker · payments" });
  assert.deepEqual(assistantMessagePresentation({ role: "assistant", worker: "retired" }), { className: "worker-relay", label: "Worker · retired" });
  assert.deepEqual(assistantMessagePresentation({ role: "assistant", origin: "payments" }), { className: "qiyan", label: "QiYan" });
  assert.equal(assistantMessagePresentation({ role: "you" }), null);
});

test("QiYan and worker relays have explicit labels and distinct theme-aware borders", async () => {
  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../../webui-client/src/styles.ts", import.meta.url), "utf8");
  assert.match(source, /assistantMessagePresentation\(m\)/u);
  assert.match(styles, /--qiyan-border:/u);
  assert.match(styles, /--worker-relay-border:/u);
  assert.match(styles, /\.msg\.qiyan \{[^}]*border-color:var\(--qiyan-border\)/u);
  assert.match(styles, /\.msg\.worker-relay \{[^}]*border-color:var\(--worker-relay-border\)/u);

  const shipped = await readFile(new URL("../../assets/webui/index.html", import.meta.url), "utf8");
  assert.match(shipped, /worker-relay/u, "the shipped client contains relay styling");
});
