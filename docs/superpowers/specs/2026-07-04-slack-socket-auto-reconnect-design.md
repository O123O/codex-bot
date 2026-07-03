# Slack Socket Auto-Reconnect Design

## Problem

The first Slack request after the assistant recovery fix took 15.8 seconds end to end. Codex used 1.9 seconds and outbound Slack delivery used 1.1 seconds, while 12.8 seconds elapsed before assistant admission. The Slack Socket Mode connection also reported missed pong deadlines and TCP retransmissions. QiYan currently disables the Slack SDK's automatic reconnection and implements its own reconnect state machine.

## Goal

Use the official Slack SDK connection lifecycle so a dead or routinely refreshed Socket Mode connection is detected and replaced promptly, without changing durable ingress, conversation arbitration, or assistant execution.

## Architecture

`SlackChatAdapter` will construct one `SocketModeClient` with `autoReconnectEnabled: true`. It will omit custom ping thresholds so the SDK uses its supported defaults: a 5-second client-pong timeout and a 30-second server-ping timeout. The adapter will keep the existing 10-second `apps.connections.open` HTTP timeout, reject rate-limited calls, and disable Web API request retries; the Socket Mode client remains the single owner of reconnect sequencing and backoff.

QiYan will remove its disconnected listener, reconnect timers, backoff counters, and manual calls to `start()` after initial startup. `start()` will subscribe to Slack events, start the durable ingress worker, and start the SDK client once. `stop()` will unsubscribe, settle accepted events, stop the ingress worker, and call the SDK's `disconnect()`. The SDK's shutdown flag prevents automatic reconnection after that explicit disconnect.

## Data Flow

Incoming envelopes keep the current order:

1. Classify the authenticated Slack event.
2. Persist accepted metadata and content in the durable Slack inbox.
3. Acknowledge the envelope.
4. Drain the inbox into the platform-neutral conversation store.
5. Let the conversation dispatcher start or steer Codex.

No message bodies, attachments, tokens, or credentials will be added to logs. The change affects only how the Socket Mode transport maintains its connection.

## Failure Handling

- Missed ping or pong deadlines, Slack-requested refreshes, and unexpected closes are handled by `@slack/socket-mode` automatic reconnection.
- Failure to obtain a replacement WebSocket URL is retried by the Socket Mode lifecycle, while each individual HTTP attempt remains bounded.
- Initial startup still fails if the first Socket Mode connection cannot be established.
- Explicit application shutdown uses `disconnect()` and must not leave a reconnect attempt running.
- Durable inbox recovery remains responsible for events persisted before a crash.

## Testing

Unit tests will verify that the adapter enables SDK automatic reconnection, preserves the bounded Web API client options, omits custom heartbeat settings, and does not register or schedule an application-owned reconnect. Existing tests will continue to cover event persistence, acknowledgement, draining, and orderly shutdown. The full `npm run check` suite must pass.

After packaging and restarting the local service, a fresh owner DM will be measured using metadata-only timestamps for Slack event time, assistant admission, terminal completion, and confirmed delivery. Success means no application-level reconnect loop remains, the service stays active, and a stable connection delivers the test event without the previous 10-plus-second pre-admission stall. A single transient slow event will be reported rather than hidden; repeated samples are needed before attributing residual delay to the network route.

## Non-Goals

- Maintaining multiple simultaneous Socket Mode connections.
- Changing assistant queuing, turn steering, model behavior, or delivery semantics.
- Adding a public HTTP Events API endpoint.
- Logging or persisting new message content for diagnostics.
