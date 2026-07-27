# Contributing

Thank you for contributing. This repository supports TypeScript, Rust, Python, and mixed-language projects.

## Branching model

- `main` is the protected release branch. Merge into it through the release PR from `staging`.
- `staging` is the integration branch. Feature and fix branches target `staging`.
- Use descriptive prefixes such as `feat/`, `fix/`, `chore/`, `refactor/`, `docs/`, and `test/`.
- Do not push directly to `main` unless repository administrators have explicitly documented an emergency exception.

## Development setup

1. Install [mise](https://mise.jdx.dev/) and run `mise install`.
2. Enable the repository hooks with `git config core.hooksPath .githooks`.
3. Install dependencies using the lockfile and package manager already used by the repository.
4. Copy `.env.example` to the appropriate local environment file when one is provided. Never commit secrets.

Before opening a pull request, run the applicable checks locally:

```sh
bash .github/scripts/ci.sh format
bash .github/scripts/ci.sh lint
bash .github/scripts/ci.sh type_check
bash .github/scripts/ci.sh build
bash .github/scripts/ci.sh test
```

The shared scripts skip checks that do not apply to the repository. Project-specific commands may add stricter checks.

## Pull requests

- Open pull requests against `staging`, not `main`.
- Keep changes focused and explain what changed, why, validation performed, and any migration or rollback concerns.
- Link related issues and use `Closes #123` when the pull request resolves one.
- Follow [Conventional Commits](https://www.conventionalcommits.org/) for commit messages when the repository does not document another convention.
- Update documentation and tests when behavior changes.
- Do not include secrets, generated artifacts, unrelated formatting, or changes from another package manager.

## Review and merge rules

- Required CI and security checks must pass before merging.
- Squash-merge feature branches into `staging` unless the repository documents another strategy.
- Release pull requests merge `staging` into `main` after the staging checks are green.
- Do not bypass hooks, required checks, or branch protections to resolve ordinary failures.

## Security and emergencies

Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md), never in a public issue.

For an urgent production or security fix, create a focused branch from `staging`, open a pull request, and document the urgency and validation. CI bypasses are for documented infrastructure emergencies only and require a follow-up fix.
