# Configuration reference

Code Foundry has one repository-owned control plane:
`.github/code-foundry.yml`. `init` creates it, `sync` renders the selected
baseline, and `doctor` checks local and GitHub-facing prerequisites.

```sh
npx code-foundry init
# edit .github/code-foundry.yml
npx code-foundry sync
npx code-foundry doctor
```

The generated file is deliberately explicit. Keep it under version control and
change it directly rather than passing one-off flags to `sync`.

## How configuration is applied

```text
repository manifests and source
            |
            v
  .github/code-foundry.yml
            |
            +--> detected language and package-manager setup
            +--> standard workflow callers
            +--> runtime repository and version
            +--> validation, release, license, and cache policy
```

`toolchain: auto` reuses an existing `.mise.toml`; otherwise it uses native
language tooling. Set `toolchain: native` to prohibit mise or `toolchain: mise`
to require an existing mise configuration.

## Repository and runtime

| Key                     | Values                                       | Notes                                                                |
| ----------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| `version`               | `1`                                          | Configuration schema version.                                        |
| `profile`               | `auto`, `application`, `monorepo`, `minimal` | Repository shape; `auto` detects it.                                 |
| `languages`             | comma-separated language names               | Supported values are `typescript`, `rust`, `python`, and `solidity`. |
| `package_manager`       | `bun`, `pnpm`, `yarn`, `npm`, `none`         | JavaScript package-manager policy.                                   |
| `toolchain`             | `auto`, `native`, `mise`                     | Environment setup policy.                                            |
| `runtime_repository`    | `OWNER/REPO`                                 | Source of reusable workflows and runtime code.                       |
| `runtime_ref`           | tag or commit                                | Runtime version used by generated callers.                           |
| `features`              | `all` or a list                              | See [Feature selection](#feature-selection).                         |
| `draft_protection`      | `true`, `false`                              | Skip generated runner-heavy gates for draft PRs when false.          |
| `codeql`                | `auto`, `true`, `false`                      | Enable CodeQL when the repository and GitHub plan support it.        |
| `dependency_review`     | `auto`, `true`, `false`                      | Enable Dependency Review when supported.                             |
| `runner` and `*_runner` | GitHub runner labels                         | Override the default runner per workflow.                            |

For `codeql: auto` and `dependency_review: auto`, public repositories use the
available GitHub security checks and private repositories require the relevant
capability. Set either key to `false` when the check is unavailable or not
wanted. CodeQL is omitted from the generated validation caller; Dependency
Review remains a conditional step inside Security rather than a separate check.

Code Foundry runner-heavy validation, security, qualification, and Cloudflare
Deployment jobs protect draft pull requests by default. The `draft_protection`
configuration key defaults to `true`; set it to `false` only when the repository
intentionally runs generated gates for draft PRs. Cloudflare reusable-workflow
callers use their equivalent `draft-protection` input. These opt-outs affect
CI/deployment gates only and do not disable Draft Guard or draft-PR automation.

## Feature selection

Use `features: all` or a comma/space-separated list. The canonical validation
feature is `validation`; the legacy names `ci`, `test`, `security`, and `codeql`
remain aliases for compatibility. Other selectable features are:

- `draft-pr` — create or update development pull requests.
- `release-pr` — promote `staging` into `main` in the `staging-release` topology.
- `release` — run Release Please and optional package publication.
- `dependabot` — install the language-aware Dependabot configuration.

The release-integrity and OpenCode Security callers are installed independently
of feature selection. OpenCode Security is disabled unless the repository or
organization variable `OPENCODE_SECURITY` is `true` and the
`OPENCODE_API_KEY` secret exists. `opencode_security_model` optionally replaces
the generated scanner model.

Merge queues are a separate opt-in because they need a stable runtime pin:

```yaml
merge_queue: true
```

See [Merge queue validation](merge-queues.md) before enabling it.

## Validation and quality

| Key                       | Values                                         | Purpose                                                                         |
| ------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `performance`             | `auto`, `true`, `false`                        | Discover, require, or disable performance checks.                               |
| `performance_command`     | JSON argv array or array of argv arrays        | Ordered commands for a non-package performance harness.                         |
| `performance_profile`     | empty or `node-package`                        | Shared package import, memory, archive, and dependency audit.                   |
| `performance_budget_file` | repository-relative path                       | Budget file for `node-package`; defaults to `performance-package-budgets.json`. |
| `required_capabilities`   | comma-separated task names                     | Fail closed when a required task or coverage evidence is unavailable.           |
| `coverage_enforcement`    | `auto`, `required`, `off`                      | Shared coverage-report policy.                                                  |
| `coverage_minimum`        | `0`–`100`                                      | Minimum percentage; defaults to `80`.                                           |
| `coverage_metrics`        | `lines`, `functions`, `branches`, `statements` | Metrics checked by the coverage gate.                                           |
| `coverage_report`         | comma-separated repository paths               | Istanbul JSON summary or LCOV evidence files.                                   |

Supported task capabilities are `format`, `lint`, `type_check`, `build`, `unit`,
`integration`, `e2e`, `smoke`, and `performance`. `coverage` is a policy
capability that also requires unit tests. See [Required capabilities and task
evidence](required-capabilities.md).

The shared performance job discovers `performance:check`, then `perf:check`,
in JavaScript repositories. Other repositories can provide one command or an
ordered list of argv arrays without shell interpolation:

```yaml
performance: true
performance_command: '["python3", "scripts/performance_audit.py", "--check"]'
performance_runner: ubuntu-latest
```

The `node-package` profile supports cold-import, memory, package-size, file-count,
and production-dependency budgets. Supported budget names are
`coldImportP50Ms`, `coldImportP95Ms`, `coldImportRssMaxBytes`,
`coldImportRelativeP50`, `packedBytes`, `unpackedBytes`, `packageFileCount`,
`packageMapFileCount`, and `productionDependencyCount`. Reports are written under
`performance-results/` and are uploaded when present.

`performance: true` makes the performance task required. Use `performance: auto`
to keep discovery optional. Product-quality profiles are repository-owned
manifests invoked by existing build or E2E commands; they are not activated by a
configuration key. See [Product quality profiles](product-quality.md).

## Release and branch policy

| Key                       | Values                                                                           | Purpose                                                                 |
| ------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `release_type`            | `auto`, `node`, `python`, `rust`, `simple`, `none`                               | Select a release manifest; `auto` detects one.                          |
| `npm_publish`             | `true`, `false`                                                                  | Opt into npm publication.                                               |
| `license`                 | `gpl-3.0-or-later`, `agpl-3.0-or-later`, `apache-2.0`, `mit`, `preserve`, `none` | License policy for initialized repositories.                            |
| `git_workflow`            | `direct`, `staging-release`                                                      | Choose the branch topology.                                             |
| `merge_strategy`          | `squash` or `rebase`                                                             | Required topology-specific merge method.                                |
| `release_merge_strategy`  | `squash` or `rebase`                                                             | Required method for Release Please version PRs.                         |
| `staging_validation_mode` | `fast`, `audit`                                                                  | Validation tier for pull requests into `staging`; staging-release only. |

`direct` is the default: feature branches and release PRs target `main`, and
both merge with squash. `staging-release` sends feature branches to `staging`,
uses rebase for the `staging` → `main` promotion and Release Please PR, and
keeps feature PRs into `staging` on squash. `sync`, `doctor`, and release
automation reject a strategy that does not match the selected topology.

```yaml
# Preview/staging environment
release_type: auto
git_workflow: staging-release
staging_validation_mode: fast
merge_strategy: rebase
release_merge_strategy: rebase
```

Use `simple` with `version.txt` when no package manifest exists. Use `none` to
skip automated releases. `npm_publish` affects generated consumer release
callers; Code Foundry's own repository uses the qualified publication path
described in [Qualified publication](qualified-publication.md).

## Synchronization and extensions

| Key                     | Values                                                   | Purpose                                                           |
| ----------------------- | -------------------------------------------------------- | ----------------------------------------------------------------- |
| `sync_mode`             | `overlay`, `strict`                                      | Synchronization policy; `overlay` is the default.                 |
| `custom_workflows`      | `preserve`                                               | Custom workflows are always preserved; other values are rejected. |
| `post_release`          | `true`, `auto`, `false`                                  | Enable a post-release delivery hook.                              |
| `post_release_workflow` | workflow filename                                        | Workflow dispatched by the post-release hook.                     |
| `post_release_mode`     | `auto`, `workflow-dispatch`, `release-event`, `disabled` | Select the hook delivery mechanism.                               |

`sync_mode` accepts `overlay` (the default) or `strict`; `sync` validates the
selected value before writing. Custom workflows remain preserved in either mode,
and `custom_workflows` must remain `preserve`. See [Extension points](EXTENSIONS.md).

## Caching and remote caching

The standard workflows use lockfile- and configuration-keyed caches. Their
repository variables, rather than application source files, control cache
behavior:

- `REPO_FOUNDRY_CACHE_PACKAGES` controls package-store caching.
- `REPO_FOUNDRY_CACHE_BUILD` controls build-cache reuse.
- `turbo_remote: auto`, `true`, or `false` declares the remote-cache policy;
  `doctor --github` warns when enabled remote caching lacks `TURBO_TOKEN` or
  `TURBO_TEAM`.
- `TURBO_TOKEN` and `TURBO_TEAM` provide the Turborepo remote-cache
  credentials.

Use these controls only after measuring a repeatable benefit. See [Caching and
remote caching](CACHING.md).

## Rust CodeQL tuning

Rust CodeQL defaults to one full scan with one worker. Larger multi-crate
repositories can opt into bounded parallelism:

```yaml
codeql_rust_shards: '["crates/api", "crates/worker"]'
codeql_rust_threads: 2
codeql_rust_max_parallel: 2
```

Each shard must contain tracked Rust source. Absolute paths, parent traversal,
duplicates, empty scopes, and more than eight shards are rejected. Use
`["all"]` when complete, non-overlapping source scopes are not available.

## Cloudflare Workers

Repositories that deploy to Cloudflare Workers can use the opt-in verified
delivery workflow with fixed `Preview` and `Production` environments,
candidate verification, and version-identity promotion. Pin both the reusable
workflow reference and `runtime-ref` to the same reviewed 40-character commit
SHA. Provide `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the consumer
repository and configure environment reviewers separately.

The legacy `cloudflare-deploy.yml` workflow remains available for direct
(unverified) deployments. It runs `wrangler versions upload` for previews and
`wrangler deploy` for production, records a GitHub deployment plus status, and
respects `CI_BILLING_PAUSED`. Preview deployment records use the pull request
head SHA when called from a PR, which lets GitHub show the completed preview in
the PR's Deployments section; direct pushes use the workflow SHA. Its
legacy-compatible Wrangler default is `latest`; callers should prefer `local` or
provide an exact `wrangler-version` for reproducibility. Bun consumers may pass
`build-script`, `install-working-directory`, and `bun-version`; the runtime
installs the frozen lockfile and builds the Worker before invoking Wrangler.
Bun-backed callers invoke Wrangler through `bunx` so OpenNext's production
delegation resolves the workspace-local `opennextjs-cloudflare` binary; callers
without `build-script` retain the npm/npx path. See [Verified Cloudflare
delivery](cloudflare-delivery.md).
