# Release management

## Branch flow

The default `direct` flow is:

```text
topic branch -> main -> versioned release
```

Repositories that maintain a preview/staging environment opt into the
`staging-release` flow:

```text
topic branch -> staging -> main -> versioned release
```

Keep commits Conventional Commit-shaped (`feat:`, `fix:`, `docs:`, `ci:`,
`chore:`, and so on). Release Please uses them to select patch/minor/major
versions and generate grouped changelog notes.

The merge audit pins one merge method per transition. In the `staging-release`
topology, feature and fix branches land on `staging` with **squash** merges,
the `staging` → `main` promotion PR merges with **rebase** (`merge_strategy:
rebase`), and Release Please version PRs merge with **rebase**
(`release_merge_strategy: rebase`). In the `direct` topology, feature and fix
branches squash straight into `main` and only Release Please version PRs merge
with **rebase**; `merge_strategy` is not enforced. Release automation never
defaults to a merge method and never merges with `--admin`: the release
workflow fails closed unless `release_merge_strategy` is exactly `rebase`.

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
git_workflow: direct # direct (default) or staging-release
merge_strategy: rebase # staging-release only: staging -> main promotion PRs rebase
release_merge_strategy: rebase # required: Release Please version PRs rebase only
```

`git_workflow: staging-release` is opt-in; without it, repositories use the
`direct` flow and no promotion PR exists. When the staging-release topology is
selected, `merge_strategy` applies to promotion PRs (`staging` into `main`)
and `release_merge_strategy` to Release Please version PRs; feature PRs into
`staging` use squash merges. `code-foundry doctor` and `code-foundry sync`
reject any non-`rebase` `merge_strategy` only when `staging-release` is
configured, and always reject a non-`rebase` `release_merge_strategy`; the
release workflow fails closed instead of falling back to `merge`. Both keep
`main` fully linear, which is what makes the post-release reconciliation
possible: release-only main commits cannot be discarded because they are
allowed metadata-only, and all non-metadata drift is rejected before mutation.

The `staging` → `main` reconciliation exists only in the `staging-release`
topology. Patch-equivalent divergence between `main` and `staging` is treated
as aligned. When `staging` has pending commits that are not yet represented on
`main`, the release workflow replays those staging-only commits in order onto a
detached worktree rooted at `main`, and then updates `staging` with an exact
`--force-with-lease` to prevent
unintended branch rewrites. There is no unconditional mirror force-push and no
fallback synchronization commit path. `direct` repositories skip this step
entirely.

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

The release job validates the configured automation token
(`CODE_FOUNDRY_TOKEN`, falling back to `RELEASE_PLEASE_TOKEN`) against the
current repository with an authenticated REST probe before any write. When no
automation token is configured, or the configured token is rejected by GitHub
(observed with long-lived fine-grained tokens that GitHub rejects with HTTP
403 even on REST), the release job fails over to the repository's short-lived
`GITHUB_TOKEN`. In that mode, Code Foundry opens or updates the version pull
request, leaves it for manual merge, and completes the release job
successfully. The token value is never printed or written to step outputs.

Guarded automatic merging and the downstream workflows triggered by the
resulting release are enabled only when the configured automation token was
validated successfully; a rejected token never falls through to any write.
Configure a valid, narrowly scoped `CODE_FOUNDRY_TOKEN` or
`RELEASE_PLEASE_TOKEN` repository or organization secret to enable guarded
automatic merging and downstream workflows triggered by the resulting
release. The token needs `contents`, `issues`, and `pull-requests` write
permissions. Code Foundry validates every changed path in the generated
version pull request before using the token to merge it, waits for the
required checks to finish, and then polls the pull request's
`mergeStateStatus` until it is `CLEAN`, or `UNSTABLE` with `mergeable`
`MERGEABLE`, before merging. Non-required checks that branch policy does not
require (for example external code review still running after every required
check passed) do not block the merge; conflicts fail immediately and a bounded
polling window fails closed if branch or ruleset policy still blocks the merge
(a ruleset may register additional required checks after earlier ones have
already passed).

## Operational checklist

1. Merge tested changes into `main` (direct: feature PRs; staging-release: promote `staging` into `main`).
2. Review the generated Release Please PR and changelog.
3. Merge the release PR with the repository's configured `release_merge_strategy` (**rebase**; the release workflow fails closed on any other value).
4. Confirm the GitHub Release and any package publication.
5. staging-release only: synchronize `staging` with the new `main` release commit.
