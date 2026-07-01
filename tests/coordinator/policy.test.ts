import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { TOOL_NAMES } from "../../src/coordinator/tools.ts";

const policyPath = fileURLToPath(new URL("../../assets/coordinator/AGENTS.md", import.meta.url));

test("packaged coordinator policy is a complete manager playbook without marker noise", async () => {
  const policy = await readFile(policyPath, "utf8");
  for (const heading of [
    "## Routing",
    "## Live state and lifecycle",
    "## Worker results and supervision",
    "## Exact directives",
    "## Models, effort, goals, and interruption",
    "## Attachments and failures",
    "## Manager notebook",
  ]) assert.match(policy, new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"));
  for (const name of TOOL_NAMES) assert.match(policy, new RegExp(`\\b${name}\\b`, "u"));
  assert.match(policy, /worker final messages are automatically delivered/iu);
  assert.match(policy, /\/pass.*payload and attachment IDs exactly/isu);
  assert.match(policy, /\/collect.*backend delivers.*directly/isu);
  assert.match(policy, /set_goal.*replaces the current goal/isu);
  assert.match(policy, /never declare or mark a worker goal complete/iu);
  assert.match(policy, /state change happened only when its tool receipt proves it/iu);
  assert.doesNotMatch(policy, /codex-bot:(?:managed|user)/u);
  assert.ok(Buffer.byteLength(policy, "utf8") >= 2_500);
});
