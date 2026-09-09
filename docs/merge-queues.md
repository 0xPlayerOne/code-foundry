# Merge Queue Validation

Opt-in validation of the combined commit produced by GitHub's merge queue.

**Activation:** `merge_queue: true` in the consumer's `.github/code-foundry.yml`, followed by normal sync.
**Required check:** Existing canonical `Validation / Gate`.

The synchronizer adds `.github/workflows/validation-merge-queue.yml` only when
explicitly enabled. The ordinary PR readiness workflow is unchanged: this feature
does not turn draft pushes into CI, mark PRs ready, enqueue PRs, or change release
behavior. Queue events receive the full audit even when staging PRs normally use
fast validation. Release Please branch detection is deliberately not reused for
a merge group containing several PRs; the group's combined tree is audited, not
treated as a generated version-only diff.

```yaml
merge_queue: true
```

Normal `code-foundry sync` updates the generated queue caller alongside the other
runtime pins. Explicit fleet runtime overrides are honored. The installed runtime
must contain this feature, and queues require an exact commit or released version
pin rather than a moving branch. Direct topology enables main; staging-release
enables main and staging. Existing runner choices, Rust CodeQL sharding, and an
explicit `codeql: false` policy select the same appropriate validation orchestrator
as ordinary PRs. No CodeQL policy or runtime default is relaxed.

## Event identity and checks

The generated caller accepts only `merge_group` / `checks_requested`. A pinned,
trusted verifier checks the payload's repository, allowed base branch, queue ref,
base SHA, and head SHA against the actual workflow context before validation can
start. The existing reusable orchestrator then checks out the merge-group commit
through its normal GitHub context and runs CI, tests (including non-unit lanes),
security, and the configured CodeQL policy with `mode: audit`.

The caller job is named `Validation`, so the existing orchestrator still emits
`Validation / Gate`. That gate's audit truth table requires successful results;
skipped or failed required jobs cannot satisfy it. A failed identity job prevents
validation from starting and cannot manufacture a successful aggregate check.
The standard PR classifier remains PR/scheduled/manual-specific; merge groups
have their own strict classifier rather than weakening its event whitelist.

Concurrency is scoped to the actual queue ref and has a different prefix from PR,
release, and scheduled workflows. New groups do not cancel unrelated groups or
PR readiness runs. Replaced attempts for the same queue ref can supersede each
other. The billing-pause switch is preserved; paused validation does not produce
a success that authorizes a merge.

The caller forwards no secrets and grants no deployment or OIDC publication
permission. Its permission union matches the existing audit chain (including
CodeQL security-event uploads). Applications requiring secret-backed tests must
provide safe queue-compatible fixtures or a separately reviewed explicit caller;
this feature does not introduce `secrets: inherit`. Native test commands remain
repository-owned code, not a sandbox.

## Preservation and disabling

Setting `merge_queue: false` or removing the key removes only a caller bearing the
exact Foundry management marker. A custom file at that path is preserved when
disabled; enabling over it fails before synchronization writes, even with force.
Symlinked workflow paths are rejected. Dry runs report changes without creating,
updating, or deleting the caller. The original synchronizer is retained verbatim
in `sync-core.mjs`; its public exports are preserved through the thin wrapper.

Disable the repository's queue rule before removing its required queue workflow.
Otherwise queued PRs will correctly wait for checks that no longer run.

## Repository activation remains separate

A repository administrator must verify GitHub plan/repository eligibility,
review queue merge-method compatibility with the chosen branch topology, and
configure required checks. Register the aggregate check, not PR-only mode or
readiness checks that have no merge-group equivalent. An existing rule requiring
individual checks needs those exact contexts reviewed as well. Do not enable the
queue rule before the workflow is merged and a disposable queue exercise passes.
No repository rule, branch protection, secret, merge setting, or queue is changed
by this PR.

Focused tests cover event identity and rejection, generated audit wiring,
configured CodeQL policy, pin evolution, idempotence, dry runs, and ownership
preservation. They do not establish a live merge-group run or full sync integration.
Before readiness, run the existing complete sync/fleet tests, locked formatter,
linter, TypeScript and package budgets, and Actionlint against rendered callers
and their pinned/local reusable workflow contracts. Exercise two queued PRs and
one deliberately failing check in an eligible disposable repository.

References: [GitHub merge-queue CI configuration](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue),
[merge-group event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group).
