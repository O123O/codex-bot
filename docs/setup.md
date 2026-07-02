# Shared setup

This guide prepares Codex and local bot state. Chat-specific credentials are covered by the individual adapter guide; currently only [Telegram](chat-apps/telegram.md) is implemented.

## Requirements

- Linux and Node.js 24 or newer
- the installed `qiyan-bot` command from the [installation guide](installation.md)
- `codex-cli 0.142.4`, authenticated normally for project workers
- a standalone assistant workdir, such as `$HOME/.qiyan-bot/assistant`

Project workers use your normal `HOME`, `CODEX_HOME`, configuration, credentials, and skills. The assistant uses an independent profile under the bot data directory. It never copies or links the normal Codex authentication file.

## Choose private paths

Use absolute paths for predictable service startup:

```bash
export DATA_DIR="$HOME/.qiyan-bot/data"
export SESSION_REGISTRY_PATH="$HOME/.qiyan-bot/data/sessions.json"
export ASSISTANT_WORKDIR="$HOME/.qiyan-bot/assistant"
install -d -m 700 "$HOME/.qiyan-bot" "$ASSISTANT_WORKDIR"
```

Keep the assistant workdir outside the bot source repository and outside `DATA_DIR`. The bot rejects overlapping or symlink-aliased state paths. It creates and owns `AGENTS.md`, `.qiyan-bot-agents.sha256`, and `session-status.json` in the assistant workdir; do not edit those files. Put a complete user replacement prompt in `AGENTS.override.md` if needed.

## Authenticate the assistant

Run device authentication once with the same `DATA_DIR` that the bot will use:

```bash
DATA_DIR="$DATA_DIR" qiyan-bot assistant-login
```

This command needs no chat credentials and starts no bot. Complete the displayed device flow. If authentication later expires, stop the bot, run this command again, and restart it; the bot does not decide to reauthenticate on your behalf.

## Configure and start

Set the adapter variables from its guide in the same environment, then start from any directory:

```bash
qiyan-bot --workdir "$ASSISTANT_WORKDIR"
```

`--workdir` overrides `ASSISTANT_WORKDIR`. SIGINT and SIGTERM perform graceful shutdown. For a long-running deployment, place these values in the private environment mechanism of your service manager rather than a repository file or shell history.

The bot intentionally starts project sessions with approval policy `never` because normal chat apps do not provide Codex approval controls. The configured sandbox defaults to `workspace-write`; use `danger-full-access` only for projects you trust. A permission request that still blocks work is reported to chat.

## State and backup

Stop the bot before backup and copy these items together:

- `DATA_DIR`, including SQLite, attachments, and the isolated assistant profile;
- `SESSION_REGISTRY_PATH` if configured outside `DATA_DIR`; and
- `ASSISTANT_WORKDIR`.

Treat the backup as secret because the assistant profile contains authentication and thread history. `session-status.json` is a generated read-only view and must not be restored independently from SQLite.

See the root [README](../README.md#troubleshooting) for runtime behavior, recovery guarantees, exact `/pass` and `/collect` directives, and troubleshooting.
