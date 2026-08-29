# Workflow and CI conventions

## Standard triggers

The canonical validation caller uses pull requests plus bounded audit entry
points; it does not run the same suites again on branch pushes:

```yaml
pull_request:
  branches: [main, staging]   # staging-release topology
  # direct topology: branches: [main]
schedule:
  - cron: '31 6 * * 1'
workflow_dispatch:
```

In the `staging-release` topology, pull requests into `staging` run the fast
tier, ordinary pull requests into `main` run the full audit tier, and exact
Release Please pull requests into `main` run only release policy. In the
`direct` topology (the default) every pull request targets `main` and runs the
full audit tier, because there is no integration branch for a fast pass.
Scheduled and manual runs select the audit tier in both topologies. Draft PR
automation separately listens to supported topic-branch pushes, promotion
automation listens to `staging` pushes (staging-release only), and release
automation listens to `main` pushes.
Custom deployment, indexing, search, Slither, or other workflows are
repository-owned extensions and should keep their own triggers and permissions.

## Billing pause

Code Foundry consumers can stop all generated jobs from allocating GitHub-hosted
runners during a billing outage:

```bash
npx code-foundry ci pause
npx code-foundry ci status
npx code-foundry ci resume
```

The commands use the repository variable `CI_BILLING_PAUSED`. Every job in the
generated callers and reusable workflows checks this variable before GitHub
allocates a runner, so a direct reusable-workflow call cannot bypass the pause.
`pause` also backs up and removes only `Validation / Gate` from active branch
rulesets so pull requests do not wait forever for a deliberately disabled
workflow, and cancels queued or in-progress workflow runs that were created
before the flag changed.
`resume` restores that exact check before re-enabling jobs. Pull-request,
deletion, non-fast-forward, review, and other ruleset protections remain active.
The operation fails closed when the gate or its backup is ambiguous.

Release Please and package publication are deliberately included in the pause.
Changes merged to `main` while paused remain unreleased until the release
workflow receives a normal run after CI resumes, or a maintainer explicitly
dispatches its release-only bypass. The bypass does not enable validation,
security, CodeQL, draft-PR, or promotion jobs:

```bash
gh workflow run release_self-ci.yml --ref main -f release-while-paused=true
```

The first dispatch creates and, when an automation token is available, merges
the Release Please version PR. After that PR is merged, dispatch the same
command once more to create the tag, GitHub Release, and configured package
publication. Without an automation token, review and merge the version PR
manually between the two dispatches. `CI_BILLING_PAUSED` remains `true`
throughout the bounded release flow.

Custom workflows are repository-owned and are not rewritten by sync. Add
`if: vars.CI_BILLING_PAUSED != 'true'` to each custom root job that should
honor the shared billing pause.

## Standard workflow responsibilities

| Workflow | Responsibility |
| --- | --- |
| CI | Format, lint, type-check, and build |
| Test | Unit, integration, E2E, and smoke tests |
| Security | Profile, audits, and public-only Dependency Review |
| CodeQL | GitHub-native code scanning, kept separate from CI |
| Draft PR | Create/update development pull requests |
| Release PR | Promote `staging` into `main` (staging-release topology only) |
| Release | Release Please, GitHub release, and optional npm publication |

Use concise job names such as `CI / Format`, `Test / Unit`, and
`CodeQL / Analyze (Python)`. Required checks should match the jobs actually
enabled for the repository profile.

## Merge methods

The merge audit pins one merge method per transition. `code-foundry doctor`
and `code-foundry sync` fail closed on any other strategy, and the release
workflow refuses to run unless its strategy is exactly `rebase`.

| Transition | Merge method | Enforcement |
| --- | --- | --- |
| Feature/fix PR into `main` (direct topology) | Squash | Contribution policy; see `CONTRIBUTING.md` |
| Feature/fix PR into `staging` (staging-release topology) | Squash | Contribution policy; see `CONTRIBUTING.md` |
| `staging` → `main` promotion PR (staging-release topology) | Rebase (`merge_strategy: rebase`) | Code Foundry creates a one-commit head with `main` as its parent and the exact validated `staging` tree; `merge_strategy` must be `rebase`, and merge commits are rejected |
| Release Please version PR into `main` | Rebase (`release_merge_strategy: rebase`) | Release automation fails closed unless `rebase`; never defaults to `merge`, never uses `--admin` |

The promotion rows above apply only to `staging-release`; `direct`
repositories never generate a promotion caller and `merge_strategy` is not
enforced for them.

Release auto-merge waits for required checks and then polls `mergeStateStatus`
until it is `CLEAN`, or `UNSTABLE` with `mergeable` `MERGEABLE`, before
merging. Non-required checks that branch policy does not require (for example
external code review) never block the merge, so a ruleset that registers
additional required checks after earlier ones have passed (for example
`Validation / Gate` appearing after a platform-specific check) cannot leave the
merge policy-blocked. The mergeability poll is bounded and fails closed on
conflicts or timeout; releases without an automation token remain manual.

