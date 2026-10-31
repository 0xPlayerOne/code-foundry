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
branches squash straight into `main` and Release Please version PRs squash into
`main` (`release_merge_strategy: squash`). `sync`, `doctor`, and release
automation reject any other strategy. Release automation never defaults to a
merge method and never merges with `--admin`.

The release workflow opens or updates a versioned PR after changes reach
`main`. For generated consumer callers, merging that PR updates the changelog,
creates the Git tag and GitHub Release, and can trigger npm publication. Code
Foundry's own caller uses the qualified path: it qualifies the package first,
creates a draft release, stages the exact qualified archive, then publishes the
immutable release and package through the verified publisher. See [Qualified
publication](qualified-publication.md).

For an explicit version, put `Release-As: 2.0.0` in a commit or pull request
body. Existing `CHANGELOG.md` history remains repository-owned.

### Adea UI receipts

Only `packages/ui` may opt in; others use full validation. Packed Node 24/26 checks remain.

## Configuration

Set these values in `.github/code-foundry.yml`:

```yaml
release_type: auto # auto, node, python, rust, simple, or none
npm_publish: false # true only for an npm package
git_workflow: direct # direct (default) or staging-release
merge_strategy: rebase # staging-release only: staging -> main promotion PRs rebase
release_merge_strategy: squash # direct default; staging-release requires rebase
```

`git_workflow: staging-release` is opt-in; without it, repositories use the
`direct` flow and no promotion PR exists. When the staging-release topology is
selected, `merge_strategy` applies to promotion PRs (`staging` into `main`)
and `release_merge_strategy` to Release Please version PRs; feature PRs into
`staging` use squash merges. `code-foundry doctor`, `code-foundry sync`, and
the release workflow reject any non-`rebase` `merge_strategy` or release
strategy in `staging-release`; `direct` requires `squash` for
release PRs and never falls back to `merge`. Both keep `main` fully linear,
which is what makes the post-release reconciliation possible. The final
branch trees are inspected before mutation; validated main-only changes are
inherited by `staging`, while unpromoted staging work is replayed on top of
`main`.

Promotion never opens a pull request directly from a divergent `staging`
history. The workflow creates or refreshes a deterministic promotion branch
whose single commit has the current `main` tip as its parent and the exact
validated `staging` tree. This keeps the review diff limited to the actual
environment delta even after squash or rebase merges have changed ancestry.
The generated commit preserves the staged tip's conventional subject so
Release Please still detects the appropriate release type after promotion.

The `staging` → `main` reconciliation exists only in the `staging-release`
topology. The reusable release workflow defaults to `direct` and requires its
caller to opt into `staging-release`, so a stale remote `staging` branch cannot
activate reconciliation in a direct repository. Patch-equivalent divergence
between `main` and `staging` is treated as aligned. When `staging` has pending
commits that are not yet represented on
`main`, the release workflow replays those staging-only commits in order onto a
detached worktree rooted at `main`, and then updates `staging` with an exact
`--force-with-lease` to prevent
unintended branch rewrites. There is no unconditional mirror force-push and no
unreviewed fallback synchronization commit path. Indeterminate history, replay
conflicts, and stale leases fail closed. `direct` repositories skip this step
entirely.

When branch policy requires reconciliation through a pull request, Code
Foundry creates a deterministic one-commit delivery head instead of pointing
the pull request branch at the divergent `main` or replay history. Its parent
is the current protected `staging` tip and its tree is the exact reconciled
target tree. This keeps the review limited to release metadata and any genuine
replayed staging work, while preserving exact-lease updates and idempotent PR
reuse.

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

## Generated release content audit

Release Please writes the release commit from file bodies it reads over the
GitHub API. A run that starts on one push and finishes after another can commit
bodies read before the second push onto the newer `main`, so the version PR
silently reverts the merged change inside an approved file (agent-sim #133
reverted `@adea-ai/ui` from `^0.144.0` to `^0.143.0` in six `package.json`
files). A path audit cannot see this, because every changed path is an approved
release file.

Both release checks therefore read the unified diff against the base and require
every added or removed line to be a release mutation: a version assignment
(`"version": "1.2.3"`, `version = "1.2.3"`, a bare version file, a line carrying
an `x-release-please-*` annotation, or a `jsonpath` key declared in
`extra-files`), a `.release-please-manifest.json` package version, or an addition
to a changelog. Any other change, a deleted file, or a rename fails closed and
names the file and the first offending lines. A minified single-line JSON
manifest passes when only its version keys differ. An unreadable diff also
fails; it is never treated as empty.

