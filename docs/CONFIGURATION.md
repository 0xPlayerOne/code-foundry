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

| Key                        | Values                                                                           | Purpose                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `profile`                  | `auto`, `application`, `monorepo`, `minimal`                                     | Repository shape                                                                                                    |
| `languages`                | detected list                                                                    | TypeScript, Rust, Python, Solidity                                                                                  |
| `package_manager`          | `bun`, `pnpm`, `yarn`, `npm`, `none`                                             | JavaScript setup                                                                                                    |
| `toolchain`                | `auto`, `native`, `mise`                                                         | Environment setup policy; defaults to `auto`                                                                        |
| `staging_validation_mode`  | `fast`, `audit`                                                                  | Staging-release-only validation tier; omitted from direct repositories                                              |
| `performance`              | `auto`, `true`, `false`                                                          | Run a deterministic performance task when a supported entrypoint exists; defaults to `auto`                         |
| `performance_command`      | JSON argv array or array of argv arrays                                          | One or more ordered commands for non-package harnesses; package scripts take precedence                             |
| `performance_profile`      | empty, `node-package`                                                            | Optional shared package import, memory, archive, and dependency budget harness                                      |
| `performance_budget_file`  | repository path                                                                  | Budget policy for the shared package harness; defaults to `performance-package-budgets.json`                        |
| `features`                 | `all` or a list                                                                  | Standard workflow callers                                                                                           |
| `codeql`                   | `auto`, `true`, `false`                                                          | CodeQL policy; public repositories default to enabled, non-public repositories default to disabled                  |
| `codeql_rust_shards`       | JSON array of paths                                                              | Rust scan scopes; `["all"]` keeps the safe single full scan                                                         |
| `codeql_rust_threads`      | integer, 1-64                                                                    | Threads per Rust CodeQL job; values above 1 opt into local parallelism                                              |
| `codeql_rust_max_parallel` | integer, 1-8                                                                     | Maximum Rust shard jobs allowed to run concurrently                                                                 |
| `dependency_review`        | `auto`, `true`, `false`                                                          | Dependency Review policy; public repositories default to enabled, non-public repositories default to disabled       |
| `prune_standard`           | `true` or `false`                                                                | Remove disabled standard callers                                                                                    |
| `runtime_repository`       | `OWNER/REPO`                                                                     | Reusable workflow source                                                                                            |
| `runtime_ref`              | tag or branch                                                                    | Reusable workflow version                                                                                           |
| `release_type`             | `node`, `python`, `rust`, `simple`, `none`                                       | Release strategy                                                                                                    |
| `npm_publish`              | `true` or `false`                                                                | Opt into npm publication                                                                                            |
| `license`                  | `gpl-3.0-or-later`, `agpl-3.0-or-later`, `apache-2.0`, `mit`, `preserve`, `none` | License policy; new repositories default to GPLv3                                                                   |
| `git_workflow`             | `direct` (default), `staging-release`                                            | Branch/release model; `direct` opens feature branches into `main`, `staging-release` promotes `staging` into `main` |
| `merge_strategy`           | `squash` (direct), `rebase` (staging-release)                                    | Feature/promotion merge policy; direct repositories require squash                                                  |
| `release_merge_strategy`   | `squash` (direct), `rebase` (staging-release)                                    | Merge method for Release Please version PRs into `main`; release automation fails closed on anything else           |
| `runner` fields            | GitHub runner names                                                              | Per-workflow runner policy, including `performance_runner`                                                          |

Supported features are `ci`, `codeql`, `security`, `test`, `draft-pr`,
`release-pr`, `release`, and `dependabot`.

## Performance validation

The shared Test workflow exposes a deterministic `Performance` job. In JavaScript
repositories it discovers `performance:check` first and `perf:check` second. Other
repositories can declare one argv array, or an ordered array of argv arrays, without
shell interpolation:

```yaml
performance: true
performance_command: '["python3","scripts/performance_audit.py","--check"]'
performance_runner: ubuntu-latest
```

The `node-package` profile adds a shared, repository-configured audit:

