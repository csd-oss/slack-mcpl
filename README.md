# slack-mcpl

Standalone Slack MCPL server: connects a Slack workspace (channels, private
channels, DMs, group DMs) to an MCPL host as a first-class channel surface.
Sibling of [discord-mcpl](../discord-mcpl), built on
[`@connectome/mcpl-core`](../mcpl-core-ts).

Works in plain MCP mode too (tools only, no push events or channels).

The server negotiates MCPL when the host advertises `experimental.mcpl` in
`initialize`. It stays inert until the host's `featureSets/update` Request
establishes the capability grant (MCPL 0.5 SPEC §5.3 — absence is denial),
then registers Slack conversations as channels. Channel registration, push
events, and every other privileged inbound method stay unavailable until
that grant arrives; plain MCP tool calls are unaffected.

## Features

- **Channels**: every conversation the bot can act in is registered as an MCPL channel (`slack:<conversationId>`) when the host grants `channels.register`, and `refresh_channels` registers ones joined since. `channels/publish` posts in the thread of the last message the server passed to the host from that conversation, which can change while the agent is answering. Use [`reply_message` for an explicit thread](#reply-to-a-specific-thread).
- **Real-time events** via Socket Mode — no public webhook URL needed, so the
  server can be spawned over stdio like any other MCPL server.
- **Addressing model**: mentions (`<@bot>`) and DMs are always delivered;
  ambient channel chatter flows only from subscribed conversations
  (auto-subscribe on first mention, opt out with `unsubscribe_channel`).
  With `SLACK_SUBSCRIBE_MEMBER_CHANNELS`, every conversation the bot is in is
  subscribed and `unsubscribe_channel` mutes one instead.
  Events carry MCPL RFC-001 `chat:*` tags for host-side wake gating.
- **Threads**: incoming thread replies carry `threadId`; `reply_message`
  posts into a message's thread; `fetch_thread` reads one (Slack's
  channel-level history API does not include thread replies).
- **Typing**: `channels/typing` shows "is thinking…" on the thread of the
  conversation's newest incoming message (`assistant.threads.setStatus`,
  covered by `chat:write`), only where the bot may write. Slack clears it
  when the bot posts in that thread, on `op: 'stop'`, or after 2 minutes.
- **Attachments**: incoming files are forwarded as refs and fetched on demand
  via `fetch_attachment`, which is auth-locked to `files.slack.com` (the bot
  token is never sent to any other host) and size-capped at 5MB. A download
  that takes longer than 10 seconds fails, and can be called again.
- **Rollback**: `slack.messaging` supports MCPL checkpoints — rolling back
  deletes the messages and uploaded files the bot sent after the checkpoint
  (best-effort).

## Tools

`send_message`, `reply_message`, `upload_file`, `send_dm`, `add_reaction`,
`edit_message`, `delete_message`, `list_channels`, `refresh_channels`, `fetch_history`,
`fetch_thread`, `find_user`, `fetch_attachment`, `subscribe_channel`,
`unsubscribe_channel`, `list_subscriptions`.

Feature sets: `slack.messaging` (rollback-capable; `send_message`,
`reply_message`, `upload_file`, `send_dm`, `add_reaction`, `edit_message`, `delete_message`,
plus push events and `channels/incoming` delivery),
`slack.history` (`fetch_history`, `fetch_thread`, `fetch_attachment`),
`slack.subscriptions` (`subscribe_channel`, `unsubscribe_channel`,
`list_subscriptions`). `list_channels`, `refresh_channels` and `find_user`
belong to no feature set, so disabling a feature set does not switch them
off. In MCPL mode they still need the `tools` grant: every tool is refused
until the host has granted `tools`. Channel registration and
`channels/publish` follow their own capabilities (`channels.register`,
`channels.publish`), not the `slack.messaging` feature set.

A host that grants `slack.messaging` a capability set missing what it
declares (§6.4) stops its tools, its incoming delivery, and its push events
all at once, and the degradation receipt to `featureSets/update` reports the
missing paths in `unavailableFeatures`. A host that only leaves
`slack.messaging` out of `enabled`, or lists it in `disabled`, gets the same
effect, but the receipt does not list it: the receipt reports missing
capabilities, not feature-set selection.