- `validation release_diff` (the required release-tier gate) audits
  `base...HEAD` of the pull request merge commit, so a branch that is behind
  `main` is judged by what merging it would do.
- `release validate-prs` audits `gh pr diff` before auto-merge is requested.

A failed audit leaves the version PR unmerged. Re-run the Release workflow
(`workflow_dispatch`) so Release Please regenerates the branch from the current
`main`; do not edit the generated branch or release manually.

## Lockfile workspace versions

Release Please's Node updater bumps every workspace `package.json` but has no
updater for `bun.lock`, which records each workspace's `version`. A version PR
therefore leaves the lock naming the previous version of every workspace (the
agent-sim 0.15.14 release left all 14 workspaces at 0.15.10).

- `validation release_diff` fails a generated release whose `bun.lock` records a
  workspace version that differs from its `package.json`, and names the first
  workspaces and the fix.
- `code-foundry release sync-lock [--target PATH] [--dry-run]` rewrites only
  those drifted `version` values; it never touches dependencies, the `packages`
  section or line endings, and does nothing when the lock already matches.
- The Release workflow runs it on each open generated release branch before the
  draft-state and merge steps read the PR head, then pushes one
  `chore(release): sync bun.lock workspace versions` commit with the validated
  automation token so the required checks run on it. With the fallback workflow
  token (whose pushes start no workflows) the step is skipped and the gate
  reports the stale lock instead. A push rejected because Release Please moved
  the branch is left for the next run.

## Issue references in release pull requests

Release Please renders every footer-form issue reference in a squashed commit
(`Refs #187`, `Closes: #187`) as `, closes [#187](…)` in the version pull
request body, so merging the release would close every issue a release merely
mentions. After each Release Please run the Release workflow pipes each open
generated release PR body through `code-foundry release scrub-pr-body`, which
rewrites GitHub's closing keywords (close, fix, resolve and their forms) before
an issue reference to `refs`, and updates the body only when it changed. The
issue stays linked; closing it remains a decision made on the change itself.

## Pull request permissions

The release job validates the configured automation token
(`CODE_FOUNDRY_TOKEN`) against the
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
Configure a valid, narrowly scoped `CODE_FOUNDRY_TOKEN`
repository or organization secret to enable guarded
automatic merging and downstream workflows triggered by the resulting
release. The token needs `contents`, `issues`, and `pull-requests` write
permissions. Code Foundry validates every changed path in the generated
version pull request before requesting its merge with GitHub's auto-merge
feature and the configured canonical method (`squash` for `direct`, `rebase`
for `staging-release`). GitHub performs the merge only after the branch's
required checks and reviews pass; the release runner exits after submitting
that request rather than waiting for every workflow to finish. This keeps a
healthy release from failing just because required checks outlast a bounded
runner-side wait. No checks, reviews, or branch rules are bypassed. The
request uses the exact head SHA returned by Code Foundry's path audit and is
refused if the branch changed during that audit.

Repositories using a valid `CODE_FOUNDRY_TOKEN` must allow auto-merge in their
GitHub settings when release checks may still be pending. GitHub rejects the
request if auto-merge is unavailable. If the PR is already eligible, the same
command merges it immediately under branch policy. A head change detected
between the path audit and enqueueing fails the release job. Conflicts remain
subject to GitHub's branch policy and keep the merge from completing until
resolved. GitHub's
automatic head-branch deletion setting removes branches after deferred merges;
the CLI's `--delete-branch` option also removes a branch when the merge completes
immediately. GitHub can keep auto-merge enabled if a later Release Please run
updates the branch. With the documented required `Validation / Gate`, each
synchronized head reruns the release-diff policy, and GitHub waits for that
head's required checks before merging.

## Operational checklist

1. Merge tested changes into `main` (direct: feature PRs; staging-release: promote `staging` into `main`).
2. Review the generated Release Please PR and changelog. A validated
   `CODE_FOUNDRY_TOKEN` lets the release workflow merge it automatically after
   required checks; without that token, merge it manually with the configured
   topology method: squash for `direct`, rebase for `staging-release`.
3. For a generated consumer caller, confirm the GitHub Release and any package
   publication.
4. For Code Foundry itself, do not advance the self-referencing runtime pin as
   part of a release; self-sync preserves that compatibility pin and avoids a
   self-update release loop. Confirm qualification, draft staging, immutable
   publication, and the retained identity receipts.
5. In `staging-release`, synchronize `staging` with the new `main` release commit.
