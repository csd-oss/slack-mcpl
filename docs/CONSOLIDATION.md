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
5. **Optional filesystem path uploads, separately.** The v1 evidence branch
   records the original `a2a2015` local boolean opt-in with capped Node FD reads
   but no directory containment. That is historical evidence, not the current
   v2 API or a claim of restricted-path safety.

   The owner-approved v2 branch adopts the separate path PR's explicit
   `pathUploads` / `SLACK_PATH_UPLOADS` policy: restricted directory capabilities
   or an explicit unrestricted mode. The old boolean options produce migration
   errors. Both modes retain the 5 MiB cap and `comms` + `files` classes, while
   omission remains inline-only. The exact same reader is used in the separate
   path proposal; restricted mode needs optional Python 3.9+ standard-library
   support, pins roots, uses no-follow descriptor traversal, and checks the actual
   file descriptor's path before and after reading. Unsupported confinement is
   refused, never downgraded to unrestricted access. This is an adoption on a new
   branch, not a rewrite of `a2a2015` or of v1's previous numerical evidence.

   Path handlers preflight the destination before reading and revalidate it at
   upload time. Generic access, DM, grants, disabled tools and recipient-host
   safeguards stay composed. Keep this path proposal separate from inline #26.

Pending #15/#29 work may require later composition tests because it changes ack,
listing, registration or retry paths. Do not claim a clean historical merge-tree
result still proves compatibility after any of these heads changes.

## Per-commit coverage record

The implementation base is upstream `df218e1905c9a30f3fc9075469894c8c0d057754`.
Fresh public ref/PR checks at **2026-10-17 23:10:20 UTC** found the same upstream,
fork and six open PR heads as the earlier audit. No remote branch was changed.
The final executable/test revision is `ff16866daafba274f949b62d1fcbfe73c512e9d6`;
subsequent commits document it and remove one trailing blank line. All 19
compiled connector JavaScript files remain byte-identical to that tested revision;
the six path-option tests and build were rerun after the whitespace cleanup.

| Candidate commit | Source coverage / proposed review group | Behavior and boundary | Verification |
|---|---|---|---|
| `df218e1` base | Merged #1/#2/#3/#13/#27 and newer upstream fixes | Existing protocol, controls, headers, origin and error behavior retained by ancestry | Baseline 223 pass / 0 fail |
| `0e664d4` | Open #12, exact source head `bdfaab7` | Generic status feature; no claim of maintainer approval | Combined reviewed baseline below |
| `d982bca` | Open #25, exact source head `6d59174` | Net reviewed readable-type, empty-type, diagnostic and scope-refresh behavior | Combined reviewed baseline below |
| `feb2e4f` | Open #26, exact source head `da4555c` | Net reviewed inline-only upload/rollback/result validation and #27 posting classification | Clean combined baseline: 262 pass / 0 fail; build/typecheck pass |
| `74acea2` | New companion host-contract proposal | Versioned attestation, strict ingress decisions, frozen target helpers; no stock-host qualification | Nine host-helper tests; real connector composition added later |
| `ab6a1a1` | Review documentation | Initial contract and split; corrected by `ced6eac` | Documentation only |
| `3bd49c2` | New access/file-reference proposal from local `f189c64`, `4a6180e`, `f73519f`, `96d9cb7` | Explicit fresh access/DM checks, canonical associated attachments, bounded download and usable file IDs; no path enablement | Red-first access tests: 0/29 before feature; focused extraction/fallback suite later 58/0 |
| `8dff5b0` | New optional recipient/dedup proposal from deployment routing | Identity-bound private SQLite receipts, generic namespace/policy, provenance; no quotas/arming/expiry | 14 routing tests on Node 24 |
| `ae6dc42` | New narrow membership-proof proposal from local `0db196a` | Fresh history proof for an operator-pinned public write channel; does not grant scope or infer publicness from IDs | Focused extraction/fallback suite 58/0 |
| `1c09b7c` | Routing compatibility follow-up | Retains existing U-prefixed identity contract; no accidental identifier widening | Included in final runtime matrix |
| `a2a2015` | Separate optional bounded-path proposal | Default inline-only; opt-in capped regular-file FD reads, symlinks allowed, no directory boundary; files class only on opt-in | Path/upload/class group 28/0; clean extraction snapshot 349/0 |
| `ced6eac` | Review documentation correction | States path upstream approval blocker; separates history proposals and workspace claims | Documentation only |
| `15c60af` | New configurable recipient connector integration | Actual adapter/server/CLI use ordinary modules; both lanes, explicit host negotiation, tool suppression, frozen publication/status | Targeted configuration/host/integration suite 17/0 before later regressions |
| `6808bbb` | Integration regression fixture | Accept Slack-shaped parent with thread_ts equal to ts; refuse child-as-root | Integration suite 6/0 at this point |
| `ff16866` | Recipient typing lifecycle fix | Discard queued/asynchronous typing after connection or policy-era changes; preserve same-root stop semantics | Integration suite 8/0; independent scope/queue race probes produced no stale effects |
| `d4bc353` | Setup/migration documentation | CLI options, private receipt namespace and real-host migration boundary | Documentation only |
| `4e02ba2` | Optional historical review harnesses | Parameterized external baseline/manifest/channel inputs; no deployment IDs or live calls | 15 parity and six intentional-contract cases; see evidence |
| Excluded | Open #15 / #20 / #29 | No implicit merge; switch changes, RFC-011 reconciliation and retry/rate-limit work remain separate | Future composition runs required; #29 hold remains in force |

