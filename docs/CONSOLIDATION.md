# Connector consolidation plan

This branch is a local review candidate. It is not an upstream merge, a published
release or deployment approval. Consolidation should make source provenance,
operator policy and host requirements reviewable without carrying an
installation's identities, private paths, credentials or history into the public
connector.

## Starting evidence

The 2026-10-17 PR audit found 21 upstream PRs and no PRs against the owner fork.
Seven upstream submissions came from that fork: #1, #2, #3 and #13 were merged;
#12, #25 and #26 remained open. The three open owner heads had clean mergeability
and six successful checks each. Those facts are not maintainer acceptance of
their current implementation.

| Work | Recorded public state | Consolidation treatment |
|---|---|---|
| #1 MCPL grant handshake | Merged | Preserve upstream implementation and its history |
| #2 thread/message headers | Merged | Preserve upstream behavior and tests |
| #3 operator write/DM/ack/subscription controls | Merged | Preserve existing defaults; make any policy change explicit |
| #13 MCPL push-origin channel | Merged | Preserve; do not duplicate its fix under a new name |
| #12 thread typing status, `bdfaab7` | Open | Isolate status implementation and tests; preserve write/grant guards |
| #25 scope-aware listing, `6d59174` | Open after review fixes | Isolate empty-type, omission diagnostic, scope-refresh and matrix coverage |
| #26 inline uploads, `da4555c` | Open after review fixes | Preserve inline-only head, rollback/validation/error tests and required filename |
| #27 Slack error explanations | Merged as `df218e1` | Reconcile upload error/posting classification with the merged baseline |
| #15 ack cleanup and empty switches | Open, `9a2e49f` | Do not describe as merged; operator-visible switch changes need separate review |
| #20 exact publish target | Open, `7afe8df`, conflicts at audit | Reconcile design in a companion plan; do not merge or advertise full RFC-011 support here |
| #29 rate limits, timeouts and no automatic write retry | Open, `dc62d52` | Separate pending work, not part of the accepted baseline |

The owner PR bodies for #25 and #26 were stale at audit time. In particular #26's
body still advertised a path argument while its current history includes an
additive path revert. Use the actual commit/tree and review findings, not that
description, to identify scope. Correcting a public description or replying to a
review is a separate authorized external action.

For #29, the author's stated hold was no merge before **2026-10-18 05:00 UTC** and
successful pre-merge checks, with a maintainer request to wait taking precedence.
Local analysis does not waive that hold. This plan performs no merge or remote
operation for #15, #20 or #29. Their state must be refreshed before any future
external action.

## Separate source behavior from installation policy

The connector may expose reusable access checks, authenticated provenance,
durable admission and exact effects. Allowed channels, DM peers, receiving bot
identity and owner authority are supplied by trusted operator configuration.
Do not embed real installation IDs or use chat text to populate trusted policy.

The deployment-derived context and frozen-target behavior crosses a host boundary.
It cannot be made portable by transplanting connector code or setting readiness
environment variables. [HOST-COMPATIBILITY.md](HOST-COMPATIBILITY.md) defines the
explicit opt-in bridge requirements and the composition evidence needed before
claiming support. Stock-host compatibility remains unverified until tested.

An installation's versioned connector artifact fingerprint is provenance metadata,
not a source commit, release version, permission grant or compatibility proof.
Map deployed bytes back to source/patch inputs; do not substitute an artifact
label for that mapping. Preserve original source and test commits when possible,
and document changed behavior when a reviewed adaptation is necessary.

## Proposed review groups

Each group should remain a coherent, testable change with a numerical baseline,
red-first regression evidence where meaningful, a changelog fragment when behavior
changes, and explicit merge-order guidance for companion host work.

1. **Scope-aware conversation listing.** Preserve #25's original premise and
   review fixes: zero-call empty types, omitted-type diagnostics, refreshed scope
   observations and a scope/DM-mode test matrix. This should not import a new
   installation access model incidentally.
