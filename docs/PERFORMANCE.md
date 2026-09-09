# Performance budgets and baselines

Code Foundry measures its source runtime with `bun run performance:check`. The
check writes `performance-results.json` for CI artifact upload and fails when a
budget is exceeded. Generated reports are ignored by Git because measurements
belong to the run that produced them, not the source tree.

## Enforced budgets

| Metric                              | Budget | Why it is bounded                                    |
| ----------------------------------- | -----: | ---------------------------------------------------- |
| CLI help startup p95                | 250 ms | Detect eager imports and startup regressions         |
| Runtime mode startup p95            | 250 ms | Detect baseline runtime initialization regressions   |
| Focused runtime tests               |   10 s | Keep the representative runtime contract inexpensive |
| Format, lint, type-check, and build |   15 s | Bound the local CI feedback loop                     |
| Runtime dependencies                |      0 | Keep the installed CLI dependency-free               |
| Development dependencies            |      4 | Prevent unreviewed toolchain growth                  |
| Packed artifact                     | 210 kB | Bound registry transfer and install cost             |
| Unpacked artifact                   | 800 kB | Bound installed footprint                            |
| Packed files                        |     90 | Detect accidental release contents                   |

The performance workflow disables build-cache reads and writes for this task.
That makes timing comparisons independent of a warm protected-branch cache and
prevents benchmark code from populating shared cache entries.

## v1.6.1 baseline

Measurements were taken on 2026-09-08 with Node 24.18.0. Process startup used
30 measured samples after four warmups; before and after samples were
interleaved on the same host.

| Measurement                |   Before |                   After |   Change |
| -------------------------- | -------: | ----------------------: | -------: |
| CLI help median            | 36.11 ms |                29.57 ms |   -18.1% |
| CLI help p95               | 38.11 ms |                31.56 ms |   -17.2% |
| Runtime mode median        |        - |                35.94 ms | baseline |
| Focused runtime tests      |        - |                  2.08 s | baseline |
| Local CI checks            |        - |                  0.50 s | baseline |
| Packed / unpacked artifact |        - | 160,114 / 616,887 bytes | baseline |
| Packed files               |        - |                      74 | baseline |

The startup reduction comes from loading command implementations only after
argument parsing selects a command. `--help` no longer imports sync, release,
fleet, doctor, and CI command modules.

The first isolated full hosted audit completed in 3 minutes 2 seconds. Its
longest jobs were TypeScript CodeQL (66 s), dependency audit (62 s), and unit
tests (46 s); all other suite jobs completed in 20 seconds or less. Those
measurements identify the three lanes to optimize before adding more CI fanout.

## Release path

Treat budget changes like source changes: explain the measured reason in a
pull request, run the complete validation gate, and merge only when the new
result artifact is available. A Release Please PR then carries the change into
the next version. Never raise a budget solely to clear CI; include before/after
measurements and the expected effect on local feedback, hosted runner time,
package transfer, or installed footprint.
