# Fleet Release Eligibility

Require a verified, qualified runtime before any fleet upgrade mutates repositories.

**Activation:** Add a consumer-owned `.code-foundry-release-policy.json` at the
fleet root.

The public fleet upgrade command applies an optional release-eligibility guard
before it mutates repositories. No policy file means existing fleet behavior. A
malformed or symlinked policy is an error, not an opt-out. Dry runs use the same
guard, and `--force` cannot bypass source identity or qualification.

```json
{
  "schema_version": 1,
  "repository": "owner/code-foundry",
  "workflow": ".github/workflows/release_self-ci.yml",
  "branch": "main",
  "required_jobs": ["Qualify consumers / Node 24", "Qualify consumers / Node 26"]
}
```

This is a shape example, not a completed fleet policy. Populate canonical repository
identity, actual workflow path, and exact job names from the qualified release
caller's Actions API results. Include the publication job when successful registry
publication is required before adoption. Require every relevant job: a workflow's
aggregate success alone can conceal skipped jobs. The producer-side qualification
and verified-publication workflows provide the evidence this policy consumes.

Keep the policy alongside the **consumer workspace's** fleet inventory. Do not put
private repository names, local layouts, or deployment credentials into this
reusable baseline. Commit policy changes for review; the guard does not secretly
change branch protection, environments, rollout cohorts, or required capabilities.

## What is verified

The proposed runtime must be a clean Git source checkout. Its exact HEAD must
match the cryptographically verified immutable release tag. An installed npm
package without Git metadata cannot substitute for a verifiable source checkout;
use the existing `--source` option with the checked-out release. The verifier comes
from the trusted running Foundry installation, not the unverified candidate.

The guard resolves the configured workflow's identity, retrieves every page of
runs for the exact source, and selects the latest matching protected-branch push
or manual run. It rejects pending/failed/cancelled runs, fork provenance, disabled
workflows, missing/ambiguous/skipped jobs, and incomplete pagination. An older
success does not override a newer failed run. Job evidence comes from the precise
run attempt; that attempt is rechecked before proceeding. Source HEAD, cleanliness,
and the policy's bytes are rechecked before the upgrade callback executes.

Successful eligibility emits JSON to stderr with source SHA, policy digest,
workflow/run/attempt identifiers, and required job names. It does not write an
approval into the source or silently make PRs ready. Existing resumable rollouts,
canary validation, draft creation, and provenance markers stay in the original
fleet engine. The guard is policy enforcement in the supported public entrypoint,
not a sandbox against someone intentionally importing private implementation files
or using Git directly. Normal credentials still determine what remote mutations
are possible after eligibility passes.

## Activation and validation

First release and validate the qualification/verification producer and confirm
real workflow/job identities. Then opt a consumer workspace into this policy and
exercise `fleet upgrade --dry-run --root <fleet-root> --source <clean-release-checkout>`.
When `--source` is omitted, the installed package is used and an enabled policy
will reject it unless that installation is itself a clean Git checkout. Older
mutable releases or unavailable permissions should fail; do not weaken the policy
just to make an old release eligible. No real fleet inventory is created by the
eligibility guard.

The focused suite verifies guard ordering and failure propagation with GitHub/CLI
fixtures. Live authenticated verification, exact production job naming, and the
full fleet-engine suite should pass before activation. The guard is not a
substitute for repository import, type-check, packaging, or deployment
validation.
