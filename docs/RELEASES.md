# Release management

## Branch flow

The standard environment flow is:

```text
topic branch -> staging -> main -> versioned release
```

Keep commits Conventional Commit-shaped (`feat:`, `fix:`, `docs:`, `ci:`,
`chore:`, and so on). Release Please uses them to select patch/minor/major
versions and generate grouped changelog notes.

The release workflow opens or updates a versioned PR after changes reach
`main`. Merging that PR updates the changelog, creates the Git tag and GitHub
Release, and triggers any configured package publication.

For an explicit version, put `Release-As: 2.0.0` in a commit or pull request
body. Existing `CHANGELOG.md` history remains repository-owned.

## Configuration

Set these values in `.github/code-foundry.yml`:

```yaml
release_type: auto   # auto, node, python, rust, simple, or none
npm_publish: false   # true only for an npm package
```

`auto` selects a supported manifest. Use `simple` with `version.txt` for a
repository without a package manifest and `none` for a repository that should
not release automatically.

## Pull request permissions

If the default `GITHUB_TOKEN` cannot create pull requests, configure a narrowly
scoped `RELEASE_PLEASE_TOKEN` repository or organization secret. The release
workflow needs `contents`, `issues`, and `pull-requests` permissions.

## Operational checklist

1. Merge tested changes from `staging` into `main`.
2. Review the generated Release Please PR and changelog.
3. Merge the release PR with the repository's normal linear-history policy.
4. Confirm the GitHub Release and any package publication.
5. Synchronize `staging` with the new `main` release commit.
