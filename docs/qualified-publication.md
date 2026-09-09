# Qualified Publication

Publish only the same immutable Code Foundry archive that passed consumer qualification.

**Dependencies:** Consumer qualification handoff (#556) and the existing release-integrity/publication modules.
**Activation:** Code Foundry self-caller cutover; consumer release defaults are unchanged. Complete the prerequisites below before merging the self-caller change.

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
The generic Release Please workflow retains direct publication by default.
Its `config-file` input selects a repository-contained JSON configuration;
`defer-publication: true` requires a single root package with `draft` and
`force-tag-creation` enabled. It disables legacy npm, reconciliation and post-release
jobs together and exposes `release_created`, `tag_name`, and `sha` to the caller.
The self caller uses this route, followed by:

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

The self caller disables the old npm path with `defer-publication: true` and sends
no npm credential to the Release Please job. Generic consumer callers are not
opted in. This code change does not configure production settings or credentials.

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
events (including fork PRs) and release-event shortcuts cannot publish through
this workflow. Billing-paused runs remain blocked unless the main-branch caller
is an explicit `workflow_dispatch` with `billing-pause-bypass: true`; the self
caller forwards only its existing `release-while-paused` manual input. The event guard does not itself verify
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


## Self-caller activation and recovery

`release_self-ci.yml` now sequences qualification and a read-only immutability
preflight, draft creation, protected asset staging, then the verified publisher.
`.github/release-please-foundry.json` is self-only: the root template and generated
consumer configurations keep ordinary release behavior. The staging guard requires
Release Please's exact SHA/tag, the qualified source/digest, and the current
run/attempt artifact name to match before downloads or writes. No package is
rebuilt between the qualification gate, draft staging and npm publication.
The final publisher independently requalifies the immutable downloaded bytes.

**Before merging the cutover**, enable immutable releases and verify the setting
with the actual `CODE_FOUNDRY_TOKEN` (or workflow credential), then set
`REQUIRE_IMMUTABLE_RELEASES=true`. Missing permissions, a disabled/unknown setting,
or a CLI without release verification support fail before Release Please writes.
Protect release tags against concurrent moves and configure the `release` and
`npm` environments with the intended main-only deployment rules and approvals.
A YAML environment reference does not prove those protections exist. The staging
token needs administration-read, contents-write and verification access; it is
never exposed to the qualification jobs. Configure npm trusted-publisher identity
for the actual caller/reusable workflow, or explicitly retain the optional npm
token in the final publisher. None of these settings is changed by this PR.

Run the full locked-toolchain suite, Actionlint contracts, and a disposable-repo
release/signing/registry rehearsal before production approval. The producer
serializes the full release workflow and never cancels an active publish; it does
not auto-approve environments or bypass branch/review requirements.

Use **Re-run all jobs** for qualification failures; attempts cannot reuse earlier
reports. Matching assets on an existing draft can resume through the reviewed
staging command after fresh qualification. Once a release is published, do not
attempt to re-stage or overwrite it: rerun the verified publisher from the same
source-bound workflow after confirming npm has not already accepted that version.
The normal Release Please caller may return `release_created: false` on a retry;
that is not proof of completed staging/publication. Inspect the retained identity
receipts. If main has moved or the tag/asset identity differs, stop and use a
separately reviewed source-bound recovery procedure. Never weaken the SHA guard,
move an immutable tag, or treat npm's version-conflict response as success.

The release cutover raises only the unpacked package ceiling from 945,000 to
960,000 bytes for the shipped workflow/configuration/documentation additions.
The compressed ceiling (250,000 bytes), file ceiling (110), startup/test timing,
and dependency budgets are unchanged. Re-measure the combined candidate after
merging independent workflow changes; the added policy does not justify a runtime
performance regression or a dependency increase.
