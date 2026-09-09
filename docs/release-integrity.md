# Release integrity and build provenance

Code Foundry now provides a read-only immutable-setting preflight, cryptographic
release/asset verification, and an optional build-provenance action. These are
separate guarantees: a checksum identifies bytes, an attestation identifies their
origin, and GitHub's immutable-release setting prevents replacement after publish.

## Enable immutable releases explicitly

An administrator must enable **Settings → General → Releases → Enable release
immutability**. This applies only to future releases. Existing mutable releases
are not retroactively frozen, and this implementation does not change the setting.
After enabling it, set the repository variable `REQUIRE_IMMUTABLE_RELEASES=true`
to activate Code Foundry's post-publication verification caller. Manual dispatch
can verify an explicitly selected tag without the variable. Billing pause is
honored by both workflows. A skipped workflow is not verification evidence.

Publish all assets to a draft release **before** publishing it. Do not attach or
replace assets after an immutable release is published. The existing Release
Please/npm workflow is not rewritten by this change; repositories adding release
assets must review their attachment ordering before enabling immutability.

A release workflow can run this preflight before publication:

```sh
npx code-foundry release-integrity settings --repo owner/repository
```

The setting endpoint needs an authenticated identity with repository
Administration **read** permission. Do not grant Administration write for this
check. The ordinary Actions token may be unable to read it. Inaccessible,
unsupported, malformed, or disabled settings fail as unverified; a 404 is not
silently interpreted as proof that a setting is absent. No setting writes exist
in the verifier.

## Verify published releases and local assets

```sh
npx code-foundry release-integrity release \
  --repo owner/repository --tag v1.2.3 \
  --expected-sha FULL_40_CHARACTER_COMMIT_SHA \
  --asset dist/package.tgz
```

`--expected-sha` and repeatable `--asset` are optional. Verification requires the
exact published tag to be immutable, invokes `gh release verify` for signed
release-attestation validation, resolves lightweight/annotated tags to a commit,
and optionally checks that commit against the expected source. Each local asset
is checked with `gh release verify-asset`, and hashed before/after verification to
reject replacement during the check. GitHub-generated source archives are not
supported release assets for this command; verify uploaded binaries/packages.
The GitHub CLI must support these subcommands; an older CLI fails rather than
falling back to a metadata-only claim. The verifier targets github.com explicitly.

JSON is emitted on stdout with a nonzero exit status on failure. No credential or
raw failed API response is included in the report. Selected assets must be
nonempty regular files inside the repository, without symlink components.

`sync` installs an opt-in release-event caller in
`.github/workflows/release-integrity.yml`; set `REQUIRE_IMMUTABLE_RELEASES=true`
to enable it. To call the reusable workflow directly, pin both references to the
same reviewed tag or commit:

```yaml
permissions:
  contents: read
  attestations: read
jobs:
  verify-release:
    uses: 0xPlayerOne/code-foundry/.github/workflows/release-integrity.yml@REVIEWED_REF
    with:
      runtime-ref: REVIEWED_REF
      tag: v1.2.3
      expected-sha: FULL_40_CHARACTER_COMMIT_SHA
```

`runtime-ref`, `tag`, and optional `expected-sha` are the workflow inputs. The job
checks out only the selected verifier, not executable code from the release under
test, needs `contents: read` and `attestations: read`, preserves evidence, and
exposes the verified `source-sha`. Downstream publication or consumer steps should
explicitly `needs` this job when verification is their gate. Code Foundry's own
release-event caller verifies **after publication**; it cannot prevent a release
that has already been published. Actual immutability comes from the repository
setting.

## Optional build provenance

In the same trusted job that builds the artifacts, grant `contents: read`,
`id-token: write`, and `attestations: write`, then call:

```yaml
- name: Attest built package
  # Replace REVIEWED_SHA with the reviewed Code Foundry commit.
  uses: 0xPlayerOne/code-foundry/.github/actions/attest-artifact@REVIEWED_SHA
  id: provenance
  with:
    artifacts: '["dist/package.tgz"]'
```

The action hashes only the explicitly selected files, generates a checksum
manifest, signs those digests with the commit-pinned official GitHub provenance
action, and checks the files have not changed during signing. Its outputs provide
the manifest, signed bundle, and attestation URL. Persist the manifest and bundle
alongside build evidence; attach release assets before publishing an immutable
release. The action refuses PR event contexts. Repository-owned build scripts
must still be trusted: signing attacker-controlled downloaded bytes does not
prove that this job built them. Do not place attestation into an unrelated job
that merely downloads and re-labels artifacts from another build.

Artifact attestations require GitHub support for the repository/account. Never
silently skip a required attestation because the account lacks that capability.
Consumers should use `gh attestation verify` with the expected source repository
and trusted signer workflow as appropriate; digest equality alone is insufficient.
This action covers local file artifacts, not registry image publishing. npm
trusted publishing remains available through the existing release workflow; this
change does not replace or require an npm token.

Generate a local unsigned manifest without GitHub/network access with:

```sh
npx code-foundry release-integrity manifest --asset dist/package.tgz
```

That command makes no provenance or authenticity claim.

## Validation and references

Run `node --test test/release-integrity.test.mjs`. Tests cover exact command
contracts, signature-verifier invocation, tag identity, asset replacement/path
safety, settings uncertainty, sync-installed caller wiring, and pinned/read-only
workflow structure using CLI fixtures. Real signing and release verification
require a supported authenticated GitHub environment and must be exercised there
before rollout.

- https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases
- https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity
- https://cli.github.com/manual/gh_release_verify
- https://cli.github.com/manual/gh_release_verify-asset
- https://docs.github.com/en/rest/repos/repos#get-immutable-releases-settings
- https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds
