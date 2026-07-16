# Shared SSH runtime root

## Problem

QiYan currently installs each remote helper and keeps the detached App Server, identity file, tmux control socket, and App Server Unix socket below `/tmp/qiyan-<uid>`. That assumes separate SSH command channels see the same `/tmp`.

Some MFA SSH services isolate `/tmp` per channel even when every channel reuses one authenticated ControlMaster. Bootstrap succeeds in one channel, but the next channel cannot see the installed helper. Moving only the helper is insufficient: later channels must also reach the tmux control socket and App Server Unix socket. The remote home directory is shared but may be NFS, so it is not a safe location for Unix sockets.

## Decision

Remote preflight selects one runtime base:

- Prefer `<XDG_RUNTIME_DIR>/qiyan-bot` when the remote XDG directory is absolute, normalized, canonical, same-user, owner-private, on a non-NFS filesystem, and short enough for the final Unix-socket path.
- Otherwise retain `/tmp/qiyan-<uid>` for compatibility with ordinary SSH hosts and the existing fixture.

The preflight response includes the selected base. Local code validates that it matches the returned UID before deriving `<base>/<endpoint-hash>`. Every later helper invocation independently derives the allowed bases from its own UID and environment and rejects any other runtime path.

Each new endpoint runtime uses an explicit tmux socket at `<runtime-dir>/tmux.sock` instead of `tmux -L`, whose implicit socket lives below `/tmp`. The helper assets, launcher, identity, logs, transferred files, and App Server Unix socket remain under the shared per-endpoint runtime directory.

## Upgrade lifecycle

Before choosing the new App Server runtime directory, a Codex endpoint probes its legacy `/tmp/qiyan-<uid>/<endpoint-hash>` state with the legacy `tmux -L qiyan-bot` namespace:

- A healthy legacy runtime is reused for the current generation. Its helper commands come from the shared installed helper, while its existing identity, App Server socket, and tmux server remain untouched.
- An unhealthy legacy runtime remains an explicit error and is never shadowed by a duplicate new runtime.
- An absent legacy runtime selects the shared XDG runtime and explicit per-endpoint tmux socket.

Stopping an exact legacy runtime clears the cached legacy selection. A later start re-probes and selects the shared runtime after proving the legacy runtime absent. Likewise, an unexpectedly absent cached legacy runtime is not resurrected; the next start re-prepares against the shared base. Remote host services such as workspace operations and file transfer always use the shared helper/runtime directory, even while a pre-upgrade App Server is temporarily reused from the legacy directory.

This changes no SSH authentication or endpoint naming. Helper commands and forward control commands continue to pin and reuse the existing authenticated ControlMaster.

The configured prenyx ControlMaster lives in a canonical owner-only directory on NFS. QiYan previously rejected it solely by filesystem type, fell back to an unauthenticated BatchMode master, and exited 255. User-owned masters now retain exact canonical-path, UID, mode, and socket-type attestation regardless of filesystem type, followed by the authoritative `ssh -O check` and operation. QiYan-owned master sockets and remote App Server sockets still prefer local runtime storage.

## Security and lifecycle

- One helper validator derives the currently allowed bases and re-attests canonical identity, same-UID ownership, private mode, path length, and non-NFS filesystem state. Preflight uses it to select the base; bootstrap uses it before and after creation; every later `runtimeDir` consumer uses it again.
- The helper creates and revalidates the QiYan base and endpoint directory as mode 0700. The `/tmp` fallback additionally requires a root-owned sticky shared parent or a parent that is not writable by untrusted users.
- If a later channel has a missing, changed, or unsafe XDG directory, the previously selected XDG runtime path is rejected and the endpoint becomes unavailable. It does not silently fall back to another namespace.
- Every remote operation executes the locally digest-pinned helper as a gzip-compressed base64url Node.js module carried in a safe command argument, leaving stdin available for streamed uploads. Installed-helper paths remain validated locators but their cached bytes are never executed, so remote-root replacement cannot run code before attestation.
- Explicit per-endpoint tmux sockets avoid cross-endpoint collisions and remain below an attested private directory.
- The existing `/tmp` layout remains the fallback; no remote persistent home-state directory is introduced.
- Runtime stop continues to prove the exact process identity before killing the process group and tmux session.

## Implementation plan

1. Add failing tests for XDG preflight selection and re-attestation, local validation of the returned base, installed-helper path acceptance, explicit tmux socket use, legacy runtime reuse/transition, and `/tmp` fallback.
2. Return `runtimeBase` and UID from remote preflight, validate them in `prepareRemoteHost`, and keep shared host state separate from a temporarily reused legacy App Server directory.
3. Update helper runtime-path validation and explicit/legacy tmux commands; update the pinned helper digest.
4. Update SSH worker documentation and focused tests.
5. Run the repository check, obtain independent review, package, deploy, and validate a real prenyx endpoint generation through the authenticated ControlMaster.

## Acceptance criteria

- Two prenyx SSH channels see the same selected runtime directory.
- Helper bootstrap in one channel is usable by the next channel.
- Inspect/start and stream-local forwarding use the same shared per-endpoint runtime state.
- A healthy legacy runtime is reused without starting a duplicate; after exact stop, the next start selects the shared runtime.
- Existing hosts without a valid standard XDG runtime directory continue using `/tmp/qiyan-<uid>`.
- Unsafe, aliased, broadly accessible, wrong-owner, or NFS XDG directories are never selected.
