# Manager MCP Approval Fix Plan

**Goal:** Let the non-interactive coordinator call its authenticated manager MCP tools without Codex rejecting the call at an approval prompt.

## Root cause

The live coordinator attempted `prepare_chat_attachment` twice. Both Codex tool results were `user rejected MCP tool call`, while the durable backend operation ledger recorded no attachment operation. The manager handler therefore never ran.

The coordinator thread uses `approvalPolicy: "never"` with the production default `workspace-write` sandbox, while `coordinatorTurnConfig()` configures the private manager MCP server without `default_tools_approval_mode`. Omission selects Codex's `auto` mode. Because these MCP tools have no safety annotations, pinned Codex 0.142.4 conservatively treats them as approval-requiring; a non-interactive `never` thread rejects that request.

This server is intentionally safe to pre-approve as a transport boundary: it is loopback-only, requires an in-memory bearer token, verifies the client belongs to the coordinator app-server process tree, requires an active durable source context, validates every typed tool argument, and records state-changing effects in the operation ledger. Project app-servers do not receive the bearer token or manager MCP configuration.

## Test-first implementation

1. Add a regression assertion in `tests/mcp/server.test.ts` that the `codex_bot_manager` server config has `default_tools_approval_mode: "approve"`, while retaining the existing assertion that the bearer token value never appears in serialized config.
2. Change the real integration test's coordinator sandbox from `danger-full-access` to the production default `workspace-write`. Keep its `approvalPolicy: "never"`, exact one-call assertion, and shell token-hiding check.
3. Run the focused unit test and the opt-in real integration before changing production code. Confirm the unit assertion fails because the field is absent and the real manager call is rejected before reaching the handler.
4. Add only `default_tools_approval_mode: "approve"` to the `codex_bot_manager` entry returned by `coordinatorTurnConfig()` in `src/mcp/server.ts`.
5. Rerun the focused unit and real integration tests and confirm both pass, proving the omitted configuration fails and the explicit approved mode succeeds under `workspace-write`. Then run typecheck, the full test suite, and the package smoke test.

## Review and deployment

1. Have two agents review the change, focusing separately on Codex configuration semantics and on security/isolation regression risk.
2. Resolve all findings and repeat review until clean.
3. Fast-forward local `main`, rebuild and pack the distributable artifact, install it under `$HOME/.local`, and verify the installed command.
4. Gracefully stop the current installed bot, back up effective data, registry plus `.last-good`, and coordinator state, then restart from the newly installed binary with the existing secret environment.
5. Verify the binary process, both app-server children, managed policy digest, and version-2 dashboard. The user can then repeat the Telegram attachment request as the final end-to-end chat assertion.
