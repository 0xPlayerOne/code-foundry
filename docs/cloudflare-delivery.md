# Verified Cloudflare delivery

The opt-in `cloudflare-delivery.yml` workflow builds and uploads a candidate,
validates its actual version bindings, runs an HTTP smoke probe and the required
repository-owned verification command, then promotes **that version ID** after
GitHub environment approval. Production promotion uses the Cloudflare deployment
API and never rebuilds the application. The existing `cloudflare-deploy.yml`
remains available for direct deployments and initial provisioning.

## Adoption

Call the new reusable workflow using an immutable, reviewed 40-character Code
Foundry commit SHA and pass the same `runtime-ref`. Required inputs are
`worker-name`, `artifact-path`, and `verify-command`.

```yaml
jobs:
  delivery:
    # Replace REVIEWED_SHA with the same reviewed 40-character SHA in both places.
    uses: 0xPlayerOne/code-foundry/.github/workflows/cloudflare-delivery.yml@REVIEWED_SHA
    permissions:
      contents: read
      deployments: write
    with:
      runtime-ref: REVIEWED_SHA
      mode: production
      worker-name: company-site
      artifact-path: dist
      verify-command: '["bun", "run", "test:deployed"]'
      production-url: https://example.com
      smoke-path: /health
      canary-percentage: 10
      canary-verify-command: '["bun", "run", "test:canary"]'
    secrets:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

`artifact-path` is relative to `working-directory`; `install-working-directory`
selects the lockfile root. The selected output tree is hashed before and after
upload; changes during upload fail. Include all built code/assets in that tree
and disable duplicate custom build steps. This digest identifies the declared
local build tree, not a Cloudflare-signed digest of every uploaded configuration
field. The Worker version ID is the authoritative identity for promotion.

Wrangler defaults to the installed, lockfile-resolved version. Explicit overrides
must be exact versions, never `latest`, floating majors, or semver ranges. Pin a
Wrangler version supporting `WRANGLER_OUTPUT_FILE_PATH` and version-1
`version-upload` records. Missing preview URLs and output-schema mismatches fail.
Bun remains the installation path, consistent with the existing deploy workflow.

The repository verification command receives `BASE_URL` and
`FOUNDRY_DEPLOYMENT_PHASE` (`candidate`, `canary`, or `production`). It must check
critical journeys, redirects, assets, and application-specific behavior. The
built-in smoke probe requires a successful 2xx response and does not follow
redirects. Deploy credentials are not supplied to verification steps and are
removed from the verification child environment as defense in depth. Install any
browser binaries required by your verification command explicitly.

When `canary-percentage` is below 100, `canary-verify-command` is required and
must prove that the live request served the candidate rather than the baseline.
It receives `FOUNDRY_EXPECTED_VERSION_ID`, `FOUNDRY_DEPLOYMENT_ID`, and
`FOUNDRY_CANARY_PERCENTAGE`; use a version-aware response/header or an equivalent
application check. A command that only observes a successful production URL is
not sufficient.

## Approvals, ordering, and evidence

Create and protect the fixed `Preview` and `Production` GitHub environments
before adoption. The workflow references them at the **job** level; naming an
environment does not itself configure reviewers or branch restrictions. Configure
required reviewers and branch restrictions on `Production` separately. Production
execution requires the current default-branch commit and
rechecks freshness after approval and before final promotion. Fork PRs and
`pull_request_target` execution are excluded.

Per-repository/Worker/mode concurrency never cancels a running promotion. GitHub
concurrency is not a FIFO queue; stale-source rejection is still necessary.
Other deployment systems and dashboard edits are outside this lock. The helper
also checks that its deployment has not been replaced before a subsequent
promotion or rollback, but the Cloudflare API check/write is not an atomic CAS.
Migrate one application to one deployment owner; do not leave competing legacy
and new production workflows active.

Outputs include preview URL, exact version ID, source SHA, declared build-tree
SHA-256 digest, Cloudflare deployment ID, and GitHub application deployment ID.
Explicit application deployment records receive in-progress and success/failure
statuses, in addition to GitHub's environment-job records. Sanitized candidate and
production JSON evidence is uploaded even on failure. Binding values, API bodies,
and credentials are not copied into those reports. Forced runner termination may
prevent final status steps; the GitHub job still reflects cancellation/failure.

## Stateful resources and isolation

Without a policy file, non-resource bindings (for example strings, secrets, and
static assets) are allowed; resource/service bindings fail closed. The uploaded
version's actual bindings are inspected through the Cloudflare API. Durable
Object bindings or exports are rejected: use a repository-specific migration and
preview workflow instead of pretending version preview supports that topology.

A reviewed read-only policy can allow smoke testing a candidate that shares
production resources:

```json
{
  "schemaVersion": 1,
  "readOnlyBindings": [{ "name": "DB", "type": "d1" }],
  "rollbackSafe": false
}
```

Pass its relative path as `binding-policy-file`. This declaration is **not a
sandbox**: the repository owner must ensure its test routes cannot mutate shared
data. A version preview does not automatically create isolated KV, R2, D1, or
service resources, and a GET route can still have side effects.

For separately provisioned preview Workers, `isolatedBindings` entries can compare
the actual binding's resource identifiers with expected preview identifiers and
assert that they differ from declared production identifiers:

```json
{
  "schemaVersion": 1,
  "isolatedBindings": [
    {
      "name": "DB",
      "type": "d1",
      "expected": { "id": "preview-database-id" },
      "production": { "id": "production-database-id" }
    }
  ]
}
```

Use the field names returned for that binding type by the Version API. Resource
provisioning and the correctness of production-identifier declarations remain
repository-owned. Isolated preview bindings are rejected in production mode to
prevent accidentally promoting staging resources. A version from a different
Worker cannot be promoted across Workers; production mode uploads and tests its
own candidate on the production Worker with reviewed read-only tests.

## Canary and rollback policy

A percentage below 100 first routes that share to the candidate, verifies it,
and then promotes the same version to 100 and verifies again. A canary requires
one prior baseline serving 100% and the explicit `canary-verify-command` above.
A single load-balanced HTTP request may hit the old version; the command must
observe the expected version ID. Set `canary-percentage: 100` when that
version-aware observability is not configured.

Automatic rollback is off. Enabling `auto-rollback` also requires an explicit
`rollbackSafe: true` policy and both current and prior versions to be free of
stateful bindings/DO exports. The policy must additionally account for external
side effects that binding inspection cannot detect. Rollback restores the exact
previous traffic split only when this run's deployment is still current. Failure
remains a failed deployment even after rollback. Resource data, migrations,
external API side effects, routes, and non-versioned settings are never rewound.
The evidence file records prior versions for manual recovery when automation is
unsafe or unavailable. Recovery itself must be verified operationally.

This workflow targets already-provisioned Workers with version previews enabled.
Manage initial Worker/route/trigger setup and non-versioned settings separately;
the deployment API intentionally changes version routing only.

## Legacy workflow hardening

`cloudflare-deploy.yml` now uses real job environments, non-cancelling concurrency,
structured Wrangler output, exact/local Wrangler selection, reusable outputs, and
in-progress/failure deployment records. Its legacy-compatible default remains
`latest`; callers should prefer `local` or an exact version for reproducibility. A
production URL can be supplied with `deployment-url` when API output contains only
route patterns. It is still a **direct, unverified deployment**; adopt
`cloudflare-delivery.yml` for candidate verification and guarded promotion.

## References and testing

The implementation follows Cloudflare's structured Wrangler output and version
routing APIs:

- https://developers.cloudflare.com/workers/wrangler/system-environment-variables/
- https://developers.cloudflare.com/workers/versions-and-deployments/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/

Run `node --test test/cloudflare-delivery.test.mjs`. Tests use deterministic API
responses and never deploy a Worker. Before production rollout, run the new
workflow against a disposable Worker and protected test environments, including
smoke failure and rollback scenarios.
