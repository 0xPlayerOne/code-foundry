# Workflow and CI conventions

## Standard triggers

Validation uses two callers so pull-request code and default-branch-capable
audit events never share a caller-selected runtime ref. The canonical
`validation.yml` caller handles pull requests and a lightweight default-branch
CodeQL lane:

```yaml
push:
  branches: [main] # CodeQL only
pull_request:
  branches: [main, staging] # staging-release topology
  # direct topology: branches: [main]
```

The generated validation caller listens for `ready_for_review` and
`synchronize`. Its jobs require the pull request to remain ready, so draft
updates allocate no validation runner; main pushes run only the default-branch
CodeQL lane, while full validation remains pull-request-only. A separate
lightweight Draft Guard runs from the trusted base branch on `opened` and
`reopened`; it converts ordinary ready pull requests back to draft without
checking out pull-request code. It rechecks the current head and update
timestamp before mutating state, so a stale event cannot undo a later draft or
ready transition. Release Please version heads are excluded because the
release workflow owns their state. A separate draft-control caller listens for
`converted_to_draft` and cancels queued or running pull-request workflows.
Marking a pull request ready starts validation, and each new commit on a ready
pull request starts it again for the current head. Audit-mode runs additionally
execute the eval lane (`Validation / Eval`) for repositories that ship an eval
harness; see [Evals](EVALS.md).

Two waste-avoidance rules keep validation minutes honest without weakening
confidence:

- **Docs-only pull requests run the fast tier.** When an audit-classified pull
  request changes only markdown, `docs/`, and license roots, the mode
  classifier downgrades it to fast. Any code, lockfile, workflow,
  configuration, or packaging change — or any diff that cannot be computed
  deterministically — keeps the audit tier. Scheduled and manual audits always
  run the full tier.
- **Bot-authored pull requests validate only on ready transitions.**
  Dependabot and other bot pushes never allocate validation runners; a
  maintainer marks the (Guard-drafted) pull request ready — or pushes to its
  branch, which changes the sender — to run validation. Release Please heads
  are exempt because the release workflow merges them through its own lane.

The separate `validation-audit.yml` caller is pinned to the configured released
runtime and handles scheduled and manual audits:

```yaml
schedule:
  - cron: '31 6 * * 1'
workflow_dispatch:
```

In the `staging-release` topology, pull requests into `staging` run the fast
tier, ordinary pull requests into `main` run the full audit tier, and exact
Release Please pull requests into `main` run a lean release lane — CI, unit
tests, and CodeQL plus the release-diff policy. Their diff is version
metadata only: the content was fully audited on the pull requests that
merged into `main`, and the scheduled audit lane re-covers drift, so the
release lane keeps repository rulesets satisfiable without re-running the
runner-heavy suites. The managed branch rulesets require only the aggregate
`Validation / Gate` check, so skipped non-required jobs never deadlock the
release; do not hand-require individual job contexts on release branches.
In the
`direct` topology (the default) every pull request targets `main` and runs the
full audit tier, because there is no integration branch for a fast pass.
Scheduled and manual runs select the audit tier in both topologies. Draft PR
automation separately listens to supported topic-branch pushes and always
opens those PRs as drafts. Promotion automation listens to `staging` pushes
(staging-release only) and also always opens its PR as a draft. Release
automation and default-branch CodeQL listen to `main` pushes.
Custom deployment, indexing, search, Slither, or other workflows are
repository-owned extensions and should use the same ready-transition policy.
Code Foundry's runner-heavy validation, security, qualification, and Cloudflare
reusable workflows also enforce draft protection at the job boundary. Generated
callers default to the `draft_protection: true` configuration; set it to `false`
to run generated gates for drafts. Cloudflare callers use their equivalent
`draft-protection: false` input. These opt-outs do not remove Draft Guard or
draft-PR automation; they only allow the protected gates to run for drafts.

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
honor the shared billing pause. The optional OpenCode Security scan honors a
second toggle: the `OPENCODE_SECURITY` repository or organization variable
(`true`/`false`) is its only enablement control, so individual repositories can
opt in or out without a code change.

## Standard workflow responsibilities

| Workflow    | Responsibility                                                    |
| ----------- | ----------------------------------------------------------------- |
| CI          | Format, lint, type-check, and build                               |
| Test        | Unit, standardized performance, integration, E2E, and smoke tests |
| Security    | Profile, audits, and public-only Dependency Review                |
| CodeQL      | GitHub-native code scanning, kept separate from CI                |
| Draft PR    | Create/update development pull requests                           |
| Draft Guard | Keep opened/reopened ordinary PRs draft until `ready_for_review`  |
| Release PR  | Promote `staging` into `main` (staging-release topology only)     |
| Release     | Release Please, GitHub release, and optional npm publication      |

