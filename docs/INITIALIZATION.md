# Initialization and synchronization

## Initialize, synchronize, and diagnose

Run these commands from a repository root:

```sh
npx code-foundry init
# review or edit .github/code-foundry.yml
npx code-foundry sync
npx code-foundry doctor  # optional local/GitHub prerequisite check
```

`init` detects supported languages, package manager, repository profile, release
strategy, toolchain preference, and standard features. It writes the resolved
choices to `.github/code-foundry.yml`, initializes the local environment, and
renders the standard baseline.

After reviewing or editing the configuration, run `sync` to apply it. Run sync
again whenever `runtime_ref` changes or a newer reviewed runtime should be
adopted. `doctor` is an optional diagnostic pass; use `npx code-foundry doctor
--github` when authenticated GitHub prerequisite checks are also needed.

## Detection

Supported languages are TypeScript, Rust, Python, and Solidity. Detection uses
manifests, lockfiles, source extensions, workspace metadata, and existing
project scripts. The generated values are explicit, so later syncs are stable
until a maintainer changes the file.

New repositories receive GPL-3.0-or-later. Existing repositories with an
authored `LICENSE` keep that license unless the generated configuration is
changed.

## Runtime selection

Workflow callers use `runtime_repository` and `runtime_ref` from
`.github/code-foundry.yml`. Change those values directly for a fork or staged
runtime, then run sync.

## Preservation rules

Sync updates standard Code Foundry files only. It preserves application code,
authored documentation, existing `.mise.toml` selections, and custom workflows
such as deployment, search, Slither, or monitoring workflows. A missing
`AGENTS.md` receives the baseline agent contract. If another initializer has
created an unmarked `AGENTS.md` or `.github/CONTRIBUTING.md`, sync preserves its
surrounding text and adds or refreshes only the marked Code Foundry policy block;
this lets later syncs restore mandatory pull-request rules without replacing
agent-specific instructions. Marked generated policy documents continue to
receive topology-aware baseline updates, and missing configuration keys are
added without changing existing values. The Oxfmt baseline also ignores
`plugin.json`, whose serialization is owned by Release Please; plugin manifest
semantics remain covered by repository tests rather than a formatter rewrite.

The environment bootstrap enables repository hooks and uses mise only when an
existing `.mise.toml` is present or `toolchain: mise` is selected. Otherwise it
uses the repository's native tools. Use `npx code-foundry doctor` when local
setup needs to be checked; the CLI supplies the implementation without adding
maintenance scripts to the consumer repository.