All feature commits carry changelog coverage and coauthor attribution. Source
commits are coherent extraction/adaptation commits, not a claim that all original
PR head SHAs are ancestors. Commit bodies retain exact source heads and coverage.

Final clean installs used the unchanged package lock, SHA-256
`28c37590f6e1e8f6f1716db178838006d27f73c32b3151872c3860fffe6a7e76`:
Node 24.14.0/npm 11.9.0 on macOS arm64 and Linux x64 each passed **360 tests,
0 failures**, typecheck and build. The exact unflagged legacy floor, Node
22.12.0/npm 10.9.0 on macOS, passed **340 tests, 0 failures**, with **20 explicitly
skipped advanced-only tests**. Durable recipient mode refuses Node versions
below 24; importing/using legacy mode does not load SQLite. No dependency or
package version was changed. Locked core is 0.3.0, Slack Web API 7.19.0,
Socket Mode 2.0.7, TypeScript 7.0.2 and tsx 4.23.1.

The host tests include real connector protocol envelopes and a synthetic host
bridge. They do not qualify an actual Connectome/framework scheduler, provider
continuation or independent background wake path. Those real host composition
runs remain a rollout prerequisite, recorded in HOST-COMPATIBILITY.md.

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

## Exact proposed upstream sequence

No PR creation, branch publication or comment is performed by this plan.

| Proposed action | Candidate source | Dependency / scope |
|---|---|---|
| Request re-review of existing #12, #25 and #26 | `0e664d4`, `d982bca`, `feb2e4f` and original current PR heads | Preserve three existing submissions; do not create duplicate replacement PRs. Refresh stale descriptions only when separately authorized. |
| New optional access-policy PR | Access/DM/scope portion of `3bd49c2` | Build on accepted reviewed feature baseline; keep no-policy defaults. Split this extraction commit for upstream review without rewriting this local evidence branch. |
| New associated-file safety/reference PR | File/download/reference portion of `3bd49c2` | Depends on the access-policy API; exact file/share/canonical URL checks and file IDs, no local paths. |
| New operator-pinned membership-proof PR | `ae6dc42` | Depends on access policy; explicit trusted public pin, fresh history proof, no scope manufacture or ID-prefix publicness claim. |
| New optional recipient/provenance/dedup PR | `8dff5b0`, `1c09b7c`, connector/config portions of `15c60af` | Node 24 durable mode, typed options, private identity-bound receipts, generic policies; keep legacy startup at Node 22.12. |
| Companion host contract and frozen targets | `74acea2`, remaining `15c60af`, `6808bbb`, `ff16866` | Must declare companion real host/framework work. Reconcile naming/semantics with open #20 RFC-011; do not assert this local extension is standard or that #20 is merged. Connector fail-closed handling can land before a real host is qualified. |
| Separate optional path fork proposal | `a2a2015` historical v1; explicit-mode adoption on v2 | Depends on inline upload; disabled by default. V2 adopts restricted-directory and explicit-unrestricted modes from the separate path proposal, sharing its descriptor-checked reader. Preserve v1 history and do not include this in inline #26. |
| Documentation and test follow-ups | `ab6a1a1`, `ced6eac`, `d4bc353`, final evidence commit | Fold each document/test into its corresponding future PR; preserve numerical evidence and limitations. |

