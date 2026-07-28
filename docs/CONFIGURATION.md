# Configuration reference

Code Foundry has one repository-owned control plane: `.github/code-foundry.yml`.

```bash
npx code-foundry init
```

Initialization detects the repository and writes a fully resolved configuration.
Edit that file directly, then run `npx code-foundry sync`.

## Configuration flow

```text
repository manifests and source
            |
            v
  .github/code-foundry.yml
            |
            +--> mise and environment setup
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
| `features` | `all` or a list | Standard workflow callers |
| `prune_standard` | `true` or `false` | Remove disabled standard callers |
| `runtime_repository` | `OWNER/REPO` | Reusable workflow source |
| `runtime_ref` | tag or branch | Reusable workflow version |
| `release_type` | `node`, `python`, `rust`, `simple`, `none` | Release strategy |
| `npm_publish` | `true` or `false` | Opt into npm publication |
| `license` | `gpl-3.0-or-later`, `agpl-3.0-or-later`, `mit`, `preserve`, `none` | License policy; new repositories default to GPLv3 |
| `runner` fields | GitHub runner names | Per-workflow runner policy |

Supported features are `ci`, `codeql`, `security`, `test`, `draft-pr`,
`release-pr`, `release`, and `dependabot`.

## Editing workflow

`init` creates the file and renders the baseline. `sync` reads the file and
refreshes standard files from the configured runtime. Generated callers are
short and replaceable; custom workflows and project documentation are kept.

The generated configuration includes all defaults so humans and agents can
understand the repository without memorizing flags or environment variables.
