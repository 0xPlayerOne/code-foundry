# Repository Template

Reusable baseline for TypeScript, Rust, Python, and mixed-language projects.

## Setup

1. Install [mise](https://mise.jdx.dev/) and run `mise install`.
2. Enable repository hooks with `git config core.hooksPath .githooks`.
3. Add the repository's standard scripts (`format:check`, `lint`, `type-check`, `build`, `test:unit`, `test:integration`, `test:e2e`, and `test:smoke`) when available. The shared scripts also recognize legacy aliases and skip checks that do not apply to the repository's languages or package manager.

The repository name, owner, branch names, and release metadata are resolved by GitHub Actions at runtime through `${{ github.* }}` values. Keep organization-specific details out of this baseline.

## License

Unless a repository says otherwise, new material is licensed under the GNU Affero General Public License v3.0-or-later. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## GitHub security behavior

The CodeQL workflow uses GitHub's official CodeQL actions, detects Actions, TypeScript, Python, and Rust automatically, and runs each language in parallel. It runs automatically for public repositories and skips itself for private repositories unless GitHub Code Security is enabled. Dependency Review is isolated in the Security workflow and runs only for public pull requests.
