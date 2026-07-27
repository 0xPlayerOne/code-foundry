# Repository Template

Reusable baseline for TypeScript, Rust, Python, and mixed-language projects.

## Setup

1. Install [mise](https://mise.jdx.dev/).
2. Run `bash .github/scripts/bootstrap.sh` to install the pinned toolchain, enable hooks, and validate the repository.
3. Add the repository's standard scripts (`format:check`, `lint`, `type-check`, `build`, `test:unit`, `test:integration`, `test:e2e`, and `test:smoke`) when available. The shared scripts also recognize legacy aliases and skip checks that do not apply to the repository's languages or package manager.

The repository name, owner, branch names, and release metadata are resolved by GitHub Actions at runtime through `${{ github.* }}` values. Keep organization-specific details out of this baseline.

CI and hooks use Prettier and ESLint for JavaScript/TypeScript, default `rustfmt` and Clippy with warnings-as-errors for Rust, and Ruff formatting/linting for Python.

## Optional Turborepo remote caching

Turborepo repositories can use Vercel Remote Caching without changing the workflows. Add these repository settings:

- Secret: `TURBO_TOKEN`
- Repository variable: `TURBO_TEAM`

CI and Test pass those values to every job. Non-Turborepo repositories and repositories without the settings simply use their normal local cache behavior. This does not require the repository to deploy to Vercel.

## License

Unless a repository says otherwise, new material is licensed under the GNU Affero General Public License v3.0-or-later. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## GitHub security behavior

The CodeQL workflow uses GitHub's official CodeQL actions, detects Actions, TypeScript, Python, and Rust automatically, and runs each language in parallel. It runs automatically for public repositories and skips itself for private repositories unless GitHub Code Security is enabled. Dependency Review is isolated in the Security workflow and runs only for public pull requests.
