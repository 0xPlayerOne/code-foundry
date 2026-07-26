# Repository guidance

## Scope

This repository supports TypeScript, Rust, Python, or a combination of them.

## Required checks

- Keep formatting, linting, type checking, builds, tests, and coverage reproducible locally and in CI.
- Prefer the versions pinned in `mise.toml`.
- Do not commit secrets, generated credentials, local environment files, or machine-specific paths.
- Add tests for behavior changes and keep coverage thresholds explicit in the project configuration.

## Workflow changes

- Preserve least-privilege workflow permissions.
- Pin runtime/tool versions through mise rather than duplicating versions in workflows.
- Keep organization-specific deployment, hosting, and product details in the repository that owns them.
