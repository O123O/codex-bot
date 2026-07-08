# GitHub command extension

## Status

Design proposal. This extension is not implemented.

## Purpose

Allow the owner to address QiYan from a pull-request comment without running a
public webhook receiver, a GitHub Actions runner, a second GitHub account, or a
per-repository polling loop.

The GitHub integration remains outside the QiYan repository as an installable
QiYan chat-adapter extension. Codex plugins, skills, MCP servers, hooks,
authentication, and repository tools remain ordinary Codex App Server
configuration. QiYan does not install, inspect, or emulate them.

## User contract

A newly created pull-request comment or review body is a QiYan command only when
all of the following are true:

- the event actor is the GitHub account authenticated by the extension;
- the target is a pull request, not an ordinary issue;
- the body begins at byte zero with the exact lowercase prefix `qiyan: `; and
- the payload after the prefix is non-empty.

The extension removes only `qiyan: ` and sends every following byte to QiYan as
an ordinary chat message. It does not summarize, translate, or otherwise
rewrite the payload.

For example:

```text
GitHub comment: qiyan: please fix the null handling
QiYan receives: please fix the null handling
```

Existing QiYan directives keep their normal semantics:

```text
GitHub comment: qiyan: /pass fix only this race
QiYan receives: /pass fix only this race
```

`/pass` is therefore checked by the existing QiYan safeguard after normal chat
admission. The GitHub extension has no session-selection, pass-through, goal,
or worker-management logic. Without `/pass`, QiYan decides how to handle the
message just as it does for Telegram or Slack.

Edits to an existing comment do not trigger a command. A correction is a new
comment with a new immutable GitHub identity. Deletions never trigger work.

## Why the authenticated activity feed

GitHub's Notifications REST API is a user inbox. It is useful for review
requests, mentions, and updates from other people, but it is not the right
authoritative source for a command authored by that same user.

The command extension instead polls the authenticated user's activity feed:

```text
GET /users/{username}/events
```

When the caller is authenticated as `{username}`, GitHub includes private
events visible to that user. The relevant event families are expected to be:

- `IssueCommentEvent` whose issue has pull-request identity;
- `PullRequestReviewCommentEvent`; and
- `PullRequestReviewEvent` with a non-empty review body.

The implementation must confirm the exact current event shape with fixtures
before accepting it. It must fetch the referenced comment or review through an
authoritative GitHub API endpoint before chat admission rather than trusting a
partial activity-feed projection.

GitHub documents this feed as polling-optimized but explicitly not real-time.
Depending on load, events may lag from 30 seconds to six hours. This extension
is therefore eventually delivered and must never promise chat-like latency.

References:

