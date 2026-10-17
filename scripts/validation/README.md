# Optional historical regression validation

These mock harnesses are explicit review tools, separate from `npm test`. They
do not start the connector entry point, contact Slack or a model, or load agent
state. Temporary ledgers contain synthetic events. They require Node 24 for
advanced routing; the candidate's legacy floor can be checked on Node 22.12.

Install dependencies in both source trees with `npm ci --ignore-scripts` first.
The historical source tree must already have been independently reconstructed
and verified against its reviewed manifest. It must contain `src/`,
`test/harness.ts` and the historical `src/support-routing.ts`. The harness
verifies the supplied manifest fingerprint, but does not reconstruct or certify
an arbitrary baseline source tree for you.

Provide these values externally:

- `BASELINE_SOURCE`: verified historical source directory.
- `BASELINE_MANIFEST` and `BASELINE_MANIFEST_SHA256`: its reviewed manifest and
  SHA-256, obtained through a trusted review process.
- `BASELINE_CHANNEL_ID`: the historical fixture's channel anchor. This value is
  mandatory and is replaced with a synthetic label in generated traces.
- `PARITY_REPORT`: a new output file outside the repository.

Export `BASELINE_CHANNEL_ID` so the Node process receives it. The other values
are command arguments; no deployment identifier belongs in this directory.

From the candidate source root, run:

```sh
node --import tsx scripts/validation/differential.mjs \
  "$BASELINE_SOURCE" . "$PARITY_REPORT" \
  --baseline-manifest "$BASELINE_MANIFEST" \
  --baseline-sha256 "$BASELINE_MANIFEST_SHA256"

node --import tsx scripts/validation/intentional_contracts.mjs \
  . "$CONTRACT_REPORT"
```

The differential checks legacy tool behavior, access separation, both MCPL
delivery lanes, recipient provenance, deduplication and restart, frozen targets,
uploads and rollback, and protected attachment references/downloads. It compares
semantic outcomes and effects, rather than asserting full error wording or
description equality. Source fingerprints must remain unchanged during a run.

Deliberate changes are tested separately: the explicit host capability
attestation; generic namespaces and multi-channel policies; independently
authorized DMs; local paths disabled by default and bounded when enabled; and
verified typing roots for both start and stop. A stale or rootless stop must not
clear a newer turn's status. These stronger refusals are not historical parity
expectations.

For the exact legacy floor, first create a successful Node 24 differential
report, then compare only the legacy scenarios on Node 22.12. The `--oracle`
option reuses the verified Node 24 baseline traces so the historical routing
module does not need to load SQLite under Node 22:

```sh
node --import tsx scripts/validation/differential.mjs \
  "$BASELINE_SOURCE" . "$LEGACY_REPORT" \
  --baseline-manifest "$BASELINE_MANIFEST" \
  --baseline-sha256 "$BASELINE_MANIFEST_SHA256" \
  --legacy-only --oracle "$PARITY_REPORT"
```

Keep historical inputs and generated reports outside this repository. Results
qualify the named synthetic cases, not every possible Slack event or a real
host deployment. A host advertising the capability still needs separate review
of its storage, wake gating, provenance, and frozen-target integration.
