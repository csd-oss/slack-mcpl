# Host compatibility for recipient-aware Slack delivery

This document specifies a proposed, versioned opt-in connector/host contract.
It is an extension under local review, not an existing MCPL requirement, a claim
of RFC conformance, or proof that a stock host supports it. The reusable bridge is
implemented in `src/host-compatibility.ts`; the receiving host must still connect
it to real storage, scheduling, continuation and output paths. Connector/helper
tests cannot establish compatibility of an arbitrary host. Exact implementation
commits and test results must be recorded before a host/profile pair is declared
ready.

## Opt-in and versioning

`RECIPIENT_CAPABILITY` is `slackRecipientRouting`. For recipient mode, the host's
MCPL 0.5 `initialize.capabilities.experimental` object must contain this exact
versioned descriptor, using its configured receiving bot user ID:

```ts
{
  slackRecipientRouting: {
    version: 1,
    botUserId: ownUserId,
    contextOnly: true,
    frozenReply: true,
    frozenStatus: true,
    provenance: true,
  },
}
```

The connector validates the descriptor for its authenticated receiving identity
and echoes it only after validation. A missing/inconsistent descriptor or lack
of MCPL 0.5 refuses the recipient-mode session. This is a local experimental
capability, not a standardized MCPL field.

The host must install a bridge against an explicit connector connection instance
and validate an operator-supplied policy snapshot before advertising support.
`createRecipientHostBridge` produces the host descriptor as
`initializeCapability`. A launcher environment flag is not the protocol
agreement. **The descriptor is a host attestation, not proof that its promises
are implemented.** A host can falsely advertise it; the operator must use a
verified implementation and composition evidence. Neither a server name nor a
successful handshake alone establishes that implementation's correctness.

For an opted-in profile, a missing acknowledgment, unsupported version, malformed
policy or unavailable host hook refuses activation of that profile. It must not
silently fall back to ambient inference, legacy latest-message routing or a
different conversation. A separately configured legacy profile may retain its
existing behavior; that is an explicit operator choice rather than negotiation
failure recovery.

Breaking changes to admission fields, context semantics or target preservation
require a new contract version. Extending capability declarations does not
retroactively upgrade existing host behavior.

## Ownership of policy and facts

| Responsibility | Connector | Host/framework bridge |
|---|---|---|
| Connection identity | `auth.test` authenticates the bot and supplies team metadata; optional `expectedBotUserId` rejects a receiving-bot mismatch | Bind that connector instance to the configured agent and expected identity; do not infer workspace attestation from state configuration |
| Access | Verify actual scopes, conversation kind/membership, DM peer and permitted destination before the relevant operation | Validate and snapshot operator policy; prevent another connection or chat message from widening it |
| Sender provenance | Derive author/bot/unknown classification and mention IDs from authenticated Slack event/API data | Preserve provenance; do not treat a message's text or display name as an identity claim |
| Addressing | Report the admitted event's own mention or authorized human-DM signal and stable event ID | Validate those signals before scheduling a turn on either delivery lane |
| Authority | Report facts, including uncertainty; a human sender is not automatically the owner | Derive owner/operator privileges from trusted configuration and authenticated identity |
| Reply/status routing | Verify explicit destinations and write permission; refuse invalid or missing targets | Freeze the target at admission and carry it through every continuation and output path |

Access, addressing and authority are separate decisions. A readable message need
not request a response. An addressed message need not permit a write in that
conversation. A peer mention need not grant authority to change credentials,
permissions or deployment configuration. Never infer privileges from prose such
as "I am the owner" or from a connector-rendered label alone.

Identifiers and policy lists are operator inputs. The public connector and bridge
must not embed an installation's account, workspace, channel or owner IDs.
The host must snapshot validated lists so mutation of an input object cannot
silently widen an already installed policy.

## Reusable host API

`src/host-compatibility.ts` exports:

| Export | Contract |
|---|---|
| `RECIPIENT_CAPABILITY` | Experimental capability key `slackRecipientRouting` |
| `recipientCapability(botUserId)` | Validate identity and create the immutable v1 descriptor |
| `requireRecipientCapability(value, botUserId)` | Refuse absent, partial, mismatched or unsupported descriptor fields |
| `createRecipientHostBridge({serverId, ownUserId, accessPolicy})` | Validate host configuration and return an immutable bridge |
| `bridge.initializeCapability` | Descriptor for that configured receiver |
| `bridge.accept(lane, metadata)` | Validate one trusted ingress envelope and return a storage/scheduling decision |
| `freezeRecipientReply(value)` | Validate/copy/freeze `{channelId, threadId}` |
| `recipientPublishParams(reply)` | Produce explicit publication destination fields from the frozen target |
| `recipientTypingMetadata(reply)` | Produce `supportRecipientReplyRoot` status metadata from the frozen target |

The accepted lane names are `channels/incoming` and `push/event`. `accept` returns
`{store: false, triggerInference: false}` for a refused envelope;
`{store: true, triggerInference: false}` for admitted context; or
`{store: true, triggerInference: true, recipientReply}` for an addressed message.
The returned reply is immutable. The host must actually honor those decisions;
the helper does not itself store messages, start/stop a model, compose competing
gates or intercept every output path. Conversation write permission remains an
effect-time connector check, separate from this host admission decision.

The host attaches the canonical `serverId` from its authenticated connection
context before passing metadata to the bridge. Do not trust a payload-supplied
connection name merely because its string matches configuration.

## Admission envelope

Both `channels/incoming` metadata and `push/event` origin carry the same routing
representation. The bridge validates:

- `serverId`, `routingVersion: 1` and configured receiving `botUserId`;
- raw Slack conversation identity, conversation kind and fresh access admission;
- event/message ID, sender identity/kind, genuine mention IDs and, for a permitted
  DM, its verified human counterpart;
- an explicit addressed/context-only verdict and reason;
- the event's immutable reply root, independent of newer arrivals.

The other concrete fields are `channelId`, `messageId`, `replyRoot`, `wakeAllowed`,
`mentionIds`, `senderKind`, `isBot`, `authorId`, `authority`, `isDM`,
`routingReason`, `supportAccess` and, for an addressed human DM,
`dmAuthorizedPeer`. `supportAccess` binds version, raw conversation ID, readable
admission and kind, plus joined-channel membership or a verified DM peer. The
connector obtains authenticated bot identity and team metadata from `auth.test`.
It does not implement an expected-team-ID comparison. Optional
`expectedBotUserId` checks the receiving bot; a routing `namespace` binds the
operator's local state and is not Slack workspace attestation. Neither the
namespace nor the bridge invents a verified workspace field. These local fields
are not a standard MCPL schema.

Missing or inconsistent facts refuse storage/new inference through the bridge.
A malformed envelope must not be reinterpreted as a legacy addressed message.
Diagnostics may identify the failed contract field without printing message
bodies or credentials.

The connector's durable deduplication state is bound to its receiving identity.
Admission should record an event before delivery. This provides at-most-once
admission, not exactly-once inference or external effects: a failure after that
record can leave an unanswered event. Do not delete receipts or replay messages
to compensate automatically.

## Context-only behavior on both lanes

The composition must exercise opened-channel delivery and push delivery from an
unopened channel. For each lane, a valid readable context-only message:

1. Reaches the correct agent's context/history exactly as the host's storage
   contract specifies.
2. Creates no inference request, new turn, provider call or deferred wake merely
   because it arrived.
3. Does not clear reply suppression, acquire conversational/addressing status,
   repin the active locus, or replace an active reply/status destination.
4. Remains context-only after queueing, coalescing, busy handling and restart
   boundaries covered by the host's lifecycle contract.

An already authorized turn may read newly stored context during its existing
continuation. This is not a promise that context cannot influence that turn;
the guarantee is that context alone does not schedule or authorize a new one.
Tests must distinguish an active continuation from a newly started turn.

The host must gate before invoking its inference scheduler. Merely passing a
`wakeAllowed: false` field through the connector, or checking only one delivery
lane, is insufficient. Hosts with a second gate/debounce callback must either
compose it explicitly with a deny-preserving rule or reject that configuration.
An unrelated non-Slack connection retains its separately configured policy.

## Frozen prose and status target

At the start of an admitted turn, the host creates an immutable reply target
containing the receiving connector, conversation ID and explicit thread root.
The first contract version should support only the target forms actually
implemented and tested. Current deployment-derived behavior selects a thread
root; support for an intentional top-level `null` target is a separate protocol
decision, not an inferred fallback.

The framework must retain that target in queued inference requests, active-turn
state, tool-result continuations, context-budget restarts, guarded retries and
any output segmentation. Automatic prose publication and typing/status must
both use that same target. New arrivals, other channel traffic or a failure in
the original thread cannot redirect the output.

