# Publishing packages

## npm

Set `npm_publish: true` only when the repository owns an npm package. Configure
npm trusted publishing for the repository's `release.yml` workflow whenever
possible. An `NPM_TOKEN` secret is the fallback for registries or repositories
that cannot use trusted publishing.

The package should define its intended visibility explicitly:

```json
{
  "publishConfig": {
    "access": "public"
  }
}
```

Publication occurs only from a Release Please tag; ordinary pushes do not
publish. The release workflow fails clearly when npm publication is enabled but
neither trusted publishing nor a token is configured.

After enabling publication, make one controlled release and verify both the
registry version and the provenance link before treating the repository as
fully configured.

## GitHub Releases and GitHub Packages

A GitHub Release is release metadata attached to a Git tag. It is independent
of the npm registry and of GitHub Packages.

Publishing to npm does not populate the repository's GitHub Packages section.
If a repository also needs a GitHub Container Registry or npm-compatible
GitHub Package, add a repository-owned publishing workflow and credentials;
that is an optional extension rather than part of the universal baseline.

## Provenance and verification

Prefer trusted publishing because it provides short-lived credentials and
provenance. After a release, verify:

```bash
npm view PACKAGE_NAME version dist-tags
gh release view vVERSION
```

For private or non-npm repositories, leave `npm_publish: false` and retain the
GitHub Release portion of the standard flow if versioned releases are useful.