2. **Inline uploads and messaging rollback.** Keep #26 inline-only. Cover handler
   cardinality/filename/size checks, canonical base64, empty content, missing or
   malformed returned IDs, DM/write guards, acknowledgement clearing, feature-set
   membership, mixed rollback and partial failure. Integrate #27's error and
   posting classifications. Keep the scope/reinstall instructions accurate.
3. **Typing/status.** Preserve #12 independently. Define destination behavior,
   refresh/clear semantics, write/grant checks and host requirements. Coordinate
   its target handling with the opt-in bridge rather than conflating a status
   signal with owner authority or a new turn.
4. **Reusable access/provenance and host bridge.** Review the generic policy and
   typed bridge with companion host/framework commits. Test both delivery lanes,
   context-only scheduling, frozen prose/status, queues, continuations and retries.
   Make the profile refuse activation when the bridge is absent or incompatible.
5. **Optional filesystem path uploads, separately.** The local fork proposal
   preserves the operator-approved behavior: `allowFilePaths: true` (CLI
   `SLACK_ALLOW_FILE_PATHS=true`) enables bounded reads of regular files through
   an open file descriptor, with symlinks allowed and no configured-directory
   containment boundary. Ordinary OS permissions determine what it can read.
   The default stays inline-only; enabled uploads remain capped at 5 MiB and
   carry both `comms` and `files` classes. Keep this option out of the inline
   #26 PR and map its local commit/test evidence separately.

   The #26 reviewer requested a narrower upstream path proposal: explicit
   operator opt-in to a readable root, resolved containment including symlink
   escape prevention, regular-file checks, the same size cap and both classes.
   The missing containment is an **upstream approval blocker for the optional
   path proposal**, not a claim that this local option implements it. Imposing
   that new restriction would change the approved deployment behavior and needs
   its own decision; consolidation must not silently add it.

Pending #15/#29 work may require later composition tests because it changes ack,
listing, registration or retry paths. Do not claim a clean historical merge-tree
result still proves compatibility after any of these heads changes.

## Per-commit coverage record

The consolidation owner must replace `PENDING` with final values. An integrated
tree can include a fix through ancestry or an adaptation; record which, and do
not label a patch equivalent without verifying the behavioral delta.

| Candidate commit | Source PR/commit or local proposal | Behavior retained/changed | Regression tests and numeric result | Upstream/host boundary | Review state |
|---|---|---|---|---|---|
| PENDING | Upstream baseline and merged #1/#2/#3/#13/#27 | PENDING ancestry verification | PENDING baseline pass/fail | Existing connector contract | Merged source; candidate composition pending |
| PENDING | #25 `6d59174` | PENDING exact retained/adapted listing behavior | PENDING pass/fail and red-first case | Connector-only unless explicitly changed | PR open |
| PENDING | #26 `da4555c` | PENDING inline-only validation/rollback/error delta | PENDING pass/fail and handler regression | No filesystem path | PR open |
| PENDING | #12 `bdfaab7` | PENDING status/target delta | PENDING pass/fail | Host typing behavior required | PR open |
| PENDING | Local reusable policy/provenance proposal | PENDING configuration/default changes | PENDING pass/fail | Versioned trusted configuration | New local proposal |
| PENDING | Local bridge + companion host/framework | PENDING scheduler/target ABI | PENDING both-lane composition counts | See host compatibility record | New local proposal |
| PENDING | Local optional path-upload commit | Default inline-only; opt-in bounded regular-file FD reads, symlinks allowed, no directory boundary | PENDING path/type/size/default/class regression counts | Separate from inline #26 | Local fork proposal; upstream containment request unresolved |
| Excluded | #15 / #20 / #29 pending upstream work | No implicit merge | Future composition runs | Breaking switches / RFC-011 / retry policy | Open at audit |

For each final group, also record exact Node/Bun/package versions, artifact inputs,
commands run, baseline/candidate failure counts, mocked external boundaries and
live checks not performed. An assertion that tests passed without counts or a
connector test that bypasses the host scheduler is incomplete evidence.

