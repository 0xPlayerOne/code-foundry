# Evals

`ci eval` is the repository's deterministic behavior-evaluation tier. It runs the
repository's own eval harness and consumes its result against a shared contract,
so task outcomes stay comparable across revisions and — later — across
executors (deterministic today, model-agent when a repository adopts one).

Evals are tests' measurement-oriented sibling: tests verify a specified
behavior (pass/fail); evals record how well the system does at repeated probes
(success rates, timing percentiles, bounded evidence) and compare those numbers
against pinned baselines. The `performance` tier is the resource-metric
special case of the same pattern.

## How the runtime finds your harness

`ci eval` discovers its subject in this order and skips when neither exists:

1. A package script named `eval`.
2. An explicit `eval_command` (JSON argv array) in `.github/code-foundry.yml`.

Both mechanisms use `eval: auto` by default: the tier runs when a subject is
present and skips cleanly otherwise. Set `eval: true` to require it (the
validation policy then treats a missing subject as an error), or `eval: false`
to disable discovery.

In managed validation the eval tier runs as its own `Validation / Eval` lane
during audit-mode runs, with the receipt retained as a task artifact. Browser
eval harnesses need a Chrome-capable runner: set `eval_runner: ubuntu-latest`
in `.github/code-foundry.yml` (the default when unset is the repository's
default runner, which may not ship a browser). The lane uploads the eval
report alongside the task receipt whenever a run fails, so reviewers get the
measured numbers with the red check. Performance's task profile and gating
rules apply unchanged; evals are an optional, non-gating tier like
performance.

| Config key         | Values                            | Meaning                                                          |
| ------------------ | --------------------------------- | ---------------------------------------------------------------- |
| `eval`             | `auto` (default), `true`, `false` | Enable, require, or disable the eval tier.                       |
| `eval_command`     | JSON argv array                   | Explicit harness command when there is no `eval` package script. |
| `eval_report_file` | repository-relative path          | The report to validate; defaults to `eval-results/result.json`.  |
| `eval_budget_file` | repository-relative path          | Optional budget file; defaults to `eval-budgets.json`.           |

## The report contract

Your harness writes `eval-results/result.json`. The runtime validates the
envelope before budgets; a report that violates the contract fails the tier
with every violation listed (fail closed, typos can never pass silently):

```jsonc
{
  "schemaVersion": 1, // contract version, currently 1
  "revision": "<git sha>", // optional but strongly recommended
  "dependencyHash": "<sha256>", // optional; pins the dependency set
  "summary": {
    "taskCount": 7,
    "attempts": 7,
    "passed": 7,
    "failed": 0,
    "harnessFailures": 0, // environment broke; not a task regression
    "successRate": 1.0,
    "toolCalls": 31,
    "evidenceErrors": 0,
    "taskDurationMs": { "count": 7, "mean": 2.1, "p50": 1.8, "p95": 3.0, "max": 3.4 },
    "startupMs": { "count": 7, "mean": 0.3, "p50": 0.3, "p95": 0.4, "max": 0.4 },
    "stepDurationMs": { "count": 31, "mean": 0.2, "p50": 0.1, "p95": 0.6, "max": 0.6 },
  },
  "tasks": [
    {
      "id": "form-submit",
      "attempts": [
        {
          "iteration": 1,
          "status": "passed",
          "durationMs": 2.1,
          "startupMs": 0.3,
          "steps": [{ "tool": "fill_form", "status": "passed", "durationMs": 0.4 }],
          "checks": ["fill_form completed"],
          "metrics": { "formFields": 2 },
        },
      ],
    },
  ],
}
```

Rules the validator enforces:

- `schemaVersion` must match the contract version; `revision`/`dependencyHash`
  must be strings when present.
- Summary counts are non-negative integers; `passed + failed` cannot exceed
  `attempts`; `successRate` is between 0 and 1.
- `harnessFailures` counts attempts where the environment itself broke (browser
  never started, zero steps succeeded, cleanup failed). It must not exceed
  `attempts`. Fix the environment; do not treat these as task regressions.
- Failed attempts carry a bounded `failure` (non-empty `message`) plus a
  `failureClass` of `harness` or `task`.
- `taskDurationMs`, `startupMs`, and `stepDurationMs` are stats objects with
  `count`, `mean`, `p50`, `p95`, `max` (or bare `{ "count": 0 }`).

A reference implementation ships in
[`pi-browser-use`](https://github.com/0xPlayerOne/pi-browser-use)
(`scripts/eval.mjs` + `docs/eval-results.md`): deterministic browser-tool tasks
that emit this exact envelope.

## Budgets

Create `eval-budgets.json` (or point `eval_budget_file` at another file) to
gate on the measured numbers:

```json
{
  "successRate": 1.0,
  "stepP95Ms": 1000,
  "taskP95Ms": 45000,
  "maxHarnessFailures": 0
}
```

Supported budgets: `successRate`, `taskP95Ms`, `startupP95Ms`, `stepP95Ms`,
`maxHarnessFailures`, `maxEvidenceErrors`, `maxToolCalls`. Unknown keys fail
closed. When the budget file is absent the tier validates the contract only.
Budget files are committed configuration; only `eval-results/` is a local
artifact.

The runtime writes `eval-results/summary.json` with the executed commands, the
budget outcome, and the artifact list, mirroring the performance summary.

## Determinism rules for eval tasks

- Fixed fixtures and no network. A task's outcome must depend only on the code
  under test.
- Bounded evidence: failure text and screenshots are capped; a failing task
  never produces unbounded output.
- Cleanup failures are surfaced, never swallowed silently.
- Every attempt records the revision and dependency hash it ran against.
- Keep model-in-the-loop runs out of this tier. Reuse the same task IDs in a
  separate scheduled harness with frozen model/reasoning/judge baselines when
  you need agent-capability measurement; its variance is why it must never
  gate pull requests.
