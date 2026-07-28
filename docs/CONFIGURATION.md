# Configuration reference

`.github/code-foundry.yml` is the repository's single Code Foundry control plane.
Initialize from it with:

```bash
npx code-foundry init --config .github/code-foundry.yml
```

After initialization, edit the file and run `npx code-foundry sync` to render
the selected callers and refresh the local baseline. Existing authored files
and custom workflows remain protected.

## Configuration flow

```text
code-foundry.yml
    |
    +--> profile and language detection
    +--> enabled standard workflow callers
    +--> runtime repository and ref
    +--> workflow runner selection
    +--> release, license, cache, and coverage policy
```

## Core settings

| Key | Values | Purpose |
| --- | --- | --- |
| `profile` | `auto`, `application`, `monorepo`, `minimal` | Repository shape |
| `languages` | `auto` or comma-separated languages | Toolchain and CodeQL scope |
| `package_manager` | `auto`, `bun`, `pnpm`, `yarn`, `npm` | Locked JavaScript setup |
| `features` | `all` or comma-separated names | Standard callers to install |
| `prune_standard` | `true` or `false` | Remove disabled standard callers on sync |
| `runtime_repository` | `OWNER/REPO` or blank | Reusable workflow source |
| `runtime_ref` | tag or branch | Reusable workflow version |
| `release_type` | `auto`, `node`, `python`, `rust`, `simple`, `none` | Release Please strategy |
| `npm_publish` | `true` or `false` | Opt into npm publication |
| `license` | license name, `preserve`, `none` | License generation policy |
| `license_file` | path | Optional exact license source |

Supported languages are TypeScript, Rust, Python, and Solidity. Supported
features are `ci`, `codeql`, `security`, `test`, `draft-pr`, `release-pr`,
`release`, and `dependabot`.

## Workflow runners

Each caller can select its default runner without editing workflow YAML:

| Key | Default | Controls |
| --- | --- | --- |
| `runner` | `ubuntu-latest` | Shared fallback |
| `unit_runner` | `ubuntu-slim` | Unit tests |
| `ci_runner` | `ubuntu-latest` | Format, lint, type-check, build |
| `test_runner` | `ubuntu-latest` | Integration, E2E, smoke |
| `security_runner` | `ubuntu-slim` | Profile and dependency security jobs |
| `codeql_runner` | `ubuntu-latest` | CodeQL detection and analyzers |
| `pr_runner` | `ubuntu-slim` | Draft and Release PR automation |
| `release_runner` | `ubuntu-slim` | Release and package publication |

Use the full runner for native toolchains, browsers, or measured dependency
workloads. Use `ubuntu-slim` for lightweight orchestration and small projects.

## Performance and quality

| Key | Default | Purpose |
| --- | --- | --- |
| `cache_packages` | `auto` | Package-store caching policy |
| `cache_build` | `auto` | Build-cache policy |
| `coverage_minimum` | `80` | Shared Bun/Python coverage target |
| `turbo_remote` | `auto` | Turborepo remote-cache policy |

Turborepo remote caching still requires the repository secret `TURBO_TOKEN` and
the variable `TURBO_TEAM`; the file controls policy, not credentials.

## Precedence

The resolved value order is:

```text
explicit CLI flag -> REPO_FOUNDRY_* variable -> code-foundry.yml -> detection/default
```

Use variables for temporary CI overrides. Keep durable repository policy in
`.github/code-foundry.yml` so humans and agents have one discoverable source of
truth. The example file is a commented starter guide; it is intentionally not
a second generated configuration.
