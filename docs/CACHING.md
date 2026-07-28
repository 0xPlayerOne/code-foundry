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

## Runner selection

Lightweight detection, orchestration, audits, and release metadata jobs can use
`ubuntu-slim`. Toolchain-heavy builds, native compilation, browsers, and active
CodeQL analysis should use `ubuntu-latest` unless measurements show otherwise.
