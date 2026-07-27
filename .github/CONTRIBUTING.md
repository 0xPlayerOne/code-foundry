# Contributing

Welcome. This document is the reusable contribution guide for TypeScript, Rust, Python, and mixed-language repositories using this template.

- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Security Policy](./SECURITY.md)
- [Pull Request Template](./PULL_REQUEST_TEMPLATE.md)

## 1. Branching model

```text
main  ----------------------------------------- protected release branch
  ^ staging -> main release PR
staging -------------------------------------- integration branch
  ^ feature/fix -> staging pull request
feat/* fix/* chore/* refactor/* docs/* test/*  working branches
```

### `main`

- Treat `main` as the protected release branch.
- Merge into `main` through the release pull request from `staging`.
- Require all configured quality and security checks before merging.
- Do not force-push or bypass branch protection.

### `staging`

- Use `staging` as the integration branch and pull request target.
- Feature branches may be merged by squash merge after applicable checks pass.
- Direct pushes are reserved for small fixes or documented emergencies.
- After a release, keep `staging` aligned with `main` to reduce future conflicts.

### Working branches

- Branch from `staging`, not `main`.
- Use a descriptive prefix: `feat/`, `fix/`, `chore/`, `refactor/`, `docs/`, or `test/`.
- Keep commits focused and use [Conventional Commits](https://www.conventionalcommits.org/) when no repository-specific convention exists.

## 2. Development setup

### Prerequisites

- `git`
- [mise](https://mise.jdx.dev/) for the pinned toolchain
- The package manager and language tools used by the repository

### One-time setup

```sh
git clone <repository-url>
cd <repository-directory>
mise install
git config core.hooksPath .githooks
```

Install dependencies using the repository's existing lockfile and package manager. If `.env.example` exists, copy it to the appropriate local environment file and fill in local values. Never commit secrets.

## 3. Local quality checks

Run the applicable shared checks before opening a pull request:

```sh
bash .github/scripts/ci.sh format
bash .github/scripts/ci.sh lint
bash .github/scripts/ci.sh type_check
bash .github/scripts/ci.sh build
bash .github/scripts/ci.sh unit
bash .github/scripts/ci.sh integration
```

The scripts detect supported package managers and skip checks that do not apply. A repository may add stricter project-specific commands. Do not use `--no-verify` to hide a failing hook; fix the underlying issue.

## 4. Contribution workflow

### Internal contributors

1. Update the integration branch: `git checkout staging && git pull origin staging`.
2. Create a focused working branch.
3. Make the change, update documentation and tests, and run applicable checks.
4. Commit and push the branch.
5. Open a pull request targeting `staging` and complete the pull request template.
6. Address failures or review feedback, then squash-merge after required checks pass.

### External contributors

1. Fork the repository and add the upstream remote.
2. Branch from the upstream `staging` branch.
3. Keep the change focused and follow the repository's contribution and security policies.
4. Open a pull request targeting `staging` with reproduction steps, tests, and relevant context.

## 5. CI and workflow discipline

The standard triggers are:

| Event | Workflows |
| --- | --- |
| Push to `main` or `staging` | CI, Test / Unit, Test / Integration, Security, CodeQL |
| Pull request targeting `staging` | CI, Test / Unit, Test / Integration, Security, CodeQL |
| Weekly schedule | CodeQL |
| Feature branch push | Draft PR Workflow |
| Push to `staging` | Release PR Workflow |
| Version tag | Release |

Push checks cover branch commits and pull request checks cover feature-branch changes targeting `staging`; this keeps the standard path from running the same branch check twice. Concurrency cancels superseded runs for the same workflow and branch or pull request while allowing independent workflows to run in parallel.

Security checks may be skipped when GitHub plan or repository visibility does not support them. A skipped optional security check must not be made a required branch-protection check.

## 6. Pull request and review standards

- Explain what changed, why it changed, and how it was validated.
- Link related issues and use `Closes #123` when appropriate.
- Call out migrations, environment changes, compatibility, security/privacy impact, deployment, rollback, and follow-up work.
- Include screenshots or recordings for user-facing changes when useful.
- Keep pull requests focused; split large changes when practical.
- Reviewers should focus on correctness, security, maintainability, test coverage, and operational impact.

## 7. Merge and release protocol

| From | To | Method | Gate |
| --- | --- | --- | --- |
| Working branch | `staging` | Squash merge | Required applicable checks |
| `staging` | `main` | Release pull request | All required checks and release review |

Release pull requests should summarize the commits since `main`, note migrations and risks, and confirm that staging validation is current. Delete merged working branches when practical.

## 8. Emergency procedures

For an urgent production or security issue, create a focused branch from `staging`, document the urgency, open a pull request, and run the narrowest complete validation available. CI bypasses are for infrastructure emergencies only and require a follow-up fix within the next maintenance cycle.

Report vulnerabilities privately using [SECURITY.md](./SECURITY.md), never in a public issue or pull request.
