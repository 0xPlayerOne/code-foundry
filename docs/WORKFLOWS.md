# Workflow and CI conventions

## Standard triggers

The default standard callers use:

```yaml
push:
  branches: [main, staging]
pull_request:
  branches: [main, staging]
```

Draft PR automation may additionally listen to supported topic branches.
Custom deployment, indexing, search, Slither, or other workflows are
repository-owned extensions and should keep their own triggers and permissions.

## Standard workflow responsibilities

| Workflow | Responsibility |
| --- | --- |
| CI | Format, lint, type-check, and build |
| Test | Unit, integration, E2E, and smoke tests |
| Security | Profile, audits, and public-only Dependency Review |
| CodeQL | GitHub-native code scanning, kept separate from CI |
| Draft PR | Create/update development pull requests |
| Release PR | Promote `staging` into `main` |
| Release | Release Please, GitHub release, and optional npm publication |

Use concise job names such as `CI / Format`, `Test / Unit`, and
`CodeQL / Analyze (Python)`. Required checks should match the jobs actually
enabled for the repository profile.

## Merge methods

The merge audit pins one merge method per transition. `code-foundry doctor`
and `code-foundry sync` fail closed on any other strategy, and the release
workflow refuses to run unless its strategy is exactly `squash`.

| Transition | Merge method | Enforcement |
| --- | --- | --- |
| Feature/fix PR into `staging` | Squash | Contribution policy; see `CONTRIBUTING.md` |
| `staging` → `main` promotion PR | Rebase (`merge_strategy: rebase`) | `merge_strategy` must be `rebase`; merge commits are rejected |
| Release Please version PR into `main` | Squash (`release_merge_strategy: squash`) | Release automation fails closed unless `squash`; never defaults to `merge`, never uses `--admin` |

Keeping `main` linear — rebase promotions and squash release PRs — is what
lets the post-release reconciliation fast-forward or replay `staging` safely.

Protect `staging` with the aggregate `Validation / Gate`, squash-only pull
requests, and a single GitHub Actions integration bypass. That bypass exists
only so the trusted post-release reconciliation job can replay pending work
with an exact `--force-with-lease`; maintainer PATs and administrator roles do
not bypass the ruleset. The reconciliation job deliberately authenticates with
`github.token`, not `CODE_FOUNDRY_TOKEN` or `RELEASE_PLEASE_TOKEN`.

## GitHub Stacks

GitHub Stacks (stacked pull requests) is not part of this topology and does
not reduce required workflow runs. Every pull request in a stack still
triggers its own validation run, and each branch keeps its own required
checks; stacking never collapses or skips a required check in the tiered
validation gate. Land changes through the standard `staging-release` flow
instead.

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
