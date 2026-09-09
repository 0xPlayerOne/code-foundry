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
| Packed artifact                     | 260 kB | Bound registry transfer and install cost             |
| Unpacked artifact                   | 990 kB | Bound installed footprint                            |
| Packed files                        |    115 | Detect accidental release contents                   |

The performance workflow disables build-cache reads and writes for this task.
That makes timing comparisons independent of a warm protected-branch cache and
prevents benchmark code from populating shared cache entries.

The merged candidate includes the release-integrity verifier, fleet eligibility,
consumer qualification harness, product-quality profiles, qualified publication
workflow, and opt-in merge-queue verifier. After the qualified publication
cutover was rebased onto the current main release and task-receipt workflows, it
measured 255,195 packed bytes, 981,678 unpacked bytes, and 112 files on Node
24.18.0. The 260 kB, 990 kB, and 115-file limits retain a measured margin while
continuing to bound package growth.

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
package transfer, or installed footprint. The current budget covers the measured
combined release-integrity, fleet, consumer-qualification, and product-quality
package footprint described above.

## Native Rust test batching

The runtime sends all selected targets in each test category to one Cargo
invocation. A package with both conventional library and binary unit targets
uses `cargo test --lib --bin <package>`; a category with multiple integration
targets uses repeated `--test <target>` selectors. Cargo can schedule the
selected targets' compilation through one dependency graph and jobserver,
instead of the runtime serially starting Cargo once per target.

This preserves the existing tracked-file discovery, category boundaries,
default-target fallback, compiler profile, flags and failure propagation.
It deliberately does not use `--tests` or `--all-targets`, which would broaden
coverage and repeat targets from other categories. Repository-owned scripts,
Python checks and required-capability receipts are unchanged. The runtime does
not infer that a package script replaces another language's checks.

Cargo's existing `CARGO_BUILD_JOBS` or configuration controls compiler
parallelism. This change does not spawn competing Cargo processes, raise job
limits, or change test-harness threads. Separate test executables may still run
serially. See [Cargo test options](https://doc.rust-lang.org/cargo/commands/cargo-test.html).
Measure cold and warm consumer runs, including compilation, test execution and
cache transfer, before claiming a wall-clock speedup. Prefer removing repeated
compilation on the critical path over splitting already short jobs further.
