# Initialization and synchronization

## The two-command workflow

Run these commands from a repository root:

```bash
npx code-foundry init
npx code-foundry sync
npx code-foundry doctor
```

`init` detects supported languages, package manager, repository profile,
release strategy, mise tools, and standard features. It writes the resolved
choices to `.github/code-foundry.yml`, initializes the local environment, and
renders the standard baseline.

After reviewing or editing the configuration, run `sync` to apply it. Sync can
be run at any time to pull in a newer runtime configured by `runtime_ref`.

## Detection

Supported languages are TypeScript, Rust, Python, and Solidity. Detection uses
manifests, lockfiles, source extensions, workspace metadata, and existing
project scripts. The generated values are explicit, so later syncs are stable
until a maintainer changes the file.

## Runtime selection

Workflow callers use `runtime_repository` and `runtime_ref` from
`.github/code-foundry.yml`. Change those values directly for a fork or staged
runtime, then run sync.

## Preservation rules

Sync updates standard Code Foundry files only. It preserves application code,
authored documentation, existing `.mise.toml` selections, and custom workflows
such as deployment, search, Slither, or monitoring workflows.

The environment bootstrap installs or reuses mise-managed tools, enables the
repository hooks, and runs the repository doctor. Re-run
`bash .github/scripts/bootstrap.sh` if local tools need to be repaired.
