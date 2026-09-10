# Consumer Qualification

Release-candidate compatibility checks against the distributable package.

**Status:** Opt-in reusable workflow; required by Code Foundry's own release caller.
**Scope:** Package installation, CLI initialization/synchronization, generated workflow contracts.

`consumer-qualification.yml` packs the checked-out candidate once, shares that
archive across Node 24 and 26 using an artifact scoped to the same workflow
run **and attempt**, and installs it offline with lifecycle scripts disabled,
and executes its public CLI from the installed package. The harness does not
import the source checkout's initializer as a substitute for package testing.

The matrix covers npm, pnpm, Yarn, Bun, direct and staging-release topologies,
authored documentation and workflows, an existing mise selection, and nested
Rust/Python manifests. It checks detected package managers, byte preservation,
and two successive no-change synchronizations. Lockfiles are detection fixtures:
this suite does not claim to install or execute every ecosystem toolchain.
Repository unit/policy suites and real consumer canaries remain required.

Actionlint checks copies of generated callers against the candidate's local
reusable workflows. Only exact candidate repository/ref calls are localized;
production callers and custom workflows are never edited by this step. Shellcheck
and Pyflakes are disabled here because this gate tests Actions contracts; existing
shell/security validation remains independent. Actionlint is pinned to v1.7.12.

```sh
npm pack --ignore-scripts --pack-destination /tmp/candidate
node src/lib/consumer-qualification.mjs \
  /tmp/candidate/code-foundry-VERSION.tgz \
  "$(git rev-parse HEAD)" /tmp/qualification.json /absolute/path/to/actionlint
```

The JSON report binds the result to the source SHA, archive SHA-256, Node version,
and completed fixtures. Failed runs retain `complete: false`. Running without
Actionlint is a local structural probe only (`actionlint: false`), not release
qualification. Downstream eligibility must require both `complete` and
`actionlint`, the expected source/digest, and successful reports for every matrix
member. Reports are evidence, not signatures or a substitute for release identity
verification.

The self release caller cannot start Release Please or npm publication until all
qualification jobs and the aggregate `Gate` succeed. An explicit
`release-while-paused` dispatch is passed through to the reusable workflow;
ordinary calls remain blocked by the billing pause. Consumer-generated release
callers do not inherit this Code Foundry-specific qualification job. Code
Foundry's self caller passes the qualified archive to the verified publication
workflow, which independently rechecks the same bytes before publishing. No
branch protections, repository settings, credentials, or consumer runtimes are
changed by this workflow.

## Verified handoff and reruns

The reusable workflow exports `filename`, `source-sha`, `sha256`, and
`candidate-artifact`. Only the gate exports the verified source, digest, and
artifact identity. It requires a successful pack and complete Node matrix,
retrieves every report from the current attempt, and checks all fixture results
against the same source and archive through the publication eligibility policy.
Its retained `qualification-handoff-RUN_ID-ATTEMPT` receipt records that identity.
A green matrix without valid matching reports cannot authorize a release.

Artifacts are never overwritten. On a failed or cancelled qualification, use
**Re-run all jobs**, not a failed-job-only rerun: a later attempt cannot reuse
an earlier pack or silently combine old and new reports. Missing/expired artifacts
fail closed; start a fresh complete run. This stricter retry policy also applies
when qualification is nested in a release workflow. No release settings change.
