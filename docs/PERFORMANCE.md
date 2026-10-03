# Performance budgets and baselines

Code Foundry measures its own runtime with `bun run performance:check`. The
check writes `performance-results.json` for artifact upload and fails when a
budget is exceeded. Reports are generated-run evidence and are ignored by Git.

## Enforced budgets

| Metric                                |   Budget | Why it is bounded                                    |
| ------------------------------------- | -------: | ---------------------------------------------------- |
| CLI help startup p95                  |   250 ms | Detect eager imports and startup regressions         |
| Runtime mode startup p95              |   750 ms | Detect baseline runtime initialization regressions   |
| Focused runtime tests                 |     10 s | Keep the representative runtime contract inexpensive |
| Format, lint, type-check, and build   |     15 s | Bound the local CI feedback loop                     |
| Runtime dependencies                  |        0 | Keep the installed CLI dependency-free               |
| Development dependencies              |        4 | Prevent unreviewed toolchain growth                  |
| Packed artifact (without changelog)   |   296 kB | Bound registry transfer and install cost             |
| Unpacked artifact (without changelog) | 1,136 kB | Bound installed footprint                            |
| Packed files (without changelog)      |      120 | Detect accidental release contents                   |

The source-of-truth budgets live in `scripts/performance-check.mjs`. When those
limits change, update this table and include before/after measurements in the
same change. Latency budgets are evaluated against the fastest of the timed
samples so a single load spike on a shared runner cannot fail the gate.

The artifact budgets measure the package **without `CHANGELOG.md`**. Release
Please prepends every release to the repository changelog, so a budget that
included it eroded on every release and repeatedly failed release pull requests.
The check packs a staging copy without the changelog and reports the repository
changelog size and its packaged (trimmed) size as informational metrics. At
v1.44.0 the measured artifact was 280,902 packed bytes, 1,070,333 unpacked bytes,
and 118 files, leaving roughly 5% packed and 6% unpacked headroom for source
growth.

The published package ships a changelog trimmed to the 20 most recent releases
with a link to the full history on GitHub. `scripts/package-changelog.mjs`
rewrites only the ephemeral checkout in the qualification pack job, immediately
before the lifecycle-free `npm pack --ignore-scripts`; the repository keeps the
complete `CHANGELOG.md` that Release Please maintains.

The performance workflow disables build-cache reads and writes for this task.
Timing comparisons therefore do not depend on a warm protected-branch cache, and
benchmark code cannot populate shared cache entries.

## Package profile

The reusable performance job also supports the opt-in `node-package` profile.
Configure it in `.github/code-foundry.yml`:

```yaml
performance: true
performance_profile: node-package
performance_budget_file: performance-package-budgets.json
```

The profile measures cold imports, memory, package size, file counts, and
production dependency count according to a repository-owned JSON budget file.
It writes `performance-results/node-package.json`. Every run also writes
`performance-results/summary.json`, which records repository-owned commands and
configured performance commands under one stable artifact contract.

## Native Rust test batching

Each Rust test category invokes Cargo once with tracked targets: unit tests use
`--lib`/`--bin <package>`, while integration, E2E, and smoke tests use repeated
`--test <target>` arguments. Cargo shares setup without competing processes.

Discovery, category boundaries, fallback behavior, scripts, Python checks, flags,
and receipts remain unchanged. `--tests` and `--all-targets` stay avoided to
prevent broader or repeated coverage. Measure cold and warm runs, including
compilation and cache transfer, before claiming a speedup.

## Changing a budget

Treat budget changes like source changes:

1. capture before/after measurements;
2. explain the effect on local feedback, runner time, package transfer, or
   installed footprint;
3. run the complete validation gate; and
4. inspect the resulting performance artifact.

Never raise a limit solely to clear CI. Keep network-dependent checks, live
endpoints, and post-deployment probes in separate repository-owned workflows.
