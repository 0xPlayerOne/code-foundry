# Build budgets

A repository can give the CI Build lane a wall-clock ceiling. The runtime times
the Build, compares it with the ceiling, and fails the Build job (and so the
aggregate `Validation / Gate`) when the Build takes longer.

Enforcement is opt-in. Repositories that do not set `build_budget_file` keep
the Build lane exactly as before, even if they have a `budgets.json`.

## Opting in

Name the budget file in `.github/code-foundry.yml`:

```yaml
build_budget_file: budgets.json
```

The file is repository-relative and may not leave the checkout (no absolute
paths, `..`, or symlinks pointing outside). Its shape:

```json
{
  "schemaVersion": 1,
  "lanes": {
    "build": { "ceilingSeconds": 300 }
  }
}
```

Other keys in the file are ignored, so the same file can hold the repository's
other budgets.

## What is measured

The measured interval is the Build executor subprocess, from the moment the
runtime spawns it to the moment it exits, on Node's monotonic clock
(`process.hrtime.bigint()`), so wall-clock adjustments cannot shorten or
lengthen it. The executor is `runtime-core.mjs ci build`, which runs the
repository's `build` package script through the configured package manager
(or `cargo build --all-targets` for a Rust root without one). The interval
therefore includes the executor's own Node start-up, typically tens of
milliseconds, and everything the build command does.

It excludes everything else in the Build job: queueing, checkout, runtime
checkout, toolchain setup, dependency installation, cache restore and save,
applicability detection, reading the budget file, receipt writing, and the
release package inspection steps.

## Pass and fail

- A Build at or under the ceiling passes. The comparison is exact in
  nanoseconds, so a Build of exactly `ceilingSeconds` passes and one
  nanosecond more fails.
- A successful Build over the ceiling fails with exit 1 and a `::error::`
  annotation naming the measured time, the ceiling, and the file.
- A Build command that fails keeps its own exit code and reason; the budget
  measurement is still recorded.
- A Build that is skipped (not applicable, or path-filtered out) stays
  skipped and does not read the budget file.

For an opted-in repository, budget data that is missing, unreadable, not JSON,
not an object, has a `schemaVersion` other than `1`, has no `lanes.build`, or
has a `ceilingSeconds` that is not a positive finite number fails the Build
closed, before the build command runs.

## Receipt

The Build receipt (`.code-foundry/results/build.json`) gains a `buildBudget`
object whenever the Build ran under a budget:

```json
"buildBudget": {
  "file": "budgets.json",
  "lane": "build",
  "clock": "monotonic",
  "interval": "build executor subprocess, spawn to exit",
  "ceilingSeconds": 300,
  "measuredSeconds": 254.123456789,
  "measuredNanoseconds": "254123456789",
  "within": true
}
```

The receipt `status` is `failed` and its `reason` names the overrun when
`within` is `false`.