The connector must recheck write/access permission and validate a supplied
thread root before effects. If the parent is missing, deleted, malformed or
cannot be verified, refuse publication/status rather than choose the newest
message or top level. A Slack timeout may leave an uncertain outcome; it does
not authorize an automatic duplicate write or a different destination.

Explicit tools such as `reply_message` and `send_message` retain their explicit
caller-selected destinations and their own access checks. An immutable automatic
reply target does not silently rewrite those tools.

## Relationship to RFC-011 and PR #20

[PR #20](https://github.com/anima-research/slack-mcpl/pull/20) proposes exact
publication targets, including explicit top-level `null`, target refusal and
echo/declaration behavior. At the 2026-10-17 audit its head was `7afe8df`, it was
open and conflicted with current main. Its recorded approval was for an earlier
head. This contract does not merge it or claim its full behavior is implemented.

The common direction is that the host chooses an exact target and the connector
honors or refuses it. Before composing the two, reconcile field names, supported
target forms, per-channel capability declarations, definite refusal versus
uncertain outcome, echo validation and Request/Notification handling. Do not
advertise RFC-011 exact-target support from a local frozen-thread helper alone.
Preserve any documented legacy behavior for callers that have not opted in.

## Compatibility evidence required

Record exact connector, host, framework, MCPL package, runtime and bridge versions
with the composition result. A version-range claim needs tests at its supported
boundaries. A hash-verified patch to one installed framework establishes evidence
for that patched artifact only; it does not prove compatibility with all releases
sharing the same package version.

| Check | Required observation |
|---|---|
| Missing/false negotiation | Opted-in profile refuses activation before event-driven inference/effects |
| Identity/access mismatch | No new turn or Slack effect; no authority upgrade |
| Both delivery lanes | Addressed messages may request a turn; context-only messages are stored without new inference |
| Busy/queued turn | Context/newer traffic does not repin, unsuppress or schedule a fresh turn |
| Continuations/retries | Frozen target survives tool results, budget restart, retry and segmented prose |
| Status | Typing start/refresh/stop refers to the frozen target; missing target cannot use a latest-message fallback |
| Parent failure | Deleted, non-parent or unverifiable root refuses effects |
| Read-only conversation | Addressing cannot widen writes or redirect to an allowed channel |
| Authority spoof | Text/display-name claims do not become owner identity |
| Reconnect/restart | Identity-bound receipts persist without replay or destructive state migration |
| Non-Slack connection | Its independent scheduling/output policy remains unchanged |

Composition tests must run the real host/framework message and output paths with
mock Slack/provider boundaries. A connector stub that directly calls its own
predicate cannot establish these guarantees. Include red-first evidence for the
critical scheduler and target-preservation regressions. Live Slack and paid model
verification, if not separately authorized and performed, remain explicitly
unverified.

## Implementation record

This record distinguishes completed connector/example tests from unperformed
real-host migration. It is not a declaration that a stock framework is ready.

| Item | Exact value / evidence |
|---|---|
| Public bridge entry point and exports | `src/host-compatibility.ts`; listed above |
| Opt-in and acknowledgment fields | MCPL 0.5 `experimental.slackRecipientRouting`, descriptor v1; connector echo after validation |
| Versioned envelope schema | `routingVersion: 1`; concrete fields above and implementation validation |
| Tested executable/test revision | `ff16866daafba274f949b62d1fcbfe73c512e9d6` |
| Companion real host/framework commits | **Not implemented/qualified by this connector branch.** Require a reviewed migration connecting the bridge to actual hooks before rollout. |
| Tested runtime/package versions | macOS/Linux Node 24.14.0/npm 11.9.0; unflagged macOS legacy floor Node 22.12.0/npm 10.9.0; unchanged locked dependencies listed in CONSOLIDATION.md |
| Connector and helper tests | Nine host-helper tests and eight real connector/in-memory transport integration tests; complete Node 24 suite 360/0; legacy floor 340/0 plus 20 advanced-only skips |
| Negative negotiation | Missing MCPL, missing/partial/other-recipient descriptor refused before registration; ordinary upstream handshake regressions retained |
| Frozen typing authorization | Root verified; stale stop cannot clear another turn; pending effects recheck connection, policy generation and capability after asynchronous checks |
| Example host versus real host | Both lanes tested through actual connector envelopes and bridge; queue/tool/retry/budget carry demonstrated in synthetic embedding. Actual host/framework lifecycle remains unqualified. |
| Live Slack/provider or deployed-host verification | **Not performed.** Tests use synthetic Slack/provider boundaries; no live pin, service, credentials or agent state changed. |
