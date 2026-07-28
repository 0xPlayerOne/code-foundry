# Initialization and synchronization

## Commands

Run the package from a repository root:

```bash
npx code-foundry init [options]
npx code-foundry sync [options]
npx code-foundry doctor
```

When `.github/code-foundry.yml` already exists, `init` treats it as the primary
configuration and does not replace its values with CLI defaults. To use another
file, pass it explicitly:

```bash
npx code-foundry init --config ./configs/code-foundry.yml
```

The file is copied to `.github/code-foundry.yml`, normalized, and used to render
the standard callers. Later edits can be applied with `npx code-foundry sync`.

Use `--dry-run` to preview changes. Use `--no-bootstrap` when the repository is
being initialized in CI or on a machine without mise. Run
`bash .github/scripts/bootstrap.sh` later to install tools, enable hooks, and
run the repository doctor.

## Profiles and features

Supported languages are `typescript`, `rust`, `python`, and `solidity`.
`--languages auto` detects them from manifests and source files. Profiles are
`auto`, `application`, `monorepo`, and `minimal`.

Standard features are `ci`, `codeql`, `security`, `test`, `draft-pr`,
`release-pr`, `release`, and `dependabot`. `all` enables every standard
feature. `--prune` removes disabled standard workflows only; it never removes
custom workflows.

## Runtime selection

Reusable workflow callers require a literal repository and ref. By default,
the initializer derives the runtime repository from the source template. Use
these options for a fork or a staged runtime:

```bash
npx code-foundry init \
  --runtime-repository OWNER/REPO \
  --runtime-ref v1.2.3
```

Both values are persisted in `.github/code-foundry.yml` and rendered into the
standard callers. `REPO_FOUNDRY_RUNTIME_REPOSITORY` and
`REPO_FOUNDRY_RUNTIME_REF` provide equivalent environment/repository-variable
overrides.

## Safety rules

Synchronization preserves authored README and policy documents, existing
`.mise.toml` selections, application code, custom workflows, and repository
documentation. Existing licenses are preserved unless a license or license
file is explicitly selected. Use `--force` only when intentionally refreshing
protected standard documents.

The initializer generates `.github/code-foundry.yml` as the repository-owned
configuration contract. Keep project-specific settings there rather than
editing generated workflow callers by hand.
