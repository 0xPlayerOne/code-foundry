# Performance budgets and baselines

Code Foundry measures its own runtime with `bun run performance:check`. The
check writes `performance-results.json` for artifact upload and fails when a
budget is exceeded. Reports are generated-run evidence and are ignored by Git.

## Enforced budgets

| Metric                              | Budget | Why it is bounded                                    |
| ----------------------------------- | -----: | ---------------------------------------------------- |
| CLI help startup p95                | 250 ms | Detect eager imports and startup regressions         |
| Runtime mode startup p95            | 250 ms | Detect baseline runtime initialization regressions   |
| Focused runtime tests               |   10 s | Keep the representative runtime contract inexpensive |
| Format, lint, type-check, and build |   15 s | Bound the local CI feedback loop                     |
| Runtime dependencies                |      0 | Keep the installed CLI dependency-free               |
| Development dependencies            |      4 | Prevent unreviewed toolchain growth                  |
| Packed artifact                     | 260 kB | Bound registry transfer and install cost             |
| Unpacked artifact                   | 995 kB | Bound installed footprint                            |
| Packed files                        |    115 | Detect accidental release contents                   |

The source-of-truth budgets live in `scripts/performance-check.mjs`. When those
limits change, update this table and include before/after measurements in the
same change. The Cloudflare delivery and qualified-publication changes in this
release moved the measured artifact from 990,481 to 994,555 unpacked bytes
(257,384 to 258,647 packed bytes, with 112 files in both measurements), so the unpacked budget
is 995 kB while the packed and file-count budgets remain unchanged.

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
