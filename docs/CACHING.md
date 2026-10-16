# Caching and remote caching

## Local workflow caching

The standard runtime uses lockfile- and configuration-keyed caches for package
stores, Cargo, pip/uv, browser binaries, and applicable build artifacts. Cache
misses always fall back to a clean locked install. Do not cache credentials,
generated secrets, or mutable environments without an exact dependency key.

Repositories should measure before enabling large installed-tree or build
caches. Set repository variables such as `REPO_FOUNDRY_CACHE_PACKAGES` and
`REPO_FOUNDRY_CACHE_BUILD` only when a repeatable warm-cache benefit is proven.

## Turborepo and Vercel Remote Caching

Turborepo repositories can opt into Vercel Remote Caching with:

- Secret: `TURBO_TOKEN`
- Repository variable: `TURBO_TEAM`

Non-Turborepo repositories do not need either setting. Deployment to Vercel is
not required. Custom workflows can pass these values to Turbo directly when
the repository's task graph benefits from remote reuse.

## Vite+ local task cache (opt-in)

Repositories that run their workspace tasks with Vite+ (`vp run`, `vpr`) can
opt in with `monorepo_tool: vite-plus` in `.github/code-foundry.yml`. Turbo
stays the default for every repository that does not set it.

When opted in, the setup action:

- stops treating a `turbo.json` as the active runner, so no Turborepo cache or
  remote-cache step runs;
- restores `node_modules/.vite/task-cache` (Vite+'s local task cache) as its
  last step, after Install and after every step that archives `node_modules`.
  Install can replace `node_modules`, and the dependency archives must not
  contain task output;
- saves it with the same push-only rule as every other cache, so pull requests
  and scheduled runs cannot poison it;
- keeps that directory out of the generic JavaScript build-state archive so it
  is stored once.

Keys are `<namespace>-<workflow>-<job>-<lockfiles>-<vite.config>-<run id>-<attempt>`,
so every push saves a refreshed entry (more cache storage than a fixed key).
Restore keys fall back by lockfiles, job, then any job, but never leave the
namespace `vite-plus-v1-<OS>-<arch>-node<version>-bun<version>-vp<version>`:
Vite Task does not fingerprint the Node or Bun binary that runs a task.

If `VITE_CACHE_PATH` (absolute) is set, Vite+ writes its cache there and the
setup action caches that directory instead.

Vite+ has no remote cache and this repository does not configure one.

Known limits (not parity with Turbo):

- Vite Task keeps one cache entry per task, so alternating between states
  (A, B, A) re-runs the task instead of hitting the cache.
- `package.json` scripts are not cached unless the consumer sets
  `run.cache.scripts: true` in its root `vite.config.ts` or passes `--cache` to
  `vp run`. Code Foundry does not change consumer config. Commands that read no
  files, such as a bare `echo`, are never cached.
- Tasks reading files that only Bun loads may need explicit input globs in the
  consumer's Vite+ config (untested here).
- `cloudflare-deploy.yml` and `cloudflare-delivery.yml` keep a Turbo-only
  affected check. With `monorepo_tool: vite-plus` they skip it and deploy
  conservatively, even with a leftover `turbo.json`.

### Affected packages

`npx code-foundry affected --base <ref> --head <ref>` prints the affected
packages as JSON (`tool`, `packages`, `removedPackages`, `all`, `conservative`,
`reason`, `filterArgs`). Both refs must be present in the clone (use a
non-shallow checkout or fetch the base commit).

- Turbo repositories use `turbo query affected --packages`; this module does
  not parse their workspace.
- Vite+ repositories compute the set from `git diff base...head` and the
  workspace graphs read from the committed trees at both refs, because Vite+
  has no equivalent query. Each changed file marks the package that owns it;
  dependents are added transitively over the union of both graphs' edges, so
  deleted, renamed, moved, and re-wired packages still select their dependents.
  `removedPackages` lists selected packages that no longer exist at the head.
- Any changed file that no workspace package owns selects every package
  (`all: true`): lockfiles, root manifest, runner and TypeScript config, root
  scripts, CI config. Only Markdown/text files, `LICENSE*`, `NOTICE`,
  `.gitignore`, and `docs/` are ignored.
- Anything the module cannot evaluate faithfully makes the result
  conservative (`all: true`, `conservative: true`): no runner, a git or Turbo
  failure, a malformed or unnamed workspace manifest at either ref, duplicate
  package names, or workspace syntax it does not support (brace, bracket, or
  extglob patterns). Supported syntax is `package.json` `workspaces` (array or
  `{ packages }`) and pnpm `packages:` as a block or flow list, with `*`, `**`,
  `?`, and `!` exclusions.
- `--tool turbo|vite-plus` overrides `monorepo_tool` for one invocation.
- For Vite+, `filterArgs` is ready to append to `vp run`. When `all` is true
  run with `-r` instead, and when `packages` is empty skip the run: an empty
  filter list would otherwise select every package.

## Runner selection

Lightweight detection, orchestration, audits, and release metadata jobs can use
`ubuntu-slim`. Toolchain-heavy builds, native compilation, browsers, and active
CodeQL analysis should use `ubuntu-latest` unless measurements show otherwise.