The host receives each reply once, through `channels/publish`. The server
does not declare `channels.streaming`.

## Upload a file

Use `upload_file` with a Slack `channelId`, a required `filename`, and exactly
one of `content` (UTF-8 text) or `contentBase64` (canonical RFC 4648 base64,
with padding where required, and no whitespace or data-URI prefix). The
content must be nonempty. This server limits inline content to 5 MiB
(5,242,880 bytes), measured after UTF-8 encoding or base64 decoding; this is
the server's inline limit, not Slack's file-size limit. The tool accepts
inline content only by default. Operators may separately enable one explicit
path-upload policy; see [Optional path uploads](#optional-path-uploads).

Optional `messageId` selects the thread root (the message's `thread=` value,
or its `id=` when it has no `thread=`). `title` names the
file in Slack (defaulting to `filename`), and `comment` adds an initial
comment. `SLACK_SEND_CHANNELS` and `SLACK_DISABLE_DMS` apply to uploads just
as they do to message sends. Successful uploads belong to `slack.messaging`
checkpoints, so rollback attempts to delete them along with later messages.
An uploaded file is undone through Slack's file deletion API. Rollback is
best-effort and reports partial failures; checkpoint history is kept in
memory across host reconnects, but does not survive a server restart. As with
message rollback, failed deletions are reported in the partial count but are
not retained for another rollback attempt.

**Operators:** the bot token needs `files:write`. After adding that scope to
an existing Slack app, reinstall the app to the workspace through Slack's
OAuth flow so the installed token receives the new scope. Editing the app's
scope list alone does not update the token. Without the scope, Slack refuses
uploads with `missing_scope`.

### Optional path uploads

Path uploads let an agent hand off an existing report, log or binary without
reproducing its contents as text or base64 in the model's context. A `path` names
a file on the **connector process's machine and filesystem**, which may differ
from the host agent's machine. It does not upload a file from the agent's machine
across a remote connector connection automatically.

Path access is off unless the operator supplies `SLACK_PATH_UPLOADS` as JSON.
There is no implicit boolean opt-in. Choose one mode explicitly:

```sh
# Read only through these directory capabilities.
SLACK_PATH_UPLOADS='{"mode":"restricted","directories":["/srv/reports"]}' slack-mcpl --stdio

# Explicitly permit any regular file the connector account can read.
SLACK_PATH_UPLOADS='{"mode":"unrestricted"}' slack-mcpl --stdio
```

For an embedded server, the corresponding `SlackMcplServer` option is
`pathUploads: {mode: 'restricted', directories: ['/srv/reports']}` or
`pathUploads: {mode: 'unrestricted'}`. Leave the option unset to retain the
inline-only tool. Both enabled modes add `path` to `upload_file`: pass exactly
one of `path`, `content` or `contentBase64`. `path` must be absolute; `filename`
is optional for a path and defaults to its basename. Inline content still needs
an explicit `filename`. The tool is advertised as both `comms` and `files` when
path access is enabled, and remains `comms` when inline-only.

In **restricted** mode, configured roots must be existing absolute directories.
The connector canonicalizes them and pins directory descriptors at startup; a
configured root may itself be an alias to its canonical directory. This mode
requires **Python 3.9 or newer** and supported descriptor-path facilities on
Linux or macOS. A static Python standard-library worker runs with `-I -S` in a
clean environment, without a shell or connector credentials. It opens each
component relative to a directory descriptor with `O_NOFOLLOW`. All symlinks
below a configured root are refused, including ones that point back inside it.
The parent connector never changes its working directory.

The worker checks the actual final file descriptor's path against the pinned
root at admission, before reading, and again before returning any bytes. It uses
Linux `/proc` descriptor paths or macOS `F_GETPATH`; directory names or a cwd
ancestry check alone do not establish the final file's containment. No content
is returned unless the checks pass. Missing Python, unsupported platform/path
facilities or verification failure refuses the restricted read, with no downgrade
to unrestricted access.

In **unrestricted** mode, ordinary connector-account permissions determine which
files can be read. Symlinks to regular files are allowed and there is no
configured-directory boundary. Both modes refuse non-regular files, use a
nonblocking open so a FIFO cannot wait for a writer, and enforce the same 5 MiB
limit on the opened descriptor, including a bounded read if the file grows.
The SDK receives the resulting bytes rather than a raw path. Inline-only and
unrestricted modes remain Node-only and require no Python runtime.

The existing send-channel and DM guards run before the local read and are checked
again by the adapter before upload. They restrict the Slack destination, while
the selected path mode governs local reads. Existing `files:write`, checkpoint
and rollback behavior still applies; enabling paths does not grant a new Slack
scope or bypass a denied destination.

Pinned roots are directory capabilities, not immutable snapshots or an OS
sandbox. Descriptor-path checks observe containment at the stated check points;
they do not create an atomic, perpetual boundary during concurrent filesystem
changes. File contents may change while being read. Restricted mode does not
isolate hard links, privileged mounts or administrative renames. It also does
not constrain a shell or another process with equivalent account/sudo access.
Use OS account/filesystem permissions for those boundaries, and choose
unrestricted mode only when that broader local-file access is intended.

The previous local draft's `allowFilePaths` option and `SLACK_ALLOW_FILE_PATHS`
boolean are removed. Setting the old CLI variable, including `false` or an empty
value, fails with a migration error. Choose a policy explicitly; there is no
silent migration to unrestricted access. Access profiles, disabled-tool settings,
feature grants and recipient-host compatibility checks continue to apply.


## Explicit access policy

Embedded callers can opt in with `connectSlack({ ..., accessPolicy })`, or call
`adapter.configureAccessPolicy(policy)` once before starting Socket Mode:

```ts
adapter.configureAccessPolicy({
  writeChannels: ['CWRITABLE'],
  dmUsers: [],
  readJoinedChannels: true,
});
```

This separates joined-channel reads from configured channel writes and allowed
one-to-one DM peers. An empty `dmUsers` list denies all DMs; group DMs are denied.
Each incoming event and operation validates fresh conversation metadata and the
required token scopes. Listing includes only confirmed joined channels and
allowed DMs, even with `includeNonMember`. User-directory lookup remains global
metadata discovery with `users:read`; it does not grant message access. Legacy
write allowlists still apply as an additional restriction. Without an explicit
policy, existing flags and behavior are unchanged.

With an explicit policy, its `dmUsers` list is authoritative for DM read/write
admission; the legacy `SLACK_DM_USERS` and `SLACK_DISABLE_DMS` controls describe
the no-policy mode. Use an empty policy `dmUsers` list to disable DMs explicitly.

An optional `historyMembershipFallbackChannels` list names exact write destinations
that the operator has independently verified are public. If `channels:read` is
absent, each operation proves fresh membership with a successful bot-token
`conversations.history({ channel, limit: 1 })` call. A `C` prefix or history success
cannot establish public visibility. Fallback never caches membership, invents
scopes, or applies to unconfigured channels, DMs or private-channel metadata;
normal metadata checks remain when `channels:read` is present. Refusals, rate
limits and unknown scopes fail closed.

With this profile, `fetch_attachment` requires `channelId` and `fileId` rather
than trusting a supplied URL. It checks fresh readable membership, requires
`files:read`, verifies that `files.info` associates the exact file with that
conversation, and downloads only Slack's canonical private URL with redirects
refused. Live messages, history, threads and backscroll provide these IDs;
missing file IDs are marked unavailable. Without the profile, URL-only fetches
remain compatible. Inline uploads carry the `comms` MCPL class. Explicitly enabling local path
uploads adds the `files` class to `upload_file`.

## Reply to a specific thread

When answering a particular message, use `reply_message` to select its thread explicitly. Automatic prose delivery through `channels/publish` carries no thread or triggering message ID. The server uses the thread of the last message it passed to the host from that Slack conversation instead, whether or not the host accepted it, so another message can redirect the reply to a different thread, or to the channel's top level ([#6](https://github.com/anima-research/slack-mcpl/issues/6)). The server keeps that in memory only: after a restart, a publish goes to the top level until the server passes on a message from the conversation.

1. Select the Slack conversation ID, such as `C123`, rather than its MCPL ID, `slack:C123`.
2. For `messageId`, use the target message's displayed `thread=` value. If it has no `thread=`, use its `id=`: the reply goes into that message's own thread, which starts one if it has none. History results call these fields `threadTs` and `id`.
3. Send the reply through `reply_message`.

For example, to answer `[thread=1718000000.000100 id=1718000000.000200] Ann: Can you check this?` in conversation `C123`, call `reply_message` with:

```json
{
  "channelId": "C123",
  "messageId": "1718000000.000100",
  "content": "Here is what I found."
}
```

This selects the thread root even if another message arrives before the tool call. The automatic `channels/publish` route still has the limitation above; explicit tool replies do not change its destination.

## Setup

### 1. Create the Slack app

Go to https://api.slack.com/apps → **Create New App** → *From a manifest*,
and paste:

```yaml
display_information:
  name: Connectome Agent
features:
  bot_user:
    display_name: connectome-agent
    always_online: true
oauth_config:
  scopes:
    bot:
      - channels:history
      - channels:read
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - mpim:history
      - mpim:read
      - chat:write
      - users:read
      - reactions:write
      - files:read
      - files:write   # upload_file
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  socket_mode_enabled: true
```

### 2. Tokens

1. **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-...`)
   → `SLACK_BOT_TOKEN`
2. Under **Basic Information → App-Level Tokens**, generate a token with the
   `connections:write` scope (`xapp-...`) → `SLACK_APP_TOKEN`
3. Invite the bot to channels you want it to see:
   `/invite @connectome-agent` (DMs work without invites — users can message
   the bot directly)

If you add scopes such as `files:write` to an already installed app,
reinstall it to the workspace through the OAuth flow to grant those scopes
to the bot token.

### 3. Run

```bash
npm install
npm run build

SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... slack-mcpl --stdio
# or: slack-mcpl --tcp 9040
```

## Bounded history and thread reads

`fetch_history` searches one conversation's **channel-level messages**. It does
not search ordinary thread replies; an incidental broadcast reply does not make
it a complete thread search. Use `fetch_thread(channelId, threadTs)` for one
known root. No automatic thread expansion or workspace search occurs.

Both tools retain `messages`, `id`, `author`, `timestamp`, `content`, optional
`threadTs` and attachment hints. They add:

- `authorId` when Slack supplies a user ID, and `authorBotId` when supplied.
  Display names use the existing name cache, falling back to the stable ID;
  these bounded reads do not make additional user-name requests.
- `rootTs` and `rootSource` (`reported` by Slack, or the message's own ID).
  Parent `thread_ts === ts` is retained as root identity, while `threadTs`
  continues to identify a reply's parent. `replyCount` is included only when
  Slack supplies a valid nonnegative integer; missing means unknown, not zero.
- One `channel` object: `writeAllowedByPolicy` has the existing
  `list_channels.writable` meaning. `channel.slack` separately reports observed
  flags/restrictions and nullable `channelPostAllowedByMetadata` /
  `threadReplyAllowedByMetadata`. `false` means metadata establishes a block;
  `true` requires explicit clear flags and an explicitly empty applicable
  restriction. Otherwise it is `null` (unknown), including role restrictions
  whose applicability is unknown. None of these fields grants a Slack scope or
  guarantees a later write. For example, a thread-only channel can block root
  posts independently of replies. No test post is used.

Without an explicit access policy, reads request fresh `conversations.info`
metadata once per call. If its scope is missing but history is permitted,
metadata is unknown and the read proceeds; no new OAuth scope is required.
With an explicit policy, bounded reads reuse its fresh membership, DM and
history-scope admission instead; a missing policy requirement never falls back
to legacy admission. The existing operator-pinned history membership proof
consumes one data page within `maxPages`, and resumes recheck it. Authorized
attachment references keep `channelId`/Slack file IDs rather than message URLs.
An explicit loss of channel membership refuses
the read. `SLACK_DISABLE_DMS` still requires Slack to confirm a non-DM channel.
Every continuation performs fresh Slack requests; a cursor never grants access
or serves cached message content. Slack's own read refusal is propagated.

`fetch_history` also accepts `textContains`, `caseSensitive` (default `false`)
and `authorIds`. The literal substring is matched against **raw Slack text**,
before formatting. Case-insensitive matching uses JavaScript Unicode
`toLowerCase`, without locale rules or normalization. Author IDs are exact
Slack user IDs, ORed within the list and ANDed with the substring. Missing
authors do not match an author filter. Regex is not supported. Filtering reduces
returned context; it still retrieves candidate messages from Slack.

All numeric inputs are bounded integers, independently applied **per call**:

| Input | Default | Inclusive range | Meaning |
|---|---:|---:|---|
| `limit` | 50 history / 100 thread | 1–1,000 | Returned matches/messages; thread parent counts when present |
| `maxScanned` | 1,000 | 1–10,000 | Candidate messages examined |
| `maxPages` | 10 | 1–50 | History/replies requests, plus at most one metadata request |
| `maxMs` | 10,000 | 100–30,000 | Deadline including metadata; aborts in-flight tool-read HTTP work |
| `maxBytes` | 65,536 | 2,048–1,048,576 | UTF-8 bytes of the complete result JSON, before MCP text-block wrapping |

Tool reads do not retry or sleep through rate limits. The legacy messaging,
backscroll and unread clients retain their existing behavior. The deadline/byte
limits bound tool work/output, not the Slack service's response size or timing
of remote processing after cancellation.

`pagination` reports `scanned`, `matched`, `returned`, `pages`, `scanComplete`,
`stopReason`, `scope` and `threadRepliesSearched`. `matched` counts examined
matches, including a match held back by the byte budget. Stop reasons are
`exhausted`, `match_limit`, `scan_limit`, `page_limit`, `time_limit`, `byte_limit`,
`rate_limited` and `pagination_stalled`. A rate limit may include
`retryAfterSeconds`; the caller chooses whether/when to resume. A stalled
pagination response is incomplete, never silently exhausted.

**Zero matches in an incomplete scan does not mean no matching message exists.**
`scanComplete` describes only the selected channel-message range or single
thread, never all channel threads. A default upper timestamp is fixed when the
initial read starts. `oldest` and `latest` are exclusive bounds on both tools.
Slack history remains live: edits, deletions and cursor invalidation can affect
later pages; this is not an immutable export.

For incomplete reads, pass `pagination.nextCursor` as `cursor` and repeat the
original channel, thread, time bounds and filters. Budget values may change
within their bounds. History traverses newest toward older messages, returning
each batch oldest-first; thread traversal proceeds oldest toward newer replies.
Append thread batches, but prepend later history batches when building a
chronological list. When `byte_limit` returns no messages, increase `maxBytes`
to fit the held match; it is not silently skipped. A match larger than the hard
maximum cannot be returned whole by this tool.

Handles retain only query hashes and positions, expire after 15 minutes, belong
to one adapter instance and are capped at 128 live entries (oldest evicted).
Tampering, filter/channel/thread mismatch, eviction or restart refuses before
reading. Restart the query after expiry/eviction; no signing credential, durable
cursor store, raw message cache or new access route is introduced.

Compatibility: the former truncation `note` is replaced by structured
`pagination`; clients must check it and resume rather than assuming a complete
range. Previously unbounded/invalid numeric limits and unknown arguments now
refuse. Existing tool names, default match counts and list `writable` semantics
remain stable. No new scopes, regex, bulk expansion, native search or
interaction-token handling are included.

## Environment

Switches take `true`/`false` (also `1`/`0`, `yes`/`no`); any other value stops the server, so a typo cannot leave a guard off.

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | yes | Bot token (`xoxb-…`) for Web API calls |
| `SLACK_APP_TOKEN` | yes | App-level token (`xapp-…`, `connections:write`) for Socket Mode |
| `SLACK_DM_USERS` | no | Comma-separated user-ID whitelist for DMs; others' DMs are dropped |
| `SLACK_SEND_CHANNELS` | no | Comma-separated conversation-ID allow-list for writes (send, upload, DM, edit, delete, reaction, and the host's `channels/publish`); writes elsewhere are refused before the call reaches Slack. Other conversations are registered `inbound`, `list_channels` shows `writable: false`, and the first message the agent gets from one, addressed or not, carries a read-only note. A mention there still reaches the agent; whether it wakes is the host's policy. `send_dm` is refused before a DM is opened, and not offered, unless the list names a DM. Set but empty is refused at startup; the effective list is logged |
| `SLACK_SUBSCRIBE_MEMBER_CHANNELS` | no | `true` delivers ambient messages from every channel the bot is a member of, so inviting the bot is the subscription. `unsubscribe_channel` then mutes a conversation (`subscribe_channel` unmutes it) and `list_subscriptions` lists the muted ones. Takes `true` or `false` (also `1`/`0`, `yes`/`no`); unset is off, and any other value, empty included, stops startup |
| `SLACK_DISABLE_DMS` | no | `true` drops incoming DMs and group DMs, refuses every write to them and both history reads on them, and leaves them out of `conversations.list`, so they are neither listed nor registered; `send_dm` is not offered. Only a conversation Slack confirms as a channel passes: a group DM ID looks like a channel ID, and a user ID posts into that user's DM. An unknown ID is asked about until Slack confirms it. One Slack won't describe is refused; when the question can't be answered just now (a rate limit, a failure on the way or on Slack's side, or too little of the call's time), nothing is written, and the error says why and that the call can be made again. Incoming events pass only when Slack marks them `channel` or `group`. Takes `true` or `false` (also `1`/`0`, `yes`/`no`); unset is off, and any other value, empty included, stops startup |
| `SLACK_ACK_REACTION` | no | Emoji name (e.g. `eyes`) put on a message that addresses the bot. It means "received": it is removed at the bot's next post in that conversation, after 10 minutes, or at once if the host does not accept the message. A removal that fails without an answer from Slack (a rate limit, an HTTP error or a network failure) is retried every minute, 5 times at most; one Slack refuses is dropped. An add that fails isn't tried again. One that may have landed is removed as usual: `already_reacted` says it's there, and Slack's failure while handling it (`internal_error`, `fatal_error`, `service_unavailable`), an HTTP error, or a failure in transit after the request may have reached Slack leaves it unknown. One Slack refused, rate-limited or received only in part (`request_timeout`), one whose connection was never made, and one this server refused itself, such as outside `SLACK_SEND_CHANNELS`, isn't there. On SIGTERM, SIGINT or the host closing stdin, pending reactions are removed (5 s at most); a crash cannot, so removal is best-effort. For a typing signal see **Typing** above |
| `SLACK_SUBSCRIPTIONS_FILE` | no | JSON file persisting ambient subscriptions across restarts: an array of IDs, or `{subscribed, muted}` while anything is muted (older versions read the object form as empty) |
| `SLACK_BACKSCROLL_LIMIT` | no | Messages fetched on first interaction with a conversation (default 50; `0` disables automatic backscroll) |
| `SLACK_MCPL_DEBUG_LOG` | no | Absolute path for a diagnostic file log |
| `SLACK_ACCESS_POLICY` | no | Explicit JSON policy: `readJoinedChannels`, `writeChannels`, `dmUsers`, optional `historyMembershipFallbackChannels`. Omit to retain legacy controls. See the access-policy section above. |
| `SLACK_RECIPIENT_ROUTING` | no | Opt-in JSON containing absolute private `stateFile`, installation `namespace`, optional `expectedBotUserId`. Requires explicit access policy, Node 24+ on POSIX, and a compatible recipient-aware MCPL host. |
| `SLACK_DISABLED_TOOLS` | no | Comma-separated known tool names to hide and refuse, including direct invocation. For example, operators may disable subscription editing while retaining joined-channel ambient reads. |
| `SLACK_PATH_UPLOADS` | no | JSON `{ "mode": "restricted", "directories": ["/srv/reports"] }` or explicit `{ "mode": "unrestricted" }`; unset keeps inline-only. Restricted mode needs optional Python 3.9+ and supported descriptor-path facilities. The old `SLACK_ALLOW_FILE_PATHS` variable is rejected. |

## Optional recipient-aware mode

Ordinary MCP tools and MCPL defaults remain available without this mode. To opt
in, install an explicit access policy and give this agent a private directory
containing its own durable receipts file. The directory must already exist, be
owned by the process user and have no group/other permissions. Do not share this
file across receiving identities or installations.

The following are illustrative policy values, not installation defaults:

```json
{
  "SLACK_ACCESS_POLICY": "{\"readJoinedChannels\":true,\"writeChannels\":[\"CTEAM\"],\"dmUsers\":[\"UOPERATOR\"]}",
  "SLACK_RECIPIENT_ROUTING": "{\"stateFile\":\"/private/agent-state/receipts.sqlite\",\"namespace\":\"workspace-receiver\",\"expectedBotUserId\":\"URECEIVER\"}",
  "SLACK_SUBSCRIBE_MEMBER_CHANNELS": "true",
  "SLACK_BACKSCROLL_LIMIT": "0",
  "SLACK_DISABLED_TOOLS": "subscribe_channel,unsubscribe_channel"
}
```

Authentication resolves the actual bot identity; an expected-ID mismatch refuses
configuration. The namespace binds local state, not a Slack workspace identity
attestation. Existing receipt and unrelated legacy tables are preserved. An old
installation may reuse its former anchor-channel string as the namespace to keep
its ledger identity binding. Admission is at most once: a transport failure after
receipt commit can lose a delivery. Never reset receipts or replay history as a
code rollback.

In this mode an admitted own mention can wake regardless of human, bot or unknown
sender classification. There is no human arming, peer count or expiry gate.
Unaddressed messages remain context only. One-to-one DMs can wake only through a
verified human counterpart on the configured peer list. Read access, addressing
and operational authority remain separate; provenance never grants owner powers.

The host must advertise and receive acknowledgment of the experimental
`slackRecipientRouting` v1 contract, validate both delivery lanes, store context
without scheduling a new turn, and preserve a frozen conversation/thread target
through its inference lifecycle. Rootless automatic publication/status is refused;
recipient typing verifies its parent and cannot clear a different turn's status.
Pending status operations are discarded across connection or policy changes.

See [HOST-COMPATIBILITY.md](docs/HOST-COMPATIBILITY.md) for the exported bridge,
descriptor and required host hooks. The helper and synthetic lifecycle tests do
not install or qualify an arbitrary Connectome/framework version. Existing
deployments using private host patches require a separately reviewed adapter
migration before switching to this connector. Setting environment readiness
markers does not implement those hooks.

The [consolidation review plan](docs/CONSOLIDATION.md) records source provenance,
the proposed upstream split, optional path boundaries and history-feature
proposals. This branch includes merged upstream #15; it does not merge pending #20/#29 or implement those
history proposals.

## Tests

```bash
npm test
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). A change an operator, a host or an
agent would notice lands with a changelog fragment in
[`changelog.d/`](changelog.d/README.md).

## Provenance

The Slack domain logic (Socket Mode event handling, mrkdwn formatting,
cursor-drained history pagination, attachment URL allowlisting) was salvaged
from zulip-mcp PR #8's multi-platform branch and re-homed here as a
standalone MCPL server following discord-mcpl's structure.

The MCPL 0.5 policy handshake (`src/grant.ts`, `src/errors.ts`, and the
`featureSets/update` wiring in `src/server.ts`) is ported from zulip-mcp's
`src/grant.ts`, which is itself protocol-generic — no Zulip-specific logic —
built on `@animalabs/mcpl-core`'s `grantFromUpdate`/`capabilityGranted`/
`deriveFeatureSets`.