Do not update fork main until the owner reviews this exact local diff and plan.
After review, the main fast-forward and any proposed branch publication remain
separate actions. A new immutable connector release would remove the need for
connector text transforms; deployments would supply only version pins, policy,
credential references and private state. Host patch removal requires a separately
published compatible host/framework release or tested adapter. No live pin changes
follow automatically from any future source merge.

## Behavior parity and evidence limits

[review-evidence.json](review-evidence.json) records exact runtimes, commands,
receipt/log checksums, public refs and named semantic cases. Reconstructing the
historical baseline on Linux matched **all 193 compiled files** of manifest
`d59d9e0dcc7ca2306a9993cba7e991cdbc9dda6deeac6e184b6c80e885d07757`
and passed **328 tests**. The Mac reconstruction matched the other 192 files,
with only nonexecuted TypeScript build-cache metadata differing.

The candidate passed **15/15 differential cases** and **6/6 intentional-contract
cases** on both Mac and Linux Node 24. The exact Node 22.12 floor passed **2/2
legacy trace comparisons** and **3/3 floor/default-path contracts**. Comparisons
cover legacy tools/self filtering; joined/read-only/unjoined/private access;
missing scopes/revocation; both routing lanes/frozen publication; DM admission;
upload validation and optional bounded paths; file references/protected downloads;
tool/schema policy; frozen typing; mixed rollback; unknown sender admission before
dedup; and durable restart with untouched legacy budget rows.

Intentional differences are separately asserted: explicit host capability
attestation, inline-only default with path opt-in, generalized namespace/multiple
channels, independent DM-only policy, richer provenance fields, and root-bound
status that cannot survive an invalidated connection/policy or clear another
turn. No arming/count/expiry gate, stale automatic target fallback or unbounded
SDK path handoff was restored.

The semantic matrix normalizes only the baseline installation channel to a
synthetic identifier. It does not assert every error string/tool description or
prove equivalence for all possible inputs. Connector unit and real in-memory
protocol tests add negative negotiation, official Slack parent shaping, child-root
refusal, read-only effects and policy/connection race coverage. Real framework
storage/scheduler/continuation integration remains a separate prerequisite.

All tests use synthetic accounts/messages and mock external boundaries. No new
credentials, permission grants, client histories, provider calls, service changes,
pushes or upstream PR writes were performed. A redacted Gitleaks 8.30.1 commit
scan found zero findings; known installation identifiers were absent from changed
source/tests/docs. The actual live manifest was used as a historical verification
fingerprint, not as permission to access an agent's writable state.

The parameterized review harnesses are included in
[scripts/validation](../scripts/validation/README.md). They take the verified
historical source/manifest and its installation anchor externally; no historical
private identity is embedded in public test code. They fingerprint source inputs,
require a supplied manifest checksum, and write reports outside the repository.
They do not independently certify arbitrary baseline source; the reconstruction
and manifest evidence above provides that separate link for this review.

## V2 explicit path-policy adoption

`review/consolidated-connector-v1` remains at its prior evidence revision. The new
`review/consolidated-path-uploads-v2` branch starts at `bb74c6b`, merges upstream
`e1e1d7b` (test-only PR #30) additively, and replaces only the draft path API.
Earlier counts and receipts in this document describe v1 and must not be reused
as v2 test claims. The optional differential harness maps only the historical
baseline to its old boolean API; the candidate explicitly selects unrestricted
mode for that existing parity scenario. This does not enable a deployed service.

See README for the current optional-Python contract, input policy and migration.
No live source, token scopes, recipe, stored state or deployment was changed.
