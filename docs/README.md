# Documentation

Code Foundry's documentation is organized by the job you are trying to do. Most
guides describe the reusable baseline; platform-specific guides call out their
provider assumptions. Adapt repository names, environments, and deployment
details before copying any guide elsewhere.

## Start here

- [Initialization and synchronization](INITIALIZATION.md) — install, update, and diagnose a baseline.
- [Configuration reference](CONFIGURATION.md) — choose workflows, runtimes, validation, and release policy.
- [Workflow and CI conventions](WORKFLOWS.md) — understand triggers, checks, runners, caching, and branch protection.
- [Extension points](EXTENSIONS.md) — keep custom workflows and post-release delivery alongside the baseline.

## Validation and quality

- [Agent-facing validation](agent-validation.md) — run local plans and checks with machine-readable evidence.
- [Required capabilities and task evidence](required-capabilities.md) — require tasks, coverage, and retained receipts.
- [Performance budgets](PERFORMANCE.md) — maintain runtime, CI, and package-size budgets.
- [Product quality profiles](product-quality.md) — add acceptance checks for sites, apps, Workers, and packages.
- [Merge queue validation](merge-queues.md) — validate GitHub merge-group commits.

## Releases and publishing

- [Release management](RELEASES.md) — branch topologies, Release Please, and release permissions.
- [Publishing packages](PUBLISHING.md) — npm, GitHub Releases, and provenance guidance.
- [Release integrity and build provenance](release-integrity.md) — immutable releases, verification, and attestations.
- [Consumer qualification](consumer-qualification.md) — test the packaged release across consumer fixtures.
- [Qualified publication](qualified-publication.md) — publish the exact qualified Code Foundry archive.

## Fleet and deployment operations

- [Declarative fleet rollouts](fleet-rollouts.md) — inventory, canaries, staged upgrades, and recovery.
- [Fleet release eligibility](fleet-release-eligibility.md) — require verified release evidence before upgrades.
- [Verified Cloudflare delivery](cloudflare-delivery.md) — build, verify, canary, and promote Worker versions.
- [Caching and remote caching](CACHING.md) — configure package, build, and Turborepo caching.

## Repository-specific documentation

Add architecture notes, runbooks, and deployment instructions to this directory.
The initializer preserves `docs/` during synchronization. Link supported guides
from this index and prefer task-oriented filenames.
