# Qualified publication

Code Foundry publishes only the same immutable archive that passed consumer
qualification. This path is used by Code Foundry's own release caller; generated
consumer release callers keep the ordinary `release.yml` behavior.

## Publication contract

The self-release pipeline is intentionally staged:

1. `consumer-qualification.yml` packs the candidate once and qualifies it across
   Node 24 and 26.
2. Release Please creates a draft release for the qualified source.
3. The staging job attaches the exact archive and a digest-bound qualification
   receipt, publishes the immutable GitHub Release, and verifies its identity.
4. `qualified-foundry-publish.yml` downloads that archive and the reports from
   its own workflow run and attempt, requalifies all three Node versions, and
   publishes the tarball.

The reusable publisher downloads an explicitly named npm archive from the
already-published immutable release, verifies the release and asset attestations
against the caller's exact commit, and only then admits the npm publication job.
The final job downloads only reports from its own workflow run and attempt,
rechecks all required fixtures and archive/source identities, repeats cryptographic
asset verification, validates the package name/version, and publishes the tarball
with lifecycle scripts disabled. It never publishes a directory or rebuilds the
package.

The publishing job serializes publication for a tag and has no dependency
installation/build step. Qualification has no npm credential. This self-only
publisher has no environment approval gate; publication is automatic after its
completed gates. npm trusted publishing is preferred; an explicit optional token
supports environments that cannot use it. Configure the trusted publisher for the
**actual caller and reusable-workflow relationship** before enabling this route.
Existing version publication is not overwritten: retrying an already-published
version fails rather than treating a registry conflict or network error as proof
of identity.

The publisher never rebuilds the package, publishes a directory, or treats an
already-published version conflict as proof of success. The workflow uses npm
trusted publishing when no `NPM_TOKEN` is supplied; the optional token is a
fallback for environments that cannot use trusted publishing.

Qualification and publication are gated on `main` push or an explicitly
requested `workflow_dispatch`. The shared billing pause blocks normal runs. A
manual release-only dispatch can pass `billing-pause-bypass: true` through the
publisher, but it does not bypass environment approvals, branch protection, or
identity checks.

## Release producer requirements

The producer must:

- pack the candidate with lifecycle scripts disabled;
- create or reuse a draft release for the exact package version;
- attach the package archive before the release is published;
- keep the tag at the qualified source commit;
- enable and verify GitHub release immutability before publication; and
- serialize release-tag mutation so two producers cannot race.

The candidate package must be named `code-foundry`, and its version must match
the explicit release tag. A recent GitHub CLI with `release verify` and
`release verify-asset` support is required. Missing support, ambiguous release
identity, unavailable permissions, changed assets, or conflicting assets fail
closed.

The generic reusable `release.yml` supports `defer-publication: true` for this
producer pattern. That mode suppresses its legacy npm, reconciliation, and
post-release jobs while exposing the release outputs needed by the self caller.
Consumer callers do not inherit the self-only qualification and staging jobs.

## Reusable publisher interface

The caller supplies the tag and exact pre-attached archive name:

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
    secrets:
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

For the self repository, `release_self-ci.yml` supplies the release output and
uses the protected `npm` environment. Configure trusted publishing for the
actual caller/reusable-workflow relationship, not only for a similarly named
workflow. Protect both the `release` and `npm` environments with the intended
branch restrictions and approvals.

## Identity and retry rules

Every qualification report is bound to the source SHA, archive digest, Node
version, and workflow attempt. The staging and publish jobs verify:

- the tag resolves to the current `github.sha`;
- the archive name and package identity are expected;
- all required Node reports belong to the same run attempt;
- the downloaded bytes match the qualified digest; and
- the release and assets have not been replaced.

On a failed or cancelled qualification, use **Re-run all jobs**. A failed-job-only
rerun cannot safely reuse an earlier pack or combine reports from different
attempts. Missing or expired artifacts require a fresh run.

If Release Please reports that no new release was created, the recovery path may
reuse an exact draft release only when its tag, version, source SHA, and draft
state still match the qualified candidate. An already-published release is never
restaged or overwritten. Inspect the retained staging and publication identity
receipts when recovery is needed.

## Publication prerequisites

Enable immutable releases and verify the setting with the actual
`CODE_FOUNDRY_TOKEN` (or workflow credential), then set
`REQUIRE_IMMUTABLE_RELEASES=true`. Missing permissions, a disabled or unknown
setting, or a CLI without release verification support fail before Release Please
writes. Protect release tags against concurrent moves. The staging token needs
administration-read, contents-write, and verification access; it is never exposed
to qualification jobs. Preflight and staging reuse the producer's validated
credential selection, falling back to the workflow token only when the configured
token is rejected. Configure npm trusted-publisher identity for the actual
caller/reusable-workflow relationship, or explicitly retain the optional npm
token in the final publisher.

## Trust boundaries

Qualification reports are evidence selected from successful jobs in the same
workflow attempt; they are not standalone signatures or authorization outside
the protected workflow. The workflow executes repository-owned code with the
permissions of its job. Keep credentials out of qualification jobs and review
release/environment protections separately. A YAML environment reference does
not prove that approval protections exist.

Run the full locked-toolchain suite, Actionlint contracts, and a disposable-repo
release/signing/registry rehearsal before production approval. The producer
serializes the full release workflow and never cancels an active publish. The
self caller auto-publishes after its gates without bypassing branch or review
requirements for source changes.

The staging command requires release-write, attestation-verification, and
immutable-setting read access. No elevated credential is installed automatically.
If the configured automation token is rejected, the producer's documented
fallback is used only where the workflow permits it; missing permissions fail
closed.

Use **Re-run all jobs** for qualification failures; attempts cannot reuse earlier
reports. If Release Please returns `release_created: false`, the recovery job
looks up only the package version's draft release through the authenticated,
paginated release list, resolves its tag, and resumes only when that tag still
points to the newly qualified source. Staging uses the same list because GitHub's
get-by-tag endpoint does not return draft releases. Missing or already published
releases are a safe no-op; malformed, inaccessible, or source-mismatched drafts
fail closed. Inspect the retained identity receipts. Once a release is
published, do not attempt to re-stage or overwrite it: rerun the verified
publisher from the same source-bound workflow after confirming npm has not already
accepted that version. Never weaken the SHA guard, move an immutable tag, or treat
npm's version-conflict response as success.

## Validation

Run the focused local suites before changing this path:

```sh
node --test test/consumer-qualification.test.mjs
node --test test/consumer-qualification-workflow.test.mjs
node --test test/qualification-handoff.test.mjs
node --test test/qualified-publication.test.mjs
node --test test/release-cutover.test.mjs
```

These tests use fixtures and do not establish live GitHub signing, OIDC
permissions, registry publication, environment approvals, or runner tool
availability. Exercise those controls in a disposable repository before changing
production release settings.
