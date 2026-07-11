import assert from "node:assert/strict";
import test from "node:test";
import { isLocalEndpointId } from "../../src/production-app.ts";

// The shared predicate behind the workspace router, rollout-access, and worker file bridge.
// Regression guard for "SSH workspace host is unavailable: claude-local": the local Claude
// endpoint must count as local so it is never routed through the ssh path.
test("isLocalEndpointId treats the Codex local and the configured local Claude endpoint as local", () => {
  assert.equal(isLocalEndpointId("local", "claude-local"), true);
  assert.equal(isLocalEndpointId("claude-local", "claude-local"), true);
  // remote endpoints (ssh Codex, catalog claude-code) are never local
  assert.equal(isLocalEndpointId("devbox", "claude-local"), false);
  assert.equal(isLocalEndpointId("dfw-claude", "claude-local"), false);
});

test("isLocalEndpointId degrades to the Codex local id when no local Claude endpoint is configured", () => {
  assert.equal(isLocalEndpointId("local", undefined), true);
  assert.equal(isLocalEndpointId("claude-local", undefined), false); // a real id never equals undefined
});
