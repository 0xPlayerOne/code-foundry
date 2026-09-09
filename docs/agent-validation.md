# Agent-facing validation commands

The public CLI now exposes a stable plan/check interface using the same discovery,
required-capability policy, ecosystem executor, and task receipts as reusable CI.

```sh
code-foundry plan --changed --base origin/main --json
code-foundry check --tier fast --json
code-foundry check --tier audit --json
```

Both commands accept `--target PATH`. Use the Code Foundry version pinned by the
repository, not an unreviewed floating installation. `plan` executes discovery
only: it does not install dependencies, run project checks, modify source files,
or emit skip-receipt files. Required entrypoints are validated across the complete
task set, including tasks deferred from the selected local tier.

## Tiers and change awareness

`fast` selects formatting, linting, type checking, build, unit tests, and performance.
`audit` adds integration, E2E, and smoke tests. Ecosystem commands and applicability
come from the shared runtime; the CLI does not invent alternate test commands.
Repository-owned scripts remain authoritative. Missing required tasks fail
planning instead of returning a misleading successful subset.

`--changed` includes paths changed from the selected base, staged changes,
unstaged changes, and untracked files. Committed paths use the merge-base with
that ref, so an independently advanced base branch does not make base-only
changes look like head changes. `--base` defaults to HEAD and requires `--changed`.
Invalid or unavailable base revisions fail rather than being treated as no changes.
Paths use Git's NUL-separated format, preserving whitespace and unusual filenames.
Generated `.code-foundry/` evidence is excluded from change annotations. Change awareness is **annotation-only**: without a verified dependency
graph it does not skip required tasks or assume a documentation change cannot
affect a custom command.

Local tiers are not a replacement for the complete GitHub Validation / Gate.
Security scans, CodeQL, release-diff policy where applicable, protected-environment
checks, and required reviews remain separate. Every plan/result explicitly marks
remote validation as required. A fast result also names deferred local tasks.
A local audit result is not permission to mark a PR ready or merge it.

## Execution and evidence

Install the repository's locked dependencies through its normal setup process
before running checks. This CLI does not add an implicit install step or grant
credentials. It runs trusted repository scripts in the existing environment;
those scripts are not sandboxed and retain their normal tool/network behavior.
The formatter/runtime's existing semantics are unchanged: a configured command
that rewrites files still rewrites files. Prefer check-only scripts in CI.

Task stdout/stderr goes to stderr, keeping `--json` stdout parseable. Each selected
applicable task runs through the public runtime. A zero exit without a fresh,
matching, successful task receipt fails. A failed task blocks remaining applicable
tasks; optional inapplicable tasks are reported as skipped. An entirely skipped
check is labeled `skipped`, never `passed`.

A run stores `.code-foundry/agent-results/check-*/summary.json` and snapshots of
its task receipts. The result includes the source commit, dirty-tree indication,
selected/deferred tasks, reasons, exit codes, signals, receipt paths, and repository
artifact paths such as coverage or browser evidence. HEAD identifies the base
commit; a dirty working tree is not a cryptographically identified immutable
source snapshot. Reports are local evidence, not signed provenance.

The aggregate and task receipts are retained per run so later checks do not
overwrite the earlier JSON evidence. Artifact paths inside receipts point to
repository-owned files and may be overwritten by subsequent test runs; copy them
into a CI artifact for long-term retention. Do not upload the whole hidden
repository tree or secrets. The CLI neither captures environment variables into
reports nor grants publish/merge/deploy access.

An exclusive local `agent-results/active.lock` prevents overlapping agent checks
from confusing receipts. After a killed process, inspect the checkout and confirm
there is no active check before manually removing a stale lock. Normal completion
and failures clean the lock. This is a local CLI lock, not a distributed lock
against every other tool writing into the repository.

`--timeout SECONDS` bounds each check subprocess (default 600, range 1–3600).
A timeout or missing receipt fails. Project scripts remain responsible for
cleaning up their own servers and subprocesses. Plans do not accept an execution
timeout. Unknown, duplicate, or ignored arguments fail rather than silently alter
validation behavior.

## Integration and tests

This change depends on the required-capabilities/task-evidence runtime change.
It deliberately imports shared policy instead of maintaining a competing copy.
Merge that prerequisite before this CLI change and retain `runtime-core.mjs` when
vendoring the runtime.

Run `node --test test/agent-check.test.mjs`. Tests exercise real Git change
inspection and the actual policy/evidence wrapper with a deterministic ecosystem
executor, including read-only planning, required deferred tasks, failed commands,
stale evidence, receipt snapshots, locking, and separation of JSON from task logs.
Full ecosystem dependencies and GitHub-side checks still need their own CI run.
