# Release management

## Branch flow

The standard environment flow is:

```text
topic branch -> staging -> main -> versioned release
```

Keep commits Conventional Commit-shaped (`feat:`, `fix:`, `docs:`, `ci:`,
`chore:`, and so on). Release Please uses them to select patch/minor/major
versions and generate grouped changelog notes.

The default `merge_strategy` is `merge`, matching promotion PRs from `staging` into `main`.
Configure it to `squash` or `rebase` in `.github/code-foundry.yml` if a repository intentionally differs. The current
supported `git_workflow` is `staging-release`.

The release workflow opens or updates a versioned PR after changes reach
`main`. Merging that PR updates the changelog, creates the Git tag and GitHub
Release, and triggers any configured package publication.

For an explicit version, put `Release-As: 2.0.0` in a commit or pull request
body. Existing `CHANGELOG.md` history remains repository-owned.

## Configuration

Set these values in `.github/code-foundry.yml`:

```yaml
release_type: auto # auto, node, python, rust, simple, or none
npm_publish: false # true only for an npm package
```

`auto` selects a supported manifest. Use `simple` with `version.txt` for a
repository without a package manifest and `none` for a repository that should
not release automatically.

Release Please runs in manifest mode whenever the release config declares
`packages` or a top-level `release-type`; `code-foundry sync` bootstraps
`.release-please-manifest.json` from the current package versions the first
time it is needed. Release Please owns the manifest after the first release
and sync never overwrites existing manifest versions. Legacy configs without
`packages` or `release-type` continue to run in simple mode and need no
manifest; `code-foundry doctor` fails when a manifest-mode config is missing
its manifest.

## Pull request permissions

Release Please falls back to the repository's `GITHUB_TOKEN` when a
`RELEASE_PLEASE_TOKEN` secret is unavailable. In that mode, Code Foundry opens
or updates the version pull request, leaves it for manual merge, and completes
the release job successfully.

Configure a narrowly scoped `RELEASE_PLEASE_TOKEN` repository or organization
secret to enable guarded automatic merging and downstream workflows triggered
by the resulting release. The token needs `contents`, `issues`, and
`pull-requests` write permissions. Code Foundry validates every changed path in
the generated version pull request before using the token to merge it.

## Operational checklist

1. Merge tested changes from `staging` into `main`.
2. Review the generated Release Please PR and changelog.
3. Merge the release PR with the repository's configured `merge_strategy` (default `merge`).
4. Confirm the GitHub Release and any package publication.
5. Synchronize `staging` with the new `main` release commit.
