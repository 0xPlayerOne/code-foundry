# Declarative fleet inventory and staged rollouts

Place `code-foundry-fleet.json` in the directory passed to `--root`. Its presence
opts that fleet into inventory-based discovery and controlled upgrades, without
changing legacy directory discovery for existing users.

```json
{
  "schemaVersion": 1,
  "cohorts": ["canary", "applications"],
  "repositories": [
    {
      "repository": "owner/package-canary",
      "path": "packages/package-canary",
      "cohort": "canary",
      "profile": "published-package",
      "expected": { "git_workflow": "direct" },
      "requiredCapabilities": ["unit", "performance"],
      "validation": [
        ["bun", "install", "--frozen-lockfile"],
        ["bun", "run", "test:unit"],
        ["bun", "run", "test:consumer"],
        ["bun", "run", "performance:check"]
      ],
      "requiredChecks": ["Validation / Gate"]
    },
    {
      "repository": "owner/application",
      "path": "applications/application",
      "cohort": "applications",
      "validation": [
        ["bun", "install", "--frozen-lockfile"],
        ["bun", "run", "type-check"],
        ["bun", "run", "test:unit"]
      ],
      "requiredChecks": ["Validation / Gate"]
    }
  ]
}
```

Repository names in the example are placeholders. Populate the actual fleet
before use. Paths are relative to the manifest, may be arbitrarily nested, and
must not escape through `..`, absolute paths, or symlinks. Missing checkouts and
origin mismatches remain visible as blocked inventory entries rather than silently
disappearing. There is no automatic clone or repository-settings mutation.

`profile` is a descriptive inventory annotation; it does not install tools or
activate a quality profile. `expected` maps scalar `.github/code-foundry.yml` keys
to desired values; `requiredCapabilities` audits declarations in that same file.
The runtime-upgrade operation does not silently author missing capability policy.
Adopt those requirements in consumer repositories before requiring them here.

## Commands

```sh
code-foundry fleet status --root /path/to/fleet
code-foundry fleet upgrade --root /path/to/fleet --dry-run
code-foundry fleet upgrade --root /path/to/fleet --create-pr
```

Run from the intended released Code Foundry installation/checkout. The existing
source-version guard still rejects mismatched `--version` requests. Manifest mode
requires `--create-pr` or `--dry-run` and never syncs original checkouts in place.
`--force` does not bypass dirty-tree safety in manifest mode. Dry-run reports
inventory, target version, and configuration drift without network calls, running
consumer commands, or modifying files. Status likewise audits local facts; it does
not pretend to verify remote branch protection or environment settings.

The first incomplete cohort is the only cohort allowed to create PRs. All
non-excepted members of each earlier cohort must have a matching managed upgrade
PR that is merged, successful explicitly named required checks on its head SHA,
no still-pending/failed checks, and the target runtime/configuration still present
on its current base branch. Neutral/skipped required checks do not qualify.
Unknown, inaccessible, closed-without-merge, stale, or failed evidence does not
unlock subsequent cohorts. One local validation failure stops remaining work.

Each repository must supply explicit validation argv arrays. Include locked
installation, application checks, and genuine consumer compatibility tests where
relevant. No shell splitting is used. Commands run in an isolated detached
worktree, have bounded execution time, and must not rewrite the candidate source.
Validation is not a security sandbox: commands run as the invoking user with its
inherited environment and network access. Treat the manifest and every validation
command as trusted code; do not use this feature with unreviewed manifests or
credentials that the checks should not access.
Only files changed by Code Foundry sync are staged; generated test evidence and
other untracked files are not swept into the commit. A commit-hook change to the
validated Git tree is rejected before publishing.

This implementation does not create an automatic scheduler, mark PRs ready,
merge PRs, lower checks, or bypass review. After reviewing and validating canaries,
merge their PRs normally and run the fleet command again to advance the cohort.
A repository already at the target version with no managed PR does not establish
canary evidence; choose a real upgrade canary rather than treating an empty diff
as successful rollout validation.

## Resuming and intentional exceptions

The target version and complete repository policy produce a deterministic branch
and PR marker. Repeated runs return an existing matching open PR instead of
creating duplicates. If push succeeded but PR creation failed, the next run
recognizes the managed commit and recorded tree identity, reruns consumer
validation, and creates the missing **draft** PR without force-pushing. Unknown
branches or commits with mismatched tree markers are preserved and blocked for
manual review. Local managed refs preserve committed work after a failed push.
The marker is an ownership/recovery guard, not a cryptographic signature.

PR creation is draft-first in both manifest and legacy discovery modes. A PR that
a human has already made ready is not silently converted back or modified.

An entry may include a reviewed time-limited exception:

```json
{ "exception": { "reason": "Pending consumer compatibility work", "expires": "2026-10-01" } }
```

Exceptions appear explicitly in inventory/rollout output. Expired/invalid dates
fail parsing. The command's existing `--exclude` flag is also honored. Excluding
all canaries never satisfies a canary gate or unlocks later cohorts. Update the
manifest deliberately when cohort membership or compatibility policy changes.

## Evidence and tests

Upgrade output is schema-versioned JSON with target version, aggregate status,
per-repository cohort/status, PR link, and local validation command exit statuses.
Failed command output is not copied into reports, avoiding accidental credentials
in logs; reproduce the declared command locally for full debugging output. A
failed rollout returns a nonzero exit status. Pending PRs are not failures and do
not grant permission to advance a cohort. Worktree cleanup failures preserve the
isolated path and report it rather than deleting unknown paths.

`node --test test/fleet-manifest.test.mjs` includes actual local Git repositories,
bare remotes, isolated worktrees, validation failure, orphan-branch recovery,
clean-original preservation, and canary advancement. Only GitHub responses are
fixture-backed; no real fleet repositories or remote PRs are modified by tests.

GitHub CLI contracts:
https://cli.github.com/manual/gh_pr_list
https://cli.github.com/manual/gh_pr_create