- [List events for the authenticated user](https://docs.github.com/en/enterprise-cloud@latest/rest/activity/events#list-events-for-the-authenticated-user)
- [REST API endpoints for events](https://docs.github.com/en/enterprise-cloud@latest/rest/activity/events)
- [REST API endpoints for notifications](https://docs.github.com/en/rest/activity/notifications)

## Polling and rate limits

The extension invokes the user's existing `gh` executable with fixed argument
arrays. It does not invoke a shell, read the credential value, or add another
GitHub SDK. Startup verifies the authenticated login through `gh` and binds it
to the configured owner identity.

Each activity-feed request uses GitHub's conditional polling protocol:

1. Retain the exact `ETag` and `X-Poll-Interval` response headers.
2. Wait at least the number of seconds in `X-Poll-Interval`.
3. Send the prior ETag as `If-None-Match`.
4. Treat `304 Not Modified` as a successful empty poll.
5. On `200 OK`, page backward until reaching the durable event watermark.

GitHub documents that an unchanged conditional request returning `304` leaves
the current REST rate limit untouched. The extension must obey a larger
`X-Poll-Interval` if GitHub raises it under load. It must use bounded
exponential backoff for transport, authentication, abuse-limit, and secondary
rate-limit failures.

The feed contains at most 300 events and only events from the previous 30 days.
If the durable watermark has fallen outside that window, the extension records
and reports a history gap instead of guessing which commands were missed.

## Durable ingress

Activity events are newest-first and can share timestamps. Time alone is not a
safe cursor. The durable identity is the GitHub event ID combined with the
authoritative comment or review ID.

On `200 OK`, the extension performs the following sequence:

1. Parse and validate the bounded response without logging bodies.
2. Collect unseen candidate events until the prior watermark is reached.
3. Fetch each candidate's authoritative comment or review.
4. Revalidate repository, pull request, actor, creation action, and prefix.
5. Store accepted commands in the extension inbox and store the new feed ETag
   and watermark in the same transaction.
6. Acknowledge the poll only after that transaction commits.
7. Drain the durable inbox into QiYan's ordinary chat admission path.

QiYan acknowledgement and the extension checkpoint are separate durability
boundaries. An inbox row becomes processed only after QiYan has durably
accepted its canonical chat source. Restart recovery retries pending rows using
the same immutable native source ID, so QiYan's existing duplicate protection
prevents a second assistant turn.

First startup establishes the current feed head as a baseline and does not
execute historical `qiyan:` comments. Importing historical commands must never
be implicit.

## Chat mapping

An accepted command becomes a normal extension-backed chat source:

```json
{
  "adapter_id": "github",
  "conversation_key": "github:OWNER/REPOSITORY:pr:42",
  "native_source_id": "github-event-id:comment-id",
  "raw_text": "/pass fix only this race",
  "destination": {
    "repository": "OWNER/REPOSITORY",
    "pull_request": 42
  },
  "reply": {
    "comment_id": 123456
  }
}
```

Repository, pull-request, and comment metadata are transport context, not part
of `raw_text`. QiYan may submit a separate bounded origin item such as
`[GitHub OWNER/REPOSITORY PR #42]`, as it does for other chat platforms,
without changing `/pass` payload bytes.

The conversation key gives successive commands on one pull request normal
same-conversation steering behavior. A command from another pull request
queues rather than steering an unrelated active turn.

## Delivery

QiYan and managed-worker finals use the immutable GitHub binding captured when
the command was accepted. The extension posts a response with a fixed-argument
`gh` invocation and supplies the Markdown body over standard input, for
example through `gh pr comment --body-file -`. Model output is never
interpolated into a shell command.

For an inline review command, the extension may reply to the original review
thread when the GitHub API and permissions support that exact operation.
Otherwise it posts a normal pull-request conversation comment containing a
link to the originating review comment. This fallback must be explicit and
must not silently claim to be an inline reply.

Outbound delivery uses the same durable prepared, dispatched, confirmed, and
uncertain states as other QiYan chat adapters. A lost response is reconciled by
stable delivery identity before any retransmission.

## Security and privacy

- Only the GitHub login bound during extension initialization may issue a
  `qiyan:` command.
- The extension relies on the user's existing repository access; it does not
  install another account or request collaborator access.
- A classic-scope credential may be broad. QiYan does not copy or persist it;
  `gh` owns credential retrieval and authenticated requests.
- Repository text, review text, comment bodies, API response bodies, tokens,
  and generated replies are never written to operational logs.
- Commands are accepted only from newly created PR comments or reviews. Titles,
  commit messages, branch names, check output, and repository content cannot
  trigger the prefix.
- GitHub content following the command payload is still untrusted repository
  context. It does not expand the authority granted by the explicit command.
- All API output, command text, identifiers, pages, and attachment-like links
  are bounded before persistence or model submission.
- `gh` is executed without a shell, with a fixed executable and fixed argument
  structure. User or model text is passed through standard input where needed.

## Extension boundary

The GitHub package implements the same logical surface as any QiYan chat
adapter:

- initialize and validate configuration;
- start and stop its polling loop;
- admit canonical messages;
- send text and optional files;
- optionally provide pull-request conversation history; and
- report bounded metadata-only health events.

It does not call Codex App Server RPCs, edit the session registry, select a
worker, modify goals, or know which Codex capabilities are installed. Project
workers continue to inherit the user's normal Codex configuration and may use
`gh`, GitHub MCP tools, skills, or plugins without any QiYan integration code.

## Rejected alternatives

- **GitHub App webhook:** real-time, but requires a publicly reachable HTTP
  receiver or hosted relay.
- **Self-hosted GitHub Actions runner:** outbound-only and prompt, but adds a
  privileged long-running workflow executor to the QiYan machine.
- **Machine user:** provides a distinct mention target, but requires another
  account and repository access management.
- **Slack as a relay:** avoids a public endpoint but couples GitHub support to
  Slack and turns a presentation message into an unstable notification signal.
- **Repository-by-repository comment polling:** can be timely but scales API
  requests with the number of repositories and pull requests.

## Verification plan

Before implementation is considered complete, tests must cover:

- strict prefix parsing and exact `/pass` preservation;
- owner, pull-request, event-action, and authoritative-object validation;
- first-start baseline behavior with no historical execution;
- ETag reuse, `304` handling, and `X-Poll-Interval` enforcement;
- pagination across identical timestamps and event-ID deduplication;
- crash recovery before and after feed-checkpoint commit;
- a watermark that falls outside the bounded event history;
- comment deletion or edit never creating work;
- private-repository events without logging sensitive content;
- ordinary QiYan queuing and same-conversation steering;
- response delivery uncertainty and exact reconciliation; and
- a live opt-in test measuring actual GitHub activity-feed delay without
  treating observed latency as a contractual guarantee.
