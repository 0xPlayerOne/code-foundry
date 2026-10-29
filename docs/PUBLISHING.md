# Publishing packages

Code Foundry separates versioning, GitHub Releases, and registry publication.
Choose the release path that matches the repository:

- **Generated consumer caller:** Release Please creates the GitHub Release and
  the standard `release.yml` job can publish npm when `npm_publish: true`.
- **Code Foundry itself:** `release_self-ci.yml` qualifies the package, stages
  the exact archive on an immutable draft release, and delegates final npm
  publication to `qualified-foundry-publish.yml`.

## npm publication for consumer repositories

Set `npm_publish: true` only when the repository owns an npm package. Configure
npm trusted publishing for the generated `release.yml` workflow. The
`npm_publish_auth` setting defaults to `auto`: existing `NPM_TOKEN` users keep
token publication, and tokenless repositories use OIDC. Set it to `oidc` to
force trusted publishing and keep `NPM_TOKEN` out of publication and install;
use `NPM_READ_TOKEN` separately when private dependencies must be installed.
Set `npm_publish_auth: token` only when a long-lived publishing token is still
required.

Declare the package's intended visibility explicitly:

```json
{
  "publishConfig": {
    "access": "public"
  }
}
```

Publication occurs only from a Release Please tag; ordinary pushes do not
publish. `token` mode fails clearly unless `NPM_TOKEN` is configured. `auto`
uses OIDC when the publishing token is absent, and `oidc` always uses the
workflow's short-lived trusted identity. For private dependency installation,
the workflow consumes `NPM_READ_TOKEN` first; `NPM_TOKEN` is an install fallback
only outside explicit OIDC mode.

After enabling publication, make one controlled release and verify both the
registry version and its provenance link before treating the setup as complete.

## Code Foundry's qualified publication

The self-hosted package follows a stricter contract than generated consumer
callers:

1. Pack the candidate once and qualify that archive across Node 24 and 26.
2. Create a draft GitHub Release and attach the exact qualified archive plus its
   qualification receipt.
3. Publish the immutable GitHub Release after verifying the tag, source commit,
   archive digest, immutable-release setting, and qualification reports.
4. Publish the already-qualified archive through the qualified publisher using npm
   trusted publishing.

The final publisher does not rebuild or reinstall the package. It publishes only
the bytes selected from the same workflow run and attempt. See [Consumer
qualification](consumer-qualification.md) and [Qualified publication](qualified-publication.md)
for the complete contract, retries, and recovery rules.

The main-push pipeline runs Release Please first, then qualifies only when the
push created a release or recovery found a stuck draft. Feature merges pay for
the cheap release-please and recovery probes; the runner-heavy matrix runs on
release merges, which re-qualify the exact tree they publish.

## GitHub Releases and GitHub Packages

A GitHub Release is metadata attached to a Git tag. It is independent of npm and
of GitHub Packages.

Publishing to npm does not populate the repository's GitHub Packages section. If
a repository also needs GitHub Container Registry or an npm-compatible GitHub
Package, add a repository-owned publishing workflow and credentials.

## Provenance and verification

Prefer trusted publishing because it provides short-lived credentials and
provenance. After a release, verify:

```sh
npm view PACKAGE_NAME version dist-tags
# Replace VERSION with the published tag.
gh release view vVERSION
```

For private or non-npm repositories, leave `npm_publish: false` and retain the
GitHub Release portion of the standard flow if versioned releases are useful.
