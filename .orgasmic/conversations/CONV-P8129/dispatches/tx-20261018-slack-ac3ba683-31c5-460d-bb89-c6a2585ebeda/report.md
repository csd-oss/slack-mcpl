READY_FOR_RUNTIME_CHECKHEAD matches the commit I was asked to review. Asking the coordinator for the runtime check now.Authorized. Starting the review.Source is about 5.3k lines, so I'll read all of it directly. I'll start the gates in the background first.Read the server and Slack adapter so far; moving on to the access-policy, history, routing, file and upload modules.Gates pass on Node 24: typecheck, build, and tests (452 total, 451 pass, 1 skipped). Continuing to read the remaining source.I've read all the main modules. Next I'll check the latest commits and the tests covering a few suspect areas.Before writing probes, a quick skim of the remaining two modules.The file write was refused, so I'll avoid creating any files and run the probes inline with plain JS through the existing tsx loader instead.Verdict: no blocking (HIGH) defects in `6de851e304d67e0341d269e0ce73c2e6a8cbb4d6`, but there are three confirmed MEDIUM bugs worth fixing, plus two LOW findings. All gates pass.

## Verdict
**Reviewed SHA:** `6de851e304d67e0341d269e0ce73c2e6a8cbb4d6` (HEAD checked before and after; tree clean).

**Merge parents (used only to find my way around):** `452dde0`, `cf2567e`.

**Runtime:** the coordinator confirmed this session ran as `claude-opus-5-5` with high effort over Claude ACP before the review started.

The fresh membership/scope checks, attachment association, upload validation/rollback and grant gating look correct. The three MEDIUM bugs are in the explicit-policy and recipient-routing paths.

## Findings

**P2 / MEDIUM / bug: routing mode drops any message that mentions or comes from a non-`U` Slack user ID**
- **Where:**
  - `src/recipient-routing.ts:63` limits user IDs to `^U…`.
  - `src/recipient-routing.ts:156` (author ID) and `:157` (mention IDs) throw if an ID doesn't match.
  - `src/slack-adapter.ts:945` passes in every `<@…>` mention, and `:950` calls the ledger with it.
- **Trigger:** routing is on and a message mentions a `W…` user (Enterprise Grid), e.g. `<@USELF> please loop in <@W0123ABC>`, or a `W…` user writes it.
- **Effect:** the ledger throws `Invalid routing mentions` or `Invalid routing message metadata`. The Socket Mode event was already acknowledged (`slack-adapter.ts:328`), so the message is lost for good, even when it addresses the bot. The only trace is a stderr line.
- **Reproduced:** under Node 24, a synthetic adapter with a temporary private SQLite file got three events and delivered only `100.1`. The other two failed with the errors above.
- **Inconsistency:** the code knows these IDs exist; `src/history-read.ts:46` accepts `^[UW]` for `authorIds`.

**P2 / MEDIUM / bug: one stale pinned fallback channel breaks the whole listing and channel registration**
- **Where:** `src/slack-adapter.ts:400-403` checks pinned fallback channels with no error handling. Listed channels get `catch { continue; }` at `:429`.
- **Trigger:** explicit policy with `historyMembershipFallbackChannels: ["CPIN"]`, no `channels:read`, and the bot has left `CPIN` (or the history check fails).
- **Effect:** `listConversations()` rejects with `not_in_channel`.
  - `registerSlackChannels` logs "Failed to enumerate" and registers nothing (`src/server.ts:962-967`).
  - `list_channels` (`:729`) and `refresh_channels` (`:1073`) both fail.
  - So every other readable channel (e.g. a joined `GPRIV`) disappears too.
  - Shutting out the stale pin itself is correct; losing the other channels is not.
- **Reproduced:** the pinned case rejected outright. The same failure on a non-pinned listed channel was skipped, and `[GPRIV]` was still returned.
- **Test gap:** `test/historyMembershipFallback.test.ts` never tests listing when the pinned check fails.

**P2 / MEDIUM / correctness: the explicit policy lets a later message in a conversation overtake an earlier one**
- **Where:**
  - `src/slack-adapter.ts:325-335` handles each Socket Mode event in its own concurrent task.
  - `:928-935` waits on a fresh `conversations.info` (or `history` for pinned channels) for every message before passing it on.
  - `src/server.ts:1238-1242` queues per conversation in the order messages reach the server, not Slack's order.
- **Trigger:** two messages in one conversation whose admission calls finish out of order: bursts, bot peers in routing mode, file share plus text.
- **Reproduced:** with a 40 ms delay on the first `info`, Slack order `1.0, 2.0` reached the server as `['2.0','1.0']`.
- **Effect:**
  - The host sees the conversation out of order.
  - In legacy publish mode, `lastIncomingThreadTs` (`server.ts:1484`, used at `:1153`) can point at the older message's thread, so a reply can land in the wrong thread.
  - First-interaction backscroll and the watermark follow the wrong message.
- Legacy mode had only a narrow version of this window (the first `users.info` for a new user); the explicit policy opens it on every message.

**P3 / LOW / docs: the `maxPages` description is wrong for pinned fallback channels**
- **Where:** `src/tools.ts:10` says "one metadata request is additional". But the pinned membership check is a `conversations.history` call that counts as a page (`src/slack-adapter.ts:455`).
- **Intentional:** `test/historyReadPolicyIntegration.test.ts:73-80` deliberately checks that it uses up the page budget.
- **Effect:** with `maxPages: 1` on a pinned channel, every call returns no messages, `page_limit`, and a `nextCursor` that never advances. An agent following the documented contract loops.

**P3 / LOW / stale state: `lastIncomingRoot` is not reset for a new connection**
- **Where:** `serve()` clears the other per-peer delivery state (`src/server.ts:237-244`) but not `lastIncomingRoot` (`:173`).
- **Effect:** a new peer's legacy `channels/typing` before its first message (`:560`) sets "is thinking…" on the previous peer's last thread. This is from reading the code; I did not run it.

## Open Questions
- Should routing mode and the access policy support Enterprise Grid `W…` IDs? If not, it should at least downgrade unknown mention IDs instead of dropping the message, and the limitation should be documented.
- Is the `maxPages: 1` dead end on pinned channels acceptable if documented, or should the membership check be budgeted separately?
- The host bridge (`src/host-compatibility.ts:96`) requires `metadata.serverId`, which the server never sends. I assume the host injects it; please confirm that is the intended contract.

## Verification Notes
**Gates** (logs are in the evidence directory):

| Gate | Node | Result |
|---|---|---|
| `typecheck` | 24.14.0 | exit 0 |
| `build` | 24.14.0 | exit 0 |
| `test-node24` | 24.14.0 | 452 tests: 451 pass, 1 skipped (Linux-only), 0 fail |
| `test-node22` | 22.22.3 | 452 tests: 431 pass, 21 skipped (advanced routing tests, by design), 0 fail |

**What I read:** all of `src/`, plus the history-fallback, policy-integration and recipient-integration tests.

**Probes:**
- The three MEDIUM findings were reproduced with an inline `node --import tsx -e` script using fake Slack clients. There was no network and no real Slack.
- Saving the probe script into the evidence directory was refused, so it ran inline and no file was written. Its output is in `/tmp/claude-p8129-probes.out`, which is not durable.
- Tracked files are byte-identical; `git status` was clean afterwards.

**Not covered:**
- Real Slack behaviour (Grid ID formats, ordering of `conversations.replies`, undici stripping auth headers on redirect).
- Live MCPL hosts.
- The Linux-only path-upload checks (this ran on macOS).

**Other notes:**
- Unrestricted path mode can read any file the connector account can, e.g. `/proc/self/environ` (which holds the bot token) on Linux. This is documented operator opt-in, so it isn't a finding.
- In routing mode every typing refresh makes two Slack reads (`server.ts:556`), which costs rate-limit budget.
- The routing ledger's `seen` table is never pruned.

## Fix Directions
- **Non-`U` IDs:** in `slack-adapter.ts`, filter mention IDs to the ledger's pattern before calling it, and decide whether to accept `W…` IDs in `USER`/policy. Add a regression test with a `<@W…>` mention.
- **Pinned listing:** wrap the pinned-channel checks in `listConversations` with the same skip-and-log used for listed channels. Add a test where one pinned channel fails and the others are still registered.
- **Ordering:** run admission one message at a time per conversation in the adapter, e.g. chain a per-channel promise before `requireHistoryConversation` so messages are passed on in arrival order. Add a test with a delayed `info`.
- **Docs:** fix the `maxPages` text, or don't count the pinned check as a page.
- **Stale state:** add `this.lastIncomingRoot.clear()` in `serve()`.Finalize needs the report as a file in the evidence directory. The prompt explicitly sanctions `report.md` there, so I'll write it.The review is done, but it isn't finalized: you declined both writing `report.md` to the evidence directory and running `orgasmic dispatch finalize`. The daemon won't take `--summary-from-last-message` for this run because it has no completed turn yet, so it needs a summary file. Nothing in the worktree changed; `git status` is clean at `6de851e304d67e0341d269e0ce73c2e6a8cbb4d6`.

**Verdict:** no blocking bugs, but three confirmed MEDIUM bugs and two LOW findings.

- **MEDIUM – routing mode loses messages with non-`U` user IDs.** In routing mode, a message that mentions an Enterprise Grid `W…` user, or is written by one, makes the ledger throw (`src/recipient-routing.ts:156-157`). The Slack event was already acknowledged, so the message is gone even if it addresses the bot. I reproduced it on Node 24: only the plain message got through.
- **MEDIUM – one stale pinned channel breaks the whole channel list.** If the bot has left a pinned fallback channel, `listConversations()` fails outright (`src/slack-adapter.ts:400-403`). Registration then registers nothing, and `list_channels` and `refresh_channels` fail. Reproduced; the same failure on a non-pinned channel is skipped as it should be.
- **MEDIUM – messages can arrive out of order under the explicit policy.** Each incoming event waits on its own fresh Slack lookup before it is handed on (`src/slack-adapter.ts:325-335`, `:928-935`), so a later message can overtake an earlier one. Reproduced: Slack order `1.0, 2.0` reached the server as `2.0, 1.0`. In legacy publish mode a reply can then go to the wrong thread.
- **LOW – `maxPages` description is wrong for pinned channels.** `src/tools.ts:10` says the metadata request doesn't count as a page, but the pinned membership check does. With `maxPages: 1` the cursor never advances.
- **LOW – typing state carries over between connections.** `serve()` doesn't clear `lastIncomingRoot` (`src/server.ts:237-244`), so a new peer's typing can show on the previous peer's thread. Found by reading; not run.

**Gates:** all passed and were recorded as receipts. Typecheck and build pass on Node 24. Tests pass on Node 24 (451 of 452, 1 Linux-only skip) and Node 22 (431 of 452, 21 routing tests skipped by design). The probes ran inline with fake Slack clients, no network. Their output is only in `/tmp/claude-p8129-probes.out`, which won't last.

The full report (open questions, verification notes and fix directions) is in my previous message. To close the run, either:
1. Allow writing `report.md` to `$ORGASMIC_EVIDENCE_DIR` and running `orgasmic dispatch finalize --summary-file "$ORGASMIC_EVIDENCE_DIR/report.md"`, or
2. Tell me to finalize with `--status blocked --reason "report write/finalize not permitted"`.

Until one of those happens, the run counts as failed.