Keeping `main` linear — rebase promotions and rebase release PRs — is what
lets the post-release reconciliation fast-forward or replay `staging` safely
in the `staging-release` topology. `direct` repositories have no reconciliation
step: releases merge straight into `main` with `release_merge_strategy: rebase`.

Protect `main` with the aggregate `Validation / Gate` and squash-only pull
requests. In the `staging-release` topology, protect `staging` the same way
with a single GitHub Actions integration path. That path uses the
GitHub Actions integration token by default, and optionally an SSH deploy key
when `STAGING_DEPLOY_KEY` is configured. The deploy key is required only when
a personal-repository ruleset for `staging` enforces a Deploy Key bypass for
`release reconcile`; repositories without that bypass continue with tokenless
checkout + GitHub API calls.

When used, the optional `STAGING_DEPLOY_KEY` is written at runtime only for
reconcile, then used to set `GIT_SSH_COMMAND` and trusted host settings for
`release reconcile` over SSH push operations only; regular `git fetch` reads still
use HTTPS from the checked-out origin configuration. The key material is scrubbed
after the step.

When absent, the job keeps `GH_TOKEN = github.token` and runs `gh auth setup-git`
so repositories without a Deploy Key ruleset bypass still reconcile successfully.

When the protected `staging` branch rejects the exact-lease reconcile push with
a branch-policy/ruleset/required-PR error, the reconcile job does not fail:
if the branch trees are already identical, it reports a content-aligned no-op
because a normal pull request cannot safely represent a history-only ref move.
Otherwise, it opens (or reuses) a generated `code-foundry/reconcile/main-to-staging`
pull request whose deterministic one-commit head is parented at the current
`staging` tip and contains the exact reconciled target tree (the `main` tree for
a fast-forward, the replay tree when staging-only commits are replayed). This
avoids exposing divergent squash/rebase ancestry as an enormous PR diff. The
body documents both the target snapshot and exact-tree delivery head. Reruns
reuse the open pull request instead of duplicating it. Validated changes that
landed directly on `main` are synced back into `staging`; unpromoted staging
commits are replayed on top. Indeterminate
history, replay conflicts, authentication errors, and ambiguous or stale pull
request state still fail the job closed, and exact-lease protection stays in
place for every direct push.

Repositories using the generated pull request fallback must enable
**Settings > Actions > General > Workflow permissions > Allow GitHub Actions
to create and approve pull requests**. Code Foundry reports this exact setting
when GitHub rejects pull request creation through the Actions integration.

For this reconciliation path, maintainer PATs and administrator roles are not
authorized bypasses; the job deliberately authenticates with `github.token`,
not `CODE_FOUNDRY_TOKEN` or `RELEASE_PLEASE_TOKEN`.

## GitHub Stacks

GitHub Stacks (stacked pull requests) is not part of this topology and does
not reduce required workflow runs. Every pull request in a stack still
triggers its own validation run, and each branch keeps its own required
checks; stacking never collapses or skips a required check in the tiered
validation gate. Land changes through the standard `direct` or
`staging-release` flow instead.

## Language defaults

- TypeScript/JavaScript: ESLint, Prettier, and Bun's native `bun test`.
- Rust: default `rustfmt`, Clippy with `-D warnings`, and Cargo tests.
- Python: Ruff formatting/linting, uv when a compatible lockfile exists, and
  native Python tests.
- Solidity: preserve the repository's native Hardhat, Foundry, or specialized
  test/security workflows.

Jobs detect applicability before installing tools. Empty language or test
surfaces remain successful and visible, so branch protection does not become
ambiguous for mixed-language repositories.

## Security behavior

CodeQL is a separate workflow using GitHub's official actions. The default
`codeql: auto` policy enables it for public repositories and skips it for
private repositories unless explicitly enabled and Advanced Security is
available. Dependency Review follows the same policy through
`dependency_review: auto`; JavaScript, Python, and Rust audits remain
available without Advanced Security. If GitHub default setup is enabled,
disable its generated CodeQL workflow to avoid duplicate analysis.

Code Foundry does not enable GitHub Code Quality or any paid GitHub feature.
The repository's format and lint jobs are ordinary CI checks. Set `codeql:
false` or `dependency_review: false` when a public repository also needs those
checks disabled.

## Branch protection

Use repository rulesets (or legacy branch protection settings) to mirror the
required checks for each protected branch. Review the repository's enabled
features and enforce only checks that actually run:

```bash
Apply only checks for enabled workflows.
```

Keep strict status checks, linear history, and conversation resolution enabled
where required. For a repository with optional features disabled, do not require
checks that will never run.
