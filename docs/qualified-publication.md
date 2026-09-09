# Qualified Publication

Publish only the same immutable Code Foundry archive that passed consumer qualification.

**Dependencies:** Consumer qualification (#544) and release integrity (#537).
**Activation:** Opt-in replacement publisher; no existing publisher is silently changed.

The reusable `qualified-foundry-publish.yml` downloads an explicitly named npm
archive from an already-published immutable release, verifies the release and
asset attestations against the caller's exact commit, qualifies that same archive
on Node 20/22/24, and only then admits a protected npm publication job. The final
job downloads only reports from its own workflow run **and run attempt**, rechecks
all required fixtures and archive/source identities, repeats cryptographic asset
verification, validates the package name/version, and publishes the tarball with
lifecycle scripts disabled. It never publishes a directory or rebuilds the package.

The publishing job uses a GitHub environment, serializes publication for a tag,
and has no dependency installation/build step. Qualification has no npm credential.
Normal npm trusted publishing is preferred; an explicit optional token supports
existing consumers. Configure the trusted publisher for the **actual caller and
reusable-workflow relationship** before enabling this route. Existing version
publication is not overwritten: retrying an already-published version fails rather
than treating a registry conflict or network error as proof of identity.

## Release producer contract

Build and test a package once, attach its tarball to a **draft** release, then
publish that release with immutability enabled. The archive must contain the
Code Foundry CLI/templates; this is intentionally not a generic package harness.
The candidate's `package.json` name must be `code-foundry` and its version must
match the explicit tag. All qualification modules must exist in the caller commit.
A recent GitHub CLI with `release verify` and `release verify-asset` is required;
missing support or authentication errors fail closed.

This workflow blocks npm publication, not a GitHub Release that was already
published. It does **not** add assets after an immutable release is published.
The `stage` command implements the draft-asset producer: it verifies qualification,
checks immutability without changing settings, resolves the existing tag to the
qualified commit, uploads the archive and digest-bound qualification receipt,
rechecks uploaded digests, then publishes and verifies the release. It requires
an existing draft and existing tag; it never creates/moves tags or overwrites
conflicting assets. Settings permission failures block writes. Matching existing
assets can resume staging; conflicting assets require manual reconciliation.
The pre-release gate in #544 supplies the required matrix reports.
The legacy Release Please workflow creates releases without
this archive staging step. Wire the new `stage` command into a draft-producing
caller instead of pointing the old direct-release caller at the new publisher:

```sh
node src/commands/qualified-publication.mjs stage \
  "$GITHUB_REPOSITORY" "$TAG" "$SOURCE_SHA" "$ASSET" "$CANDIDATE_DIRECTORY" \
  "$REPORT_NODE_20" "$REPORT_NODE_22" "$REPORT_NODE_24"
```

The stage command needs a credential with immutable-setting read, release
write, and attestation-read access; a normal Actions token may lack the
administration-read permission.
No elevated credential is installed or requested automatically. The producer must
also prevent concurrent tag mutation (for example with protected release-tag
rules and a single tag-scoped producer); GitHub does not offer an atomic
"publish this draft only if the tag still resolves to SHA" operation. The final
verification blocks npm if that invariant is violated, but cannot undo an
already-published immutable release.

Disable the old npm path before
activating the replacement to prevent racing publishers. None of those production
settings or existing release workflows are changed in this PR.

Example caller job after its release producer (illustrative job IDs):

```yaml
permissions:
  actions: read
  attestations: read
  contents: read
  id-token: write
jobs:
  publish:
    needs: release-producer
    uses: ./.github/workflows/qualified-foundry-publish.yml
    with:
      tag: ${{ needs.release-producer.outputs.tag }}
      asset: ${{ needs.release-producer.outputs.npm-asset }}
      environment: npm
    secrets:
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Only main-branch `push` and `workflow_dispatch` callers are admitted. Pull-request
events (including fork PRs), release-event shortcuts, and billing-paused runs
cannot publish through this workflow. The event guard does not itself verify
branch protection or prohibit a fork's independent main-branch workflow; configure
branch/environment protections and registry publisher identity separately.
The tag must resolve to `github.sha`, not a caller-selected old commit. To retry
an older release after main moves, use a separately reviewed recovery procedure;
do not weaken the identity gate ad hoc.

## Local policy tests and trust

`node --test test/qualified-publication.test.mjs` uses CLI/verifier fixtures to
exercise missing matrix members, skipped checks, absent Actionlint, changed
archives, invalid asset names, wrong package identity, and prevention of npm
execution before verification. These tests do not establish live GitHub signing,
OIDC permissions, registry publication, or runner tool availability.

Qualification reports are not standalone signatures: they are trusted only after
selection from this workflow's successful jobs in the same run attempt. Supplying
arbitrary local JSON to the library is not a security boundary. The reusable
workflow and its caller must be reviewed/trusted and protected; repository-owned
code executes with the permissions of its job. No credentials or production
resources were configured by adding this feature.
