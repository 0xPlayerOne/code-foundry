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

Use the repository's GitHub settings or the maintainer's branch-protection
automation after reviewing the repository's enabled features:

```bash
Apply only checks for enabled workflows.
```

Keep strict status checks, linear history, and conversation resolution enabled.
For a repository with optional features disabled, do not require checks that
will never run.
