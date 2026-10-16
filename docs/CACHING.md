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
- restores and saves `node_modules/.vite/task-cache` (Vite+'s local task
  cache) keyed by the lockfiles, `vite.config.*`, and mise files, using the same
  push-only save rule as every other cache so pull requests and scheduled runs
  cannot poison it;
- keeps that directory out of the generic JavaScript build-state archive so it
  is stored once.

Vite+ has no remote cache and this repository does not configure one. Vite+
validates every restored entry against the task's current inputs and
environment, so a stale restore-key match can only cause a cache miss, never a
wrong replay.

`package.json` scripts are not cached by Vite+ unless the consumer sets
`run.cache.scripts: true` in its root `vite.config.ts` or passes `--cache` to
`vp run`; Code Foundry does not change consumer config. Commands that read no
files, such as a bare `echo`, are never cached.

### Affected packages

`npx code-foundry affected --base <ref> --head <ref>` prints the affected
packages as JSON (`tool`, `packages`, `all`, `conservative`, `filterArgs`):

- Turbo repositories use `turbo query affected --packages`.
- Vite+ repositories compute the set from `git diff base...head` and the
  workspace dependency graph, because Vite+ has no equivalent query. Each
  changed file marks its owning package; dependents are added transitively.
  A change to a root lockfile, root manifest, runner config, or TypeScript
  config affects every package. Other root files affect only the root package.
- `--tool turbo|vite-plus` overrides `monorepo_tool` for one invocation.
- If affectedness cannot be proven (no runner, git or Turbo failure), the
  result is conservative: `all: true` with `conservative: true`.
- For Vite+, `filterArgs` is ready to append to `vp run`. When `all` is true
  run with `-r` instead, and when `packages` is empty skip the run: an empty
  filter list would otherwise select every package.

## Runner selection

Lightweight detection, orchestration, audits, and release metadata jobs can use
`ubuntu-slim`. Toolchain-heavy builds, native compilation, browsers, and active
CodeQL analysis should use `ubuntu-latest` unless measurements show otherwise.