## Historical agent customizations

Agent-specific branch history is evidence for feature proposals, not an instruction
to import every historical feature or private knowledge bundle. A retained commit
can be already upstream, superseded, equivalent to a later patch, intentionally
disabled or unreviewed. Name that disposition before proposing a transplant.

Propose each remaining reusable behavior with a minimal public reproduction,
explicit operator defaults and tests. Do not import prompts, conversation/session
stores, memory, credentials, account identities, bridge target registries or
deployment-specific administrative access. No permanent persona or new external
identity follows from consolidating source.

## Recommended history and search PR plan

These are proposals for reusable features suggested by historical agent work.
They are not implemented by this documentation change, part of the current host
ABI, or authorization to import an agent's history. Use separate small PRs with
the following boundaries and tests.

1. **Preserve author/thread metadata without additional API calls.** Carry the
   stable author user ID, message ID, thread root and `replyCount` from fields
   already present in incoming/history/thread responses. Preserve existing
   display text alongside structured metadata; do not infer identity from the
   display name. State whether a root was explicitly reported or derived from
   that message's own ID, and omit/mark unknown reply counts when Slack did not
   provide them rather than inventing zero. Test root messages, replies,
   broadcasts, missing authors/counts and parity across live/history rendering.
   This group must make no extra user lookup, thread expansion or search calls.
2. **Bounded filtering over an explicitly authorized conversation read.** Start
   with documented substring matching and exact author-user-ID filtering, not
   display-name matching or an unbounded workspace search. Define case/Unicode
   behavior and ordering. Independently cap `maxScanned`, `matchLimit`, elapsed
   time, returned bytes and page/API work, so a rare match cannot scan forever.
   Return scanned/matched counts, a truncation/stop reason and an opaque cursor
   bound to the conversation and filter. Resume must recheck access and preserve
   those bounds; a cursor is not an authorization token. Test no-match, dense
   matches, oversized text, page boundaries, changed/revoked membership and
   cursor/filter mismatch. Results are tool-read output, not replayed incoming
   events or wake requests. An optional regex mode should use a deliberately
   bounded safe engine such as RE2 with pattern/input caps; do not quietly expose
   unrestricted JavaScript regular expressions.
3. **Structured write-policy context using existing `writable`.** Expose the
   existing `writable` result consistently in listing/history tool envelopes so
   the caller can distinguish readable context from a permitted destination.
   Reuse the current policy computation and label it as an informational hint;
   the write path must still perform its fresh scope/membership/destination
   checks. Do not add a parallel permission store, infer write permission from
   read success, widen allowed destinations or start a response from this
   metadata. Test that a read-only result stays read-only after rendering and
   that stale hints cannot bypass effect-time checks.
4. **Thread expansion and server-side search as separate proposals.** Expanding
   roots into replies adds API fan-out; workspace/server search may require a
   different Slack method, token type, scopes or owner authorization. Determine
   those requirements from the current official API before proposing a route;
   do not assume the existing bot credential grants search. Explicitly cap root
   count, replies per root, total requests, bytes, wall time and continuation
   state; check access on every conversation and support cancellation. Specify
   partial results and rate-limit handling without hidden background scans or
   silent OAuth expansion. Keep this group separate from no-call metadata and
   local bounded filtering so each can be reviewed independently.

Each proposed PR needs a baseline/candidate numerical test record and an explicit
statement of Slack/host behavior not verified live. None adds message sends,
new credentials, automatic thread crawling or a new external identity.

## Handoff boundaries

The candidate is ready for review only after its per-commit record and exact
bridge implementation record are filled, the target runtime matrix passes, and
unverified behavior is stated. Publishing a branch, creating/updating PRs,
commenting, merging and deploying remain separate actions with their own scope.
Code rollback must not reset persistent admission receipts, conversation history
or agent memory. This documentation change performs none of those actions.