```yaml
performance: true
performance_profile: node-package
performance_budget_file: performance-package-budgets.json
```

```json
{
  "schemaVersion": 1,
  "importTarget": "./dist/index.js",
  "controlImport": "typebox",
  "samples": 7,
  "budgets": {
    "coldImportP95Ms": 150,
    "coldImportRssMaxBytes": 25000000,
    "packedBytes": 500000,
    "productionDependencyCount": 20
  }
}
```

Supported budgets are `coldImportP50Ms`, `coldImportP95Ms`,
`coldImportRssMaxBytes`, `coldImportRelativeP50`, `packedBytes`,
`unpackedBytes`, `packageFileCount`, `packageMapFileCount`, and
`productionDependencyCount`. The profile writes
`performance-results/node-package.json`. Every performance run also writes
`performance-results/summary.json`, including repository-owned scripts and
configured commands, so artifact consumers have one stable status contract.

`performance: false` disables discovery. Performance budgets, fixtures, mock
providers, and live endpoint credentials remain repository-owned. The shared job
owns checkout, pinned setup, billing controls, concurrency, and artifact upload;
it uploads `artifacts/performance/**`, `performance-results.json`, or
`performance-results/**` when present. Network-dependent and post-deployment
checks should remain separate from this deterministic validation task.

## OpenCode Security opt-in and opt-out

The generated OpenCode caller ships in every repository. The
`OPENCODE_SECURITY` repository or organization variable is its only enablement
control, so a scan can be toggled without a code change:

- `OPENCODE_SECURITY: true` opts the repository in.
- `OPENCODE_SECURITY: false` opts the repository out.
- unset is disabled.

The scan only runs when it is enabled and the `OPENCODE_API_KEY` secret is
present.

## Git workflow

`git_workflow` selects the branch topology:

- `direct` (default): feature branches open pull requests directly into
  `main`. Validation and security scans run on every PR. No `staging` branch
  exists, no promotion caller is generated, and `merge_strategy` must be
  `squash`. Release Please version PRs squash into `main`
  (`release_merge_strategy: squash`). Dependabot updates target `main`. This is
  the right choice when a repository has no preview or staging environment.
- `staging-release` (opt-in): feature branches squash into `staging`, a
  promotion PR rebases validated changes into `main` (`merge_strategy:
rebase`), and Release Please version PRs rebase into `main`
  (`release_merge_strategy: rebase`). Choose this only when the repository
  maintains a preview/staging environment that needs validated integration
  before release.

```yaml
# A repository with a preview/staging environment
git_workflow: staging-release
```

Any other value is rejected by `code-foundry sync` and `code-foundry doctor`.

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

## Cloudflare Workers deployments

Repositories that deploy to Cloudflare Workers can opt into GitHub-native
verified delivery (fixed `Preview`/`Production` environments, candidate
verification, and version-identity promotion) by adding a caller for the
runtime's reusable `cloudflare-delivery.yml` workflow. Use the same immutable
40-character Code Foundry commit SHA for both the reusable workflow ref and
`runtime-ref`; configure required reviewers and branch restrictions on the
`Production` environment. The workflow requires the
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets in the consumer
repository. See [Verified Cloudflare delivery](./cloudflare-delivery.md) for
binding policy, canary, rollback, and evidence requirements.

The legacy `cloudflare-deploy.yml` workflow remains available for direct
(unverified) deployments. It runs `wrangler versions upload` for previews and
`wrangler deploy` for production, records a GitHub deployment plus status, and
respects `CI_BILLING_PAUSED`. Its legacy-compatible Wrangler default is `latest`;
callers should prefer `local` or provide an exact `wrangler-version` for
reproducibility. Bun consumers may pass `build-script`, `install-working-directory`, and `bun-version`;
the runtime installs the frozen lockfile and builds the Worker before invoking
Wrangler. Bun-backed callers invoke Wrangler through `bunx` so OpenNext's
production delegation resolves the workspace-local `opennextjs-cloudflare`
binary; callers without `build-script` retain the npm/npx path.
