# Repository Template

Reusable baseline for TypeScript, Rust, Python, and mixed-language projects.

## Setup

1. Install [mise](https://mise.jdx.dev/) and run `mise install`.
2. Enable repository hooks with `git config core.hooksPath .githooks`.
3. Update the project-specific commands in `.github/workflows/ci.yml` when the repository needs a non-standard build or test command.

The repository name, owner, branch names, and release metadata are resolved by GitHub Actions at runtime through `${{ github.* }}` values. Keep organization-specific details out of this baseline.

## License

Unless a repository says otherwise, new material is licensed under the GNU Affero General Public License v3.0-or-later. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
