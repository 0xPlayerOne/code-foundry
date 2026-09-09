# Required capabilities and task evidence

Declared requirements fail closed when discovery cannot find an executable task.
Existing optional task discovery remains available. Configure scalar values in
`.github/code-foundry.yml`:

```yaml
required_capabilities: type_check,unit,e2e,performance,coverage
performance: true
coverage_enforcement: required
coverage_minimum: 80
coverage_metrics: lines,branches
coverage_report: coverage/coverage-summary.json
```

Supported task capabilities are `format`, `lint`, `type_check`, `build`, `unit`,
`integration`, `e2e`, `smoke`, and `performance`. `coverage` additionally requires
unit tests. Unknown names, contradictory requirements, and invalid thresholds
are errors. `performance: true` now means required, not merely enabled when a
script happens to exist. Use `performance: auto` to retain optional discovery.

The public `src/runtime.mjs` entrypoint delegates ecosystem execution to the
unchanged private `src/runtime-core.mjs`. Keep both files and `src/lib` when
vendoring the runtime. Published packages and the reusable workflows' existing
cone-mode sparse checkout include both files. Do not call the private executor
from consumer CI: it intentionally does not enforce the public policy contract.

## Coverage migration

`coverage_enforcement` accepts:

- `auto` (default): missing reports are explicitly reported as skipped; present
  reports must be fresh, valid, and meet the threshold.
- `required`: missing reports also fail, as does required capability `coverage`.
- `off`: skip the shared report gate. This does not disable a test runner's own
  coverage threshold, and cannot be combined with required coverage.

The default report candidates are `coverage/coverage-summary.json` (Istanbul
summary) and `coverage/lcov.info`. `coverage_report` accepts a comma-separated
list of repository-relative files. When multiple reports exist, every report
must meet the selected metrics. Percentages are recomputed from measured counts,
not trusted from reported `pct` fields. Empty reports, unmeasured selected
metrics, stale files, traversal, and escaping symlinks fail. LCOV supports lines,
functions, and branches; use JSON summaries for statement coverage.

Configure the repository-owned unit-test command to generate the report on each
run before enabling required mode. The runtime does not inject coverage tooling,
install a new runner, delete old reports, or lower thresholds. Auto mode preserves
repos that declare a threshold but have not yet configured report generation;
a passing unit task with `coverage.status: skipped` is **not** coverage evidence.

## Results and validation tiers

Each executed CI task writes `.code-foundry/results/<task>.json`, including its
status (`passed`, `failed`, or `skipped`), discovery reason, delegated command and
exit status, source SHA when available, timestamps, and evidence paths. Coverage
has its own nested status. Discovery also records optional skips. Task reports
appear in the GitHub job summary when `GITHUB_STEP_SUMMARY` is available.

The recorded command is the delegated executor invocation, not a transcript of
all nested package scripts. No environment variables or captured command output
are copied into the report. Repository scripts remain responsible for sanitizing
their own logs. Upload `.code-foundry/results/*.json` with `if: always()` and
`include-hidden-files: true` to retain downloadable reports; only upload this
specific directory, not arbitrary hidden files or the entire checkout.

`node src/runtime.mjs ci plan` prints a JSON discovery plan without executing
checks. Discovery validates every required task before reusable workflows select
jobs. A fast/unit-only tier is still a subset: discovery proves that E2E exists,
not that E2E ran. Require the existing audit validation gate before merging.

Native task detection rejects known no-ops such as a JavaScript project with no
build script or a Python project with no supported type-check command. Add a
repository-owned script for unsupported layouts or toolchains. Do not infer that
an installed package manager or discovered project proves task execution.

## Verification

`node --test test/task-policy.test.mjs` exercises policy parsing, discovery,
coverage parsing/thresholds/freshness/path safety, exit propagation, and reports
with a deterministic executor fixture. The unchanged ecosystem executor remains
covered by `test/runtime.test.mjs` in the full suite.
