# Configuration reference

Code Foundry has one repository-owned control plane: `.github/code-foundry.yml`.

```bash
npx code-foundry init
```

Initialization detects the repository and writes a fully resolved configuration.
Edit that file directly, then run `npx code-foundry sync`.

The default `toolchain: auto` reuses an existing `.mise.toml`; otherwise it
selects native setup for the detected languages. Use `toolchain: native` to
prohibit mise or `toolchain: mise` to require it.

## Configuration flow

```text
repository manifests and source
            |
            v
  .github/code-foundry.yml
            |
            +--> native or mise toolchain setup
            +--> standard workflow callers
            +--> runtime repository and version
            +--> release, license, cache, and coverage policy
```

## Core settings

| Key | Values | Purpose |
| --- | --- | --- |
| `profile` | `auto`, `application`, `monorepo`, `minimal` | Repository shape |
| `languages` | detected list | TypeScript, Rust, Python, Solidity |
| `package_manager` | `bun`, `pnpm`, `yarn`, `npm`, `none` | JavaScript setup |
| `toolchain` | `auto`, `native`, `mise` | Environment setup policy; defaults to `auto` |
| `features` | `all` or a list | Standard workflow callers |
| `codeql` | `auto`, `true`, `false` | CodeQL policy; public repositories default to enabled, non-public repositories default to disabled |
| `codeql_rust_shards` | JSON array of paths | Rust scan scopes; `["all"]` keeps the safe single full scan |
| `codeql_rust_threads` | integer, 1-64 | Threads per Rust CodeQL job; values above 1 opt into local parallelism |
| `codeql_rust_max_parallel` | integer, 1-8 | Maximum Rust shard jobs allowed to run concurrently |
| `dependency_review` | `auto`, `true`, `false` | Dependency Review policy; public repositories default to enabled, non-public repositories default to disabled |
| `prune_standard` | `true` or `false` | Remove disabled standard callers |
| `runtime_repository` | `OWNER/REPO` | Reusable workflow source |
| `runtime_ref` | tag or branch | Reusable workflow version |
| `release_type` | `node`, `python`, `rust`, `simple`, `none` | Release strategy |
| `npm_publish` | `true` or `false` | Opt into npm publication |
| `license` | `gpl-3.0-or-later`, `agpl-3.0-or-later`, `mit`, `preserve`, `none` | License policy; new repositories default to GPLv3 |
| `git_workflow` | `staging-release` | Branch/release model; the standard model promotes `staging` into `main` |
| `merge_strategy` | `rebase`, `squash`, `merge` | Preferred merge method for contribution and release PRs; defaults to `rebase` |
| `runner` fields | GitHub runner names | Per-workflow runner policy |

Supported features are `ci`, `codeql`, `security`, `test`, `draft-pr`,
`release-pr`, `release`, and `dependabot`.

## Editing workflow

`init` creates the file and renders the baseline. `sync` reads the file and
refreshes standard files from the configured runtime. Generated callers are
short and replaceable; custom workflows and project documentation are kept.

The generated configuration includes all defaults so humans and agents can
understand the repository without memorizing flags or environment variables.

Rust CodeQL defaults to one full scan with one worker. Large multi-crate
repositories can opt into bounded parallelism, for example:

```yaml
codeql_rust_shards: '["crates/api","crates/worker"]'
codeql_rust_threads: 2
codeql_rust_max_parallel: 2
```

Each scoped shard must contain tracked Rust source. Code Foundry rejects
absolute paths, parent traversal, duplicates, empty scopes, and more than eight
shards. Do not split a single crate by arbitrary non-Rust directories: use
`["all"]` when complete, non-overlapping source scopes are not available.