Generated consumer callers use the standard Release workflow. Code Foundry's
own `release_self-ci.yml` adds consumer qualification, draft-release staging,
immutable-release verification, and qualified npm publication; see [Qualified
publication](qualified-publication.md).

Use concise job names such as `CI / Format`, `Test / Unit`, and
`CodeQL / Analyze (Python)`. Per-language CodeQL analyzers (Rust shards
included) and security audits run through a detection-built matrix, so a
repository only ever shows checks for languages it actually uses — never
skipped rows for other languages. The release tier validates the generated
diff as a step inside the gate rather than a separate job, for the same
reason. Required checks should match the jobs actually enabled for the
repository profile — in practice, require only the aggregate
`Validation / Gate`, which fails closed unless every generated check
succeeds.

## Merge methods

The merge audit pins one merge method per transition. `code-foundry doctor`
and `code-foundry sync` validate release strategy against the repository
topology. Direct feature and release PRs require `squash`; staging-release
promotion and release PRs require `rebase`. The release workflow fails closed
on any other strategy and never falls back to `merge`.

| Transition                                                 | Merge method                                | Enforcement                                                                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feature/fix PR into `main` (direct topology)               | Squash                                      | Contribution policy; see `CONTRIBUTING.md`                                                                                                                                 |
| Feature/fix PR into `staging` (staging-release topology)   | Squash                                      | Contribution policy; see `CONTRIBUTING.md`                                                                                                                                 |
| `staging` → `main` promotion PR (staging-release topology) | Rebase (`merge_strategy: rebase`)           | Code Foundry creates a one-commit head with `main` as its parent and the exact validated `staging` tree; `merge_strategy` must be `rebase`, and merge commits are rejected |
| Release Please version PR into `main`                      | Squash (direct) or rebase (staging-release) | Release automation fails closed on unsupported topology/strategy; never defaults to `merge`, never uses `--admin`                                                          |

The promotion rows above apply only to `staging-release`; `direct`
repositories never generate a promotion caller and require `merge_strategy:
squash` for feature pull requests.

Release auto-merge waits for required checks and then polls `mergeStateStatus`
until it is `CLEAN`, or `UNSTABLE` with `mergeable` `MERGEABLE`, before
merging. Non-required checks that branch policy does not require (for example
external code review) never block the merge, so a ruleset that registers
additional required checks after earlier ones have passed (for example
`Validation / Gate` appearing after a platform-specific check) cannot leave the
merge policy-blocked. The mergeability poll is bounded and fails closed on
conflicts or timeout; releases without an automation token remain manual.

Keeping `main` linear — rebase promotions and release PRs in the
`staging-release` topology, or a single-commit squash release PR in the
`direct` topology — is what lets the post-release reconciliation fast-forward
or replay `staging` safely. `direct` repositories have no reconciliation step:
releases merge straight into `main` with the configured
`release_merge_strategy`.

Protect `main` with the aggregate `Validation / Gate`. Require squash for
feature/fix pull requests and permit the configured Release Please method:
rebase in `staging-release`, or squash in `direct`. In the
`staging-release` topology, protect `staging` the same way with a single GitHub
Actions integration path. That path uses the
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
not `CODE_FOUNDRY_TOKEN`.

## GitHub Stacks

GitHub Stacks (stacked pull requests) is not part of this topology and does
not reduce required workflow runs. Every pull request in a stack still
triggers its own validation run, and each branch keeps its own required
checks; stacking never collapses or skips a required check in the tiered
validation gate. Land changes through the standard `direct` or
`staging-release` flow instead.

## Language defaults

- TypeScript/JavaScript: Oxlint, Oxfmt, and Bun's native `bun test`.
- Rust: default `rustfmt`, Clippy with `-D warnings`, and Cargo tests.
- Python: Ruff formatting/linting, uv when a compatible lockfile exists, and
  native Python tests.
- Solidity: preserve the repository's native Hardhat, Foundry, or specialized
  test/security workflows.

Jobs detect applicability before installing tools. Per-language CodeQL and
security-audit jobs are generated from detection; the aggregate
`Validation / Gate` keeps branch protection unambiguous for mixed-language
repositories by failing closed unless every generated check succeeds. An
empty analysis matrix while analysis is enabled fails the build instead of
silently skipping every analyzer.

## Security behavior

CodeQL is a separate workflow using GitHub's official actions. The default
`codeql: auto` policy enables it for public repositories and detects Advanced
Security availability for private repositories. When CodeQL is unavailable,
set `codeql: false` and sync: the generated caller selects an orchestrator that
omits CodeQL entirely, so pull requests do not show a skipped analyzer.
Dependency Review follows the same capability policy through
`dependency_review: auto`, but executes as a conditional step inside the
Security profile job and never registers a separate skipped pull-request
check. JavaScript, Python, and Rust audits remain available without Advanced
Security. If GitHub default setup is enabled, disable its generated CodeQL
workflow to avoid duplicate analysis.

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
