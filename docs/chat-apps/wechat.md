# Personal WeChat adapter

Status: Implemented

QiYan supports one personal WeChat owner through Tencent's iLink bot interface. This is a direct personal owner adapter: it is not a public account, enterprise WeChat integration, group bot, or multi-user service.

## Security and capability limits

Before launch, remember that the assistant runs non-interactively with full filesystem access by default and chat approvals are unsupported. Anyone who can use the authenticated owner account can instruct QiYan with that authority.

Supported inbound content:

- text;
- images;
- generic files; and
- voice transcription when Tencent supplies transcription text.

Supported outbound content is text, images, and generic files. Groups are unsupported. Raw voice is not supported when Tencent supplies no transcription, raw video is unsupported, and chat history and search are not supported. Unsupported media becomes an explicit unavailable-item descriptor; it is never silently reinterpreted as another type.

## 1. Install and authenticate QiYan

Follow the [installation guide](https://github.com/O123O/qiyan-bot/blob/main/docs/installation.md) and [shared assistant setup](https://github.com/O123O/qiyan-bot/blob/main/docs/setup.md). Keep the bot stopped while changing WeChat authorization.

Authenticate interactively in a trusted terminal:

```bash
qiyan-bot weixin-login --home "$HOME/.qiyan-bot"
```

QiYan displays a QR code. Scan it with the intended personal WeChat owner and confirm in WeChat. A successful login writes the managed credential to `<QIYAN_HOME>/credentials/weixin.json`; at the default home this is `~/.qiyan-bot/credentials/weixin.json`. The credentials directory is owner-only mode 0700 and the file is owner-only mode 0600.

WeChat credentials do not belong in `.env` or process environment variables. Do not create `WEIXIN_BOT_TOKEN`, `WEIXIN_BOT_ID`, or `WEIXIN_OWNER_USER_ID`; those names are explicitly scrubbed as unsupported pseudo-secret inputs. QiYan does not copy, link, delete, or automatically refresh this credential.

For a custom home, use the same `--home` value for `weixin-login`, `config-check`, `assistant-login`, and the running service.

## 2. Select the primary adapter

A WeChat-only installation needs no `.env` chat credential and no `PRIMARY_CHAT_APP`. Keep any ordinary non-secret runtime settings in the private `<QIYAN_HOME>/.env`.

When two or three adapters are configured, select the route for administrative messages:

```dotenv
PRIMARY_CHAT_APP=weixin
```

The other valid values are `telegram` and `slack`. This setting does not broadcast replies: active conversation ownership and immutable attempt routing still determine each causal reply.

## 3. Validate and start

Before launching, remember that QiYan uses non-interactive full filesystem access by default and there is no approval UI in WeChat.

```bash
qiyan-bot config-check --home "$HOME/.qiyan-bot"
qiyan-bot assistant-login --home "$HOME/.qiyan-bot"
qiyan-bot --home "$HOME/.qiyan-bot"
```

Send a direct text message from the scanned owner account. Then smoke-test one small image, one small generic file, and a voice message with visible transcription. A group message and a message from another account must not enter the assistant conversation. A raw video must enter only as an explicit unsupported-media descriptor, never as playable content.

## Relogin, backup, and revocation

If QiYan reports that authorization expired or credentials changed:

1. stop the complete QiYan process tree;
2. run `qiyan-bot weixin-login --home <same-home>` yourself;
3. run `qiyan-bot config-check --home <same-home>`; and
4. restart QiYan through your normal supervisor.

QiYan never decides to relogin or restart for you. A confirmed login atomically replaces the credential revision; changing the WeChat identity creates a new account generation and fences old inbox and outbound work.

Back up `<QIYAN_HOME>/credentials/weixin.json` only while QiYan is stopped, together with the rest of QiYan state. Treat the backup as a live credential: encrypt it, restrict access, and never commit it. Restoring only this file independently from the matching state can fence pending work. To revoke access, use the relevant WeChat/Tencent account controls, stop QiYan, and remove the local credential only as an explicit user action. Run `weixin-login` again before restarting if continued access is desired.

## Troubleshooting

- No QR or QR creation fails: confirm network access to Tencent endpoints, use an interactive terminal, and retry `weixin-login`. Do not paste QR data or verification values into logs or issue reports.
- The QR expires: rerun `weixin-login` and scan the fresh code. A failed or cancelled login leaves the prior credential unchanged.
- Endpoint or authorization error: stop QiYan, relogin, validate, and restart. Repeated `-14` authorization failures are latched rather than retried blindly.
- No input: ensure only one QiYan process is polling the credential, use the direct owner conversation, and wait through one bounded long-poll interval.
- Slow input: transient poll failures back off and recover; persistent delays may indicate endpoint reachability or a competing poller.
- Attachment failure: keep the fixture below `ATTACHMENT_MAX_BYTES`, use an image or generic file, and verify Tencent's signed CDN endpoint remains reachable. Raw audio and video output are rejected.
- Delivery is uncertain: inspect QiYan status before any manual retry. Ambiguous sends and uploads are never blindly repeated.

## Protocol provenance

The low-level protocol behavior was independently implemented from Tencent's official `Tencent/openclaw-weixin` release 2.4.6 at revision `cef0bfc390393f716903e16d50408118047f87e0`, published under the MIT license. The QiYan runtime contains no OpenClaw dependency or copied OpenClaw runtime/source. There is no endorsement by Tencent, WeChat, or the reference project, and compatibility may change if Tencent changes the service.

## Optional live acceptance

The repository includes a visible-write, terminal-driven acceptance test. Stop the service first, use a test-safe account and attachments, and follow every prompt:

```bash
QIYAN_WEIXIN_LIVE=1 npm test -- tests/integration/weixin-live.test.ts
```

It reads the normal managed credential store, not environment secrets. The result records only redacted kinds, counts, states, and booleans; it never prints owner/bot IDs, message bodies, attachment contents, tokens, QR data, verification values, context tokens, or signed CDN parameters. The test is skipped by default.
