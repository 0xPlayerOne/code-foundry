# Repo Foundry

`repo-foundry` is a repository factory for TypeScript, Rust, Python, Solidity,
and mixed-language projects. It installs agent-ready instructions, fast native
testing, security automation, release workflows, hooks, and repository policy
from one versioned package.

## Quick start

```bash
npx repo-foundry init
```

Or select the project profile explicitly:

```bash
npx repo-foundry init \
  --languages typescript,python \
  --features all \
  --package-manager bun
```

Use `repo-foundry sync` to update an existing repository and
`repo-foundry doctor` to validate it. Add `--dry-run` to preview changes.

## Setup

1. Install [mise](https://mise.jdx.dev/).
2. Run `bash .github/scripts/bootstrap.sh` to install the pinned toolchain, enable hooks, and validate the repository.
3. Add the repository's standard scripts (`format:check`, `lint`, `type-check`, `build`, `test:unit`, `test:integration`, `test:e2e`, and `test:smoke`) when available. The shared scripts also recognize legacy aliases and skip checks that do not apply to the repository's languages or package manager.

## Applying the baseline to an existing repository

Run the sync script from the repository root. It updates shared workflows, GitHub forms, hooks, policy files, and tool configuration while preserving the repository's README, `.mise.toml` selections, extra workflows, and application code.

```bash
bash .github/scripts/init-repo.sh
```

Use `bash .github/scripts/sync-template.sh --source ... --check` to preview differences. For local template development, pass the template checkout as `--source` and `--ref staging`.

The initializer is intentionally flag-driven so the same baseline can be used as a small repository package. Language selection controls CodeQL and records the repository profile; feature selection controls which standard workflows are installed. `auto` detects supported languages, while `all` enables every standard workflow.

```bash
# Preview a TypeScript + Python repository without changing files
bash .github/scripts/init-repo.sh \
  --languages typescript,python \
  --features all \
  --dry-run

# Initialize a Rust repository with only the core automation
bash .github/scripts/init-repo.sh \
  --languages rust \
  --features ci,codeql,security,test
```

Supported languages are `typescript`, `rust`, `python`, and `solidity`. Supported feature flags are `ci`, `codeql`, `security`, `test`, `draft-pr`, `release-pr`, `release`, and `dependabot`. Use `--prune` only when you explicitly want disabled standard workflows removed; custom workflows are always preserved. The selected profile is stored in `.github/template.yml`, which makes later syncs repeatable and lets workflows consume repository-specific settings without duplicating the template scripts.

## Releases and publishing

The standard release workflow uses [Release Please](https://github.com/googleapis/release-please) after changes reach `main`. It opens or updates a versioned release pull request, maintains `CHANGELOG.md`, creates the GitHub release after that PR is merged, and applies semantic version bumps from Conventional Commits. The reusable `release-please-config.json` groups feature, fix, performance, dependency, documentation, test, CI, and maintenance changes in generated notes:

- `fix:` → patch, such as `1.2.3` → `1.2.4`
- `feat:` → minor, such as `1.2.3` → `1.3.0`
- `feat!:`, `fix!:`, or `BREAKING CHANGE:` → major, such as `1.2.3` → `2.0.0`

Before `1.0.0`, `feat:` intentionally increments the minor version. This keeps pre-1.0 releases useful without treating every feature as a breaking major.

Use `Release-As: 2.0.0` in a commit or pull request body when a specific version is required. Existing `CHANGELOG.md` files are preserved by sync and remain repository-owned.

Release behavior is configured in `.github/template.yml`:

```yaml
release_type: auto   # auto, node, python, rust, simple, or none
npm_publish: false   # true only for a package published to npm
```

`auto` selects the first matching package type (`package.json`, `pyproject.toml`, `Cargo.toml`, or `version.txt`). Use `none` when the repository should not release automatically. Solidity-only repositories use `simple` with a root `version.txt`. For a repository containing multiple independently released packages, add a Release Please manifest/configuration and select the appropriate Release Please strategy rather than treating the repository as one package.

GitHub Actions needs permission to open release pull requests. Configure a repository or organization secret named `RELEASE_PLEASE_TOKEN` containing a narrowly scoped token or GitHub App token if the default `GITHUB_TOKEN` is not allowed to create pull requests. Keep `contents`, `issues`, and `pull-requests` permissions enabled for the release workflow.

For npm publication, set `npm_publish: true` and configure npm trusted publishing (recommended) for this repository’s `release.yml` workflow, or provide an `NPM_TOKEN` secret. The workflow detects which method is configured, and publication occurs only after Release Please creates a release tag, so ordinary pushes cannot publish packages. Keep `publishConfig.access` in `package.json` aligned with the package’s intended visibility; the baseline publishes public packages. If npm publication is enabled without either configuration, the publish job fails instead of silently skipping the release.

The release flow is: promote `staging` into `main`; let Release Please open or update the version/changelog PR; merge that PR to create the GitHub release and tag; then publish to npm only when `npm_publish: true`.

For a repository that does not yet contain the scripts, the initializer can be invoked directly from the published template checkout or a downloaded copy of `init-repo.sh`; it fetches the matching sync helper automatically. The generated `.github/template.yml` is the stable configuration contract for a future npm/package wrapper around these same operations.

Branch protection is an administrator operation and is opt-in:

```bash
bash .github/scripts/init-repo.sh --protection
```

The protection helper preserves unrelated provider checks, replaces stale template check names, and skips CodeQL analysis checks for private repositories where the workflow is intentionally skipped.

The repository name, owner, branch names, and release metadata are resolved by GitHub Actions at runtime through `${{ github.* }}` values. Keep organization-specific details out of this baseline.

CI and hooks use Prettier and ESLint for JavaScript/TypeScript, default `rustfmt` and Clippy with warnings-as-errors for Rust, and Ruff formatting/linting for Python.

The initializer generates a minimal `.mise.toml` from the selected language and package-manager profile instead of installing every supported tool on every runner. TypeScript/Solidity profiles always pin Node and add Bun only for Bun projects; npm, pnpm, and Yarn use Node/Corepack. CI and Security also honor an explicit `package_manager` profile before inspecting lockfiles. Existing `.mise.toml` files are preserved. Initialization also generates a committed `mise.lock` when mise is available; CI then installs exact tool URLs and checksums without repeating registry/API resolution. Workflow setup restores lockfile-keyed package caches for Bun/npm/pnpm/Yarn, Cargo, and pip; cache misses remain safe because dependencies are always re-created from their lockfiles or manifests.

Rust profiles declare `rustfmt` and `clippy` as mise components, so they are installed once with the cached toolchain instead of being added separately by each formatting or lint job. Rust repositories also cache `target/` and Cargo-installed audit tools separately: build/dependency caches follow project lockfiles, while audit-tool caches follow the toolchain and security script so dependency updates do not reinstall the scanner. Cargo fingerprints invalidate stale objects safely, while keeping build caches separate prevents a large Rust build from displacing dependency-download caches or parallel jobs from racing to save one partial cache.

When an exact `Cargo.lock` dependency cache is restored, CI enables Cargo offline mode for compilation and tests, eliminating avoidable registry/index checks. Cache misses continue using normal online resolution.

Applicable jobs also cache installed JavaScript dependencies, Corepack package-manager shims, ESLint state, Prettier state, and Python virtual environments by manifest/configuration hash. Mutable installed environments use exact-key restores only, preventing a lockfile change from downloading stale `node_modules` or a stale virtual environment that must then be replaced. Corepack remains warm even when an installed-dependency cache is already a hit; npm and pnpm installs prefer restored package stores and npm skips redundant audit/funding work because Security runs the authoritative dependency audit separately. The generic ESLint and Prettier fallbacks enable content-based built-in caches so restored lint/format state survives fresh Git checkouts; repository-defined scripts remain authoritative. Cache misses always fall back to a clean install; cached environments must never contain credentials or generated secrets.

When a repository uses multiple supported ecosystems, JavaScript, Rust, and Python dependency installation runs concurrently inside each setup job. A failure in any installer still fails the job after all active installers finish, preserving complete diagnostics without making network waits additive.

E2E jobs cache Playwright, Cypress, and Puppeteer browser directories by dependency/configuration hash, avoiding repeated browser downloads while invalidating safely when the browser configuration or lockfiles change. Coverage artifacts are uploaded only when a test actually produces coverage output.

Repositories with Turborepo automatically cache local `.turbo/cache` results per workflow job and dependency/configuration hash. Fallback restores can reuse valid artifacts produced by another workflow job, while Turbo’s task hashes discard stale results. Vercel Remote Caching remains available through `TURBO_TOKEN` and `TURBO_TEAM`; the local cache provides a fast fallback when remote caching is not configured.

New Python profiles include pinned `uv` as an accelerated, pip-compatible installer. Existing repositories without `uv` continue using pip automatically, so adopting the template does not require changing their dependency files or lockfile format.

Python Security audits use cached `uv tool run` environments for `pip-audit` when uv is available, with the same pip fallback used by CI installation. Independent `requirements.txt` and `requirements-dev.txt` audits run concurrently and aggregate failures. When the combined Security fallback is used, JavaScript, Rust, and Python audits also run concurrently and still report a failure if any ecosystem audit fails.

CI and Test jobs perform a source-only applicability check before setup. Empty integration, E2E, smoke, or language-specific jobs remain visible as successful required checks but skip runner tool installation and dependency setup.

The shared setup action accepts `install-javascript`, `install-python`, and `install-rust` switches. They default to `true` for compatibility, while the standard CI jobs disable ecosystems that their task cannot use: formatting skips project Cargo/Python installs, and lint, type-check, and build skip Python dependency installation. Test jobs keep all ecosystem installs enabled because project test suites may cross language boundaries. Mise tool installation defaults to `auto`, so each job installs only configured tools for languages actually detected in the repository; callers can use `mise-scope: all` when a task intentionally spans every configured ecosystem.

It also accepts `mise-scope` (`auto`, `all`, `javascript`, `python`, or `rust`). Security's parallel ecosystem matrix uses this to install only the active language toolchain and restore only its package caches; callers that omit it get automatic profile-based tool selection, while `all` remains available for tasks that intentionally span every configured ecosystem.

Lightweight orchestration jobs use GitHub's `ubuntu-slim` runner: Draft PR, Release PR, release detection, Release Please, npm publication, dependency review, CodeQL language detection, and dependency audits. Build, test, and CodeQL analysis jobs remain on full `ubuntu-latest` runners because they may compile or analyze larger projects and benefit from multiple CPUs.

Release and Security metadata jobs also use blobless checkouts where a checkout is needed, reducing source transfer while preserving on-demand manifest access.

CodeQL keeps every configured language check visible but skips analyzers whose source, dependencies, or configuration were untouched by a push or pull request. Unchanged analyzer jobs use `ubuntu-slim` and skip both checkout and analysis while remaining visible to branch protection; changed analyzers use full `ubuntu-latest` runners. Its detection job uses a `blob:none` partial clone because it only needs Git paths and metadata. Scheduled and manually dispatched CodeQL runs remain full scans.

Coverage is enforced at 80% for Python and Bun test suites when those ecosystems expose coverage support. Rust projects must keep their native test suites green; repositories with `cargo-llvm-cov` should enforce the same 80% line target in their Cargo coverage configuration.

## Test runner standard

For TypeScript and JavaScript tests, use Bun's native test runner by default. Do not add Vitest to projects based on this template. Preserve specialized native runners such as Matchstick for The Graph and Hardhat for smart contracts.

## Optional Turborepo remote caching

Turborepo repositories can use Vercel Remote Caching without changing the workflows. Add these repository settings:

- Secret: `TURBO_TOKEN`
- Repository variable: `TURBO_TEAM`

CI and Test pass those values to every job. Non-Turborepo repositories and repositories without the settings simply use their normal local cache behavior. This does not require the repository to deploy to Vercel.

## License

Unless a repository says otherwise, new material is licensed under the GNU Affero General Public License v3.0-or-later. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## GitHub security behavior

The CodeQL workflow uses GitHub's official CodeQL actions, detects Actions, TypeScript, Python, and Rust automatically, and runs each language in parallel. It runs automatically for public repositories and skips itself for private repositories unless GitHub Code Security is enabled. Dependency Review is isolated in the Security workflow and runs only for public pull requests.
