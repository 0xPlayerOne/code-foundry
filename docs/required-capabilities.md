# Required capabilities and task evidence

Declared requirements fail closed when discovery cannot find an executable task.
Optional task discovery remains available. Configure scalar values in
`.github/code-foundry.yml`:

```yaml
required_capabilities: type_check,unit,e2e,eval,performance,coverage
performance: true
eval: true
coverage_enforcement: required
coverage_minimum: 80
coverage_metrics: lines,branches
coverage_report: coverage/coverage-summary.json
```

Supported task capabilities are `format`, `lint`, `type_check`, `build`, `unit`,
`integration`, `e2e`, `smoke`, `eval`, and `performance`. `coverage` additionally requires
unit tests. Unknown names, contradictory requirements, and invalid thresholds
are errors. `performance: true` and `eval: true` mean required, not merely
enabled when a script happens to exist. Use `performance: auto` or
`eval: auto` to retain optional discovery.

The public `src/runtime.mjs` entrypoint delegates ecosystem execution to the
private `src/runtime-core.mjs`. Keep both files and `src/lib` when vendoring the
runtime. Published packages and reusable workflows must include those paths. Do
not call the private executor from consumer CI: it does not enforce the public
policy contract.

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
their own logs and command arguments. Receipts are diagnostics, not signatures,
attestations, or authorization to publish or merge.

The shared CI and Test workflows retain each executed task's receipt, including
failure, and discovery receipts for explicitly skipped optional tasks. Each upload
selects exactly `.code-foundry/results/<task>.json`, not the broader hidden
directory. The artifact name is `task-result-RUN_ID-ATTEMPT-TASK` and retention is
14 days. The optional `artifact-prefix` input is exposed by CI, Test, and both
validation orchestrators; it disambiguates multiple invocations in the same run
when forwarded to the leaf workflows. Use a different prefix for each such
invocation. Existing coverage/performance artifact uploads are unchanged.

Missing receipts from an older runtime, a discovery/setup failure, or termination
before the runtime writes its report do not create an artifact. Missing evidence
is not success: inspect the task's actual outcome and the validation gate. Uploads
run after success or failure and do not suppress a failing task exit. When an
existing receipt disappears during upload, the upload itself fails. A job skipped
by the workflow's tier or billing policy cannot create a receipt.

These files describe repository-controlled execution and can include paths and
script-derived reasons. Do not put credentials in command arguments. Artifact
access follows repository/Actions visibility; receipt retention does not provide
a sandbox or independently validate repository-authored evidence.

Use the public CLI for a repository-facing discovery plan:

```sh
npx code-foundry plan --tier audit --json
```

The lower-level `node src/runtime.mjs ci plan` form remains useful to reusable
workflows and runtime tests. Both forms discover tasks without executing checks.
Discovery validates every required task before workflows select jobs. A
fast/unit-only tier is still a subset: discovery proves that E2E exists, not that
E2E ran. Require the audit validation gate before merging.

Native task detection rejects known no-ops such as a JavaScript project with no
build script or a Python project with no supported type-check command. Add a
repository-owned script for unsupported layouts or toolchains. Do not infer that
an installed package manager or discovered project proves task execution.

## Verification

`node --test test/task-policy.test.mjs` exercises policy parsing, discovery,
coverage parsing/thresholds/freshness/path safety, exit propagation, and reports
with a deterministic executor fixture. The ecosystem executor is covered by
`test/runtime.test.mjs` in the full suite.
