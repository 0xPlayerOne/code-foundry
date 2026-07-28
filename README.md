# Code Foundry

[![npm version](https://img.shields.io/npm/v/code-foundry?logo=npm&logoColor=white)](https://www.npmjs.com/package/code-foundry)
[![npm downloads](https://img.shields.io/npm/dm/code-foundry?logo=npm&logoColor=white)](https://www.npmjs.com/package/code-foundry)
[![CI](../../actions/workflows/ci.yml/badge.svg?branch=main)](../../actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/0xPlayerOne/code-foundry?logo=github)](../../releases/latest)

`code-foundry` is a versioned repository baseline for TypeScript, Rust, Python,
Solidity, and mixed-language projects. It provides language-aware workflows,
native testing, security automation, releases, hooks, repository policy, and
agent instructions from one initializer.

## Quick start

Run this from the root of a repository:

```bash
npx code-foundry init
```

Initialization is repository-aware. It detects supported languages, package
manager, profile, release strategy, and required mise tools, then writes the
resolved choices to `.github/code-foundry.yml`.

```bash
# Review or change the generated configuration, then render it
npx code-foundry sync
```

For an existing installation, use `npx code-foundry sync`. Run
`npx code-foundry doctor` to inspect the resulting repository configuration.

If `.github/code-foundry.yml` already exists, `init` uses it as the repository
contract. For normal updates, edit that file and run `npx code-foundry sync`.

## What it installs

- Short workflow callers for CI, Test, Security, CodeQL, Draft PR, Release PR,
  and Release.
- A small `.githooks/pre-commit` launcher with language-aware formatting and
  linting.
- `.mise.toml`, optional `mise.lock`, repository profile configuration, and
  standard GitHub forms and policy files.
- AGENTS instructions, CODEOWNERS, license/notice files, and reusable release
  configuration.

The workflow implementation lives in the versioned runtime repository. A
consumer repository keeps only the callers and the small local entrypoints it
needs. Custom workflows—such as deployment, indexing, Slither, or search—are
preserved and can coexist with the standard baseline.

## Configuration

The generated configuration is the one place to control the baseline. See
[Configuration reference](docs/CONFIGURATION.md) for the visual configuration
guide and [Initialization and synchronization](docs/INITIALIZATION.md) for
the two-command workflow.

New repositories default to AGPL-3.0-or-later. Synchronization preserves an
existing license unless a replacement is explicitly selected. Authored
documentation, application files, custom workflows, and existing `.mise.toml`
files are preserved by default.

## Workflow model

The standard workflow triggers are:

- Pushes to `main` and `staging`.
- Pull requests targeting `staging`.
- Draft PR automation for supported feature/fix branches.

Jobs are language-aware and skip irrelevant setup while remaining visible as
successful required checks. TypeScript uses ESLint, Prettier, and Bun's native
test runner. Rust uses `rustfmt`, Clippy with warnings as errors, and native
Cargo tests. Python uses Ruff, uv/pip-compatible setup, and native Python
tests. Solidity projects retain their native toolchain and test runner.

CodeQL remains separate from CI and Security. Dependency Review is isolated in
Security and is skipped where GitHub does not support it, while JavaScript,
Python, and Rust audits remain available without GitHub Advanced Security.

See [Workflow and CI conventions](docs/WORKFLOWS.md) for triggers, required
checks, runners, coverage, caching, and custom workflow extensions.

## Releases and publishing

The standard flow promotes `staging` into `main`, lets Release Please open a
versioned release PR, and creates a GitHub release after that PR is merged.
npm publication is opt-in through `npm_publish: true` and supports npm trusted
publishing or an `NPM_TOKEN` fallback.

Read [Release management](docs/RELEASES.md) and
[Publishing packages](docs/PUBLISHING.md) before enabling automated
publishing. They are intentionally written with placeholders so they can be
copied into other repositories.

## Documentation and extensions

The `docs/` directory contains generalized operational guides. Add
repository-specific documentation there as well; synchronization does not
replace files in `docs/`.

- [Documentation index](docs/README.md)
- [Initialization and synchronization](docs/INITIALIZATION.md)
- [Workflow and CI conventions](docs/WORKFLOWS.md)
- [Release management](docs/RELEASES.md)
- [Publishing packages](docs/PUBLISHING.md)
- [Caching and remote caching](docs/CACHING.md)

## License

Unless a repository says otherwise, new material is licensed under the GNU
Affero General Public License v3.0-or-later. See [LICENSE](LICENSE) and
[NOTICE](NOTICE).
