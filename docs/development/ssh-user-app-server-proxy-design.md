# User-owned SSH App Server proxy

## Problem

QiYan reaches a remote Codex App Server by asking OpenSSH to forward a local Unix
socket to the remote App Server Unix socket. This works on ordinary hosts, but it
fails on prenyx after the App Server has started successfully: a WebSocket upgrade
sent through the forward is reset.

The same upgrade succeeds when a Node process running as the authenticated remote
user connects directly to the remote socket. OpenSSH stream-local forwarding opens
the target socket from the server-side SSH process instead. Codex rejects that peer
before protocol initialization, so the worker's approval and sandbox configuration
cannot affect the failure.

A failed endpoint restart is intentionally retained as an uncertain operation when
QiYan cannot prove the lifecycle outcome. Later lifecycle operations for the same
endpoint are ordered behind it. The currently unresolved `prenyx` restart has no
checkpoint and will be retried by reconciliation; once endpoint activation succeeds,
the reconciler can complete it. This design fixes the persistent activation failure
instead of weakening operation ordering or editing durable operation state.

## Decision

Replace the OpenSSH stream-local forward with a user-space byte proxy carried by a
normal SSH command channel:

1. QiYan starts the locally digest-pinned remote helper over the endpoint's
   authenticated ControlMaster.
2. The helper re-attests the runtime directory, App Server socket, and exact runtime
   identity, then connects to the socket as the authenticated login user.
3. After connecting, the helper proves that the socket still has the captured
   device/inode and rechecks the exact runtime identity. It emits one fixed readiness
   marker, then copies stdin to the App Server and the App Server response to stdout.
4. QiYan bounds and discards all stdout before the marker and exposes only subsequent
   bytes as a local duplex stream. The proxy operation bypasses the normal helper
   response envelope entirely.
5. `WebSocketWire` performs its HTTP Upgrade directly over that duplex stream through
   a one-shot HTTP agent. No local listener pathname is created.
6. Closing the wire destroys the duplex stream and terminates the SSH proxy channel.

The App Server JSON-RPC protocol and WebSocket frame limits remain unchanged. The
transport still reuses the selected ControlMaster, but no longer asks `sshd` to
connect to the Codex socket.

## Interfaces and lifecycle

`SshRuntimeController` exposes one App Server byte-stream operation bound to an
expected SSH runtime identity. `SshRuntime` supplies the prepared runtime directory,
tmux namespace, and helper path to `SshRemoteClient`. Other remote helper consumers
remain request/response operations.

`SshRemoteClient` starts the proxy with `shell: false` and the existing safe,
compressed helper-program argument. Its stdin remains available for WebSocket bytes.
It waits for a fixed readiness marker, bounding and discarding remote-shell stdout
before that marker so banners never enter the WebSocket stream. A missing marker or
early exit is a generic transport failure. It returns a small stream handle rather
than buffering post-marker output. The handle bounds and discards stderr and provides
idempotent close that escalates from stream shutdown to process termination.

`WebSocketWire.connectStream` wraps the handle's readable/writable sides in a
socket-compatible duplex adapter and passes it to a dedicated non-pooling HTTP agent.
The adapter implements Node HTTP's required `setTimeout()` contract and WebSocket's
`setNoDelay()` behavior; `setTimeout()` does not replace QiYan's independent handshake
deadline. Its `_destroy` idempotently closes the SSH handle. The agent rejects a second
request in `addRequest`, before Node can queue it behind `maxSockets`, and offers the
stream only to the admitted request. The existing handshake timeout, payload limit,
redirect prohibition, compression setting, and subprotocol check apply unchanged.
Wire failure or close destroys the adapter and agent.

`SshAppServerRuntime` owns one stream and wire connection at a time. An overlapping
open is rejected before asynchronous work. A failed open rolls back the wire and
stream while leaving the detached App Server alive. Transport shutdown waits for an
in-flight open, closes the active connection, and only then closes a QiYan-owned
ControlMaster.

The initial local-listener design was rejected during tests: Node's path-based
`net.Server.close()` may unlink a replacement socket at the same pathname independently
of application device/inode checks. Direct stream connection eliminates the listener,
crash residue, stale reclaim, and replacement-path race instead of relying on private
Node internals.

## Security

- The remote helper is the locally digest-pinned program carried in the SSH argv; the
  installed helper file remains only an attested locator.
- The proxy accepts one JSON argument and reuses the helper's runtime-path validation.
- The helper captures the owner-private App Server socket's device/inode and proves
  the exact runtime identity. After connecting it re-stats that exact inode and
  rechecks the identity before readiness or byte copying.
- The fixed readiness marker is consumed locally. Pre-marker stdout and all stderr are
  bounded and discarded; the helper's normal response frame is never emitted.
- The one-shot agent refuses a concurrent second request at admission and cannot fall
  back to TCP or pool the stream.
- WebSocket frames retain their existing one-megabyte limit.
- No token, message body, credential, or attachment content is added to logs or errors.

## Implementation plan

1. Add failing tests for bounded readiness-marker handling, generic pre-marker failure,
   helper byte transparency, post-connect inode/identity re-attestation, a real `ws`
   handshake/message flow over a non-`net.Socket` adapter, concurrent second-request
   refusal, open rollback, and shutdown ordering.
2. Add the helper proxy operation and update the pinned helper digest.
3. Add a bounded streaming SSH-process handle and expose it through `SshRemoteClient`
   and `SshRuntimeController`.
4. Add `WebSocketWire.connectStream` with a one-shot agent/duplex adapter and replace
   stream-local forward lifecycle in `SshAppServerRuntime`.
5. Update the SSH integration test, run `npm run check`, and validate against prenyx.
6. Deploy and restart QiYan, then confirm automatic reconciliation completes the old
   `prenyx` operation and endpoint activation succeeds.

## Acceptance criteria

- A WebSocket upgrade and App Server initialization succeed on prenyx through the
  authenticated ControlMaster.
- The remote socket connection is made by the authenticated user-space helper, not
  by OpenSSH stream-local forwarding.
- A changed runtime identity, including a socket replacement during connect, is
  rejected before readiness or byte copying.
- Remote shell preamble and helper response framing never enter the WebSocket stream;
  failure before the bounded readiness marker is generic and fully cleaned up.
- The WebSocket uses the supplied non-`net.Socket` stream once, satisfies Node HTTP's
  socket timeout contract, rejects a concurrent second request without queuing, and
  never falls back to a network socket.
- Open failure and intentional close leave no SSH proxy process or local listener.
- A detached remote App Server survives ordinary wire close and is stopped only by an
  exact runtime shutdown.
- The unresolved `prenyx` lifecycle operation completes through normal reconciliation;
  subsequent restart and disconnect operations are no longer locked behind it.
