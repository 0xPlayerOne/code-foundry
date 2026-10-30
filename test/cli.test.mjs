Warning: truncated output (original token count: 63720)
Total output lines: 6040

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectLanguages, recommendRunners, resolveProfile } from '../src/lib/profile.mjs'
import {
  approvedReleaseFiles,
  buildReconciliationPullRequestBody,
  buildReleaseRecoveryPlan,
  classifyPromotion,
  classifyReconciliation,
  reconciliationPullRequestBranch,
  reconciliationPullRequestTitle,
  selectReconciliationPullRequest,
  selectReleaseCredential,
  validateReleasePullRequests,
} from '../src/lib/release-policy.mjs'
import {
  validateCargoLockVersions,
  validateGeneratedReleaseDiff,
} from '../src/lib/release-policy.mjs'
import {
  buildReleaseConfig,
  buildReleaseManifest,
  detectReleasePackages,
  validateReleaseConfig,
} from '../src/lib/release-manifest.mjs'
import {
  AGGREGATE_CHECK_NAME,
  RELEASE_PLEASE_PREFIX,
  VALIDATION_EVENTS,
  VALIDATION_JOBS,
  VALIDATION_MODES,
  classifyValidationMode,
  evaluateValidationGate,
  isReleasePleaseHead,
  requiredValidationJobs,
} from '../src/lib/validation-policy.mjs'
import {
  hasDeliveredHook,
  releaseDeliveryKey,
  selectHookDelivery,
} from '../src/lib/release-hook.mjs'
import { doctor, rustManifestPaths } from '../src/commands/doctor.mjs'
import { doctorGithub } from '../src/lib/github-doctor.mjs'
import { reconcileRelease, validateReleasePullRequestDiffs } from '../src/commands/release.mjs'
import { pinRuntimeRefs, syncRepository } from '../src/commands/sync.mjs'
import { parseAgentArgs } from '../src/commands/agent-check.mjs'
import {
  buildPausedRuleset,
  buildResumedRuleset,
  CI_BILLING_REQUIRED_CHECK,
} from '../src/commands/ci.mjs'

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
const runtime = fileURLToPath(new URL('../src/runtime.mjs', import.meta.url))
const sourceRuntimeRef = `v${JSON.parse(readFileSync('package.json', 'utf8')).version}`
const expectedHooksWarning = 'WARN: Git hooks are not enabled; run `npx code-foundry init`'
const expectedStaleCallerWarning =
  'WARN: stale generated legacy caller ci.yml still triggers canonical suites; run code-foundry sync to migrate to validation.yml.'
const expectedUnreleasedRuntimeWarning =
  'WARN: validation caller runtime ref main is not a released tag; pin a vX.Y.Z tag.'
const testEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== 'GITHUB_OUTPUT')
)

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' })
}

function remoteHeadSha(root, branch) {
  const result = git(root, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])
  if (result.status !== 0) return ''
  const [sha] = result.stdout.trim().split(/\t/, 1)
  return sha || ''
}

describe('Rust doctor discovery', () => {
  it('validates owned nested crates without treating vendored manifests as repositories', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-nested-rust-'))
    mkdirSync(join(root, 'apps/desktop/src-tauri/src'), { recursive: true })
    mkdirSync(join(root, 'vendor/glib/src'), { recursive: true })
    writeFileSync(
      join(root, 'apps/desktop/src-tauri/Cargo.toml'),
      '[package]\nname = "nested-app"\nversion = "0.1.0"\nedition = "2021"\n'
    )
    writeFileSync(
      join(root, 'apps/desktop/src-tauri/src/lib.rs'),
      'pub fn ready() -> bool { true }\n'
    )
    writeFileSync(
      join(root, 'vendor/glib/Cargo.toml'),
      '[package]\nname = "vendored-glib"\nversion = "0.1.0"\nedition = "2021"\n'
    )

    assert.deepEqual(rustManifestPaths(root), ['apps/desktop/src-tauri/Cargo.toml'])
    rmSync(root, { recursive: true, force: true })
  })
})

/**
 * Assert main is an ancestor of head in the remote-tracked branch refs.
 * @param {Object} context
 * @param {Function} context.run
 * @param {string} context.base
 * @param {string} context.head
 */
function assertRemoteMainAncestor(context) {
  const { run: runRemote, base, head } = context
  const fetched = runRemote(['fetch', 'origin', base, head])
  assert.equal(fetched.status, 0, fetched.stderr)
  const ancestor = runRemote(['merge-base', '--is-ancestor', `origin/${base}`, `origin/${head}`])
  assert.equal(ancestor.status, 0, ancestor.stderr)
}

/**
 * Run a function with temporary GitHub env variables.
 * @param {Record<string, string | undefined>} env
 * @param {Function} fn
 */
function withGitHubEnv(env, fn) {
  const previous = {
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  }
  Object.entries(env).forEach(([key, value]) => {
    if (value == null) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  })
  try {
    return fn()
  } finally {
    if (previous.GITHUB_REPOSITORY == null) {
      delete process.env.GITHUB_REPOSITORY
    } else {
      process.env.GITHUB_REPOSITORY = previous.GITHUB_REPOSITORY
    }
    if (previous.GH_TOKEN == null) {
      delete process.env.GH_TOKEN
    } else {
      process.env.GH_TOKEN = previous.GH_TOKEN
    }
    if (previous.GITHUB_TOKEN == null) {
      delete process.env.GITHUB_TOKEN
    } else {
      process.env.GITHUB_TOKEN = previous.GITHUB_TOKEN
    }
  }
}

/**
 * @param {string[]} secretNames
 * @param {Function} fn
 */
function withFakeGh(secretNames, fn) {
  const oldPath = process.env.PATH
  const dir = mkdtempSync(join(tmpdir(), 'code-foundry-gh-'))
  const script = join(dir, 'gh')
  const payload = secretNames
    .map((name) => ({ name }))
    .map((entry) => JSON.stringify(entry))
    .join(',\n')
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "--version" ]; then
  echo 'gh version 2.55.0'
  exit 0
fi
if [ "$1" = "secret" ] && [ "$2" = "list" ]; then
  cat <<'JSON'
[${payload}]
JSON
  exit 0
fi
if [ "$1" = "api" ]; then
  case "$2" in
    repos/*/rulesets)
      echo '[]'
      ;;
    repos/*/rulesets/*)
      echo '{}'
      ;;
    repos/*/branches/main/protection)
      echo '{}'
      ;;
    repos/*/git/ref/heads/main)
      echo '{"object":{"sha":"abc"}}'
      ;;
    repos/*/commits/main/check-runs*)
      echo '{"check_runs":[]}'
      ;;
    *)
      echo '{}'
      ;;
  esac
  exit 0
fi
if [ "$1" = "variable" ] && [ "$2" = "list" ]; then
  echo '[]'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  echo '[]'
  exit 0
fi
echo '{}'
`
  )
  chmodSync(script, 0o755)
  process.env.PATH = `${dir}:${oldPath}`
  try {
    return fn()
  } finally {
    process.env.PATH = oldPath
    rmSync(dir, { recursive: true, force: true })
  }
}

function createReconcileWorkspace() {
  const remote = mkdtempSync(join(tmpdir(), 'code-foundry-remote-'))
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-workspace-'))
  git(remote, ['init', '--bare'])
  const runWorkspace = (args) => git(root, args)
  runWorkspace(['init', '-q'])
  runWorkspace(['config', 'user.email', 'test@example.com'])
  runWorkspace(['config', 'user.name', 'Test'])
  runWorkspace(['remote', 'add', 'origin', remote])
  return { root, remote, run: runWorkspace }
}

/**
 * Workspace where staging is protected by a ruleset: main carries an approved
 * release commit ahead of staging, and every exact-lease push to staging is
 * rejected with a branch-policy error while the reconciliation head branch
 * remains pushable.
 * @param {{ withStagingCommit?: boolean }} [options]
 * @returns {{ root: string, remote: string, run: (args: string[]) => import('node:child_process').SpawnSyncReturns<string>, readRef: (ref: string) => string, commit: (message: string) => string }}
 */
function createPolicyBlockedReconcileWorkspace({ withStagingCommit = false } = {}) {
  const { root, remote, run: …59720 tokens truncated…pipefail
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  cat <<'JSON'
[{"number":42,"title":"chore(main): release 1.0.1","headRefName":"release-please--branches--main","headRefOid":"${auditedHead}"}]
JSON
elif [ "$1" = "pr" ] && [ "$2" = "diff" ]; then
  printf 'CHANGELOG.md\\npackage.json\\n'
elif [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"headRefOid":"%s"}\\n' "$FAKE_RELEASE_HEAD"
else
  exit 2
fi
`
    )
    chmodSync(script, 0o755)

    try {
      process.env.PATH = `${ghDir}:${oldPath}`
      console.log = () => {}
      withGitHubEnv({ GITHUB_REPOSITORY: 'owner/repo' }, () => {
        process.env.FAKE_RELEASE_HEAD = auditedHead
        const valid = validateReleasePullRequestDiffs(root)
        assert.equal(valid.valid, true)
        assert.equal(valid.generated[0].headRefOid, auditedHead)

        process.env.FAKE_RELEASE_HEAD = 'b'.repeat(40)
        assert.throws(
          () => validateReleasePullRequestDiffs(root),
          /changed head while its path diff was being validated/
        )
      })
    } finally {
      console.log = oldLog
      process.env.PATH = oldPath
      if (oldHead == null) delete process.env.FAKE_RELEASE_HEAD
      else process.env.FAKE_RELEASE_HEAD = oldHead
      rmSync(ghDir, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects generated release diffs with a stale configured Cargo.lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-cargo-release-'))
    const desktopRoot = join(root, 'apps', 'desktop', 'src-tauri')
    mkdirSync(desktopRoot, { recursive: true })
    writeFileSync(
      join(desktopRoot, 'Cargo.toml'),
      '[package]\nname = "agent-hq-desktop"\nversion = "0.3.2"\n'
    )
    writeFileSync(
      join(desktopRoot, 'Cargo.lock'),
      '# generated\n\n[[package]]\nname = "agent-hq-desktop"\nversion = "0.3.1"\n'
    )
    const config = {
      'extra-files': [{ type: 'generic', path: 'apps/desktop/src-tauri/Cargo.lock' }],
    }
    const errors = validateCargoLockVersions(root, config)
    assert.match(
      errors.join(' '),
      /Cargo\.lock version 0\.3\.1 does not match .*Cargo\.toml version 0\.3\.2/
    )
    const result = validateGeneratedReleaseDiff({
      headRef: 'release-please--branches--main--v0.3.2',
      headRepo: 'owner/repo',
      repository: 'owner/repo',
      changedPaths: ['package.json', 'apps/desktop/src-tauri/Cargo.toml'],
      config,
      root,
    })
    assert.equal(result.valid, false)
    assert.match(result.errors.join(' '), /Cargo\.lock version 0\.3\.1/)
  })

  it('validates generated release diffs through the runtime release_diff task', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-release-diff-'))
    const runGitCmd = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    runGitCmd(['init', '-q'])
    runGitCmd(['config', 'user.email', 'test@example.com'])
    runGitCmd(['config', 'user.name', 'Test'])
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
    runGitCmd(['add', '-A'])
    runGitCmd(['commit', '-q', '-m', 'base'])
    const baseSha = runGitCmd(['rev-parse', 'HEAD']).stdout.trim()
    runGitCmd(['checkout', '-q', '-b', 'release-please--branches--main--v1.0.0'])
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.1.0"}\n')
    runGitCmd(['add', '-A'])
    runGitCmd(['commit', '-q', '-m', 'chore(main): release 1.1.0'])
    const runReleaseDiff = (env) =>
      spawnSync(process.execPath, [runtime, 'validation', 'release_diff'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...testEnv, ...env },
      })
    const valid = runReleaseDiff({
      FOUNDRY_BASE_SHA: baseSha,
      FOUNDRY_HEAD_REF: 'release-please--branches--main--v1.0.0',
      FOUNDRY_HEAD_REPO: 'owner/repo',
      FOUNDRY_REPOSITORY: 'owner/repo',
    })
    assert.equal(valid.status, 0, valid.stderr)
    assert.match(valid.stdout, /Release policy passed/)
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src/index.ts'), 'export const value = 1\n')
    runGitCmd(['add', '-A'])
    runGitCmd(['commit', '-q', '-m', 'sneak'])
    const sneaky = runReleaseDiff({
      FOUNDRY_BASE_SHA: baseSha,
      FOUNDRY_HEAD_REF: 'release-please--branches--main--v1.0.0',
      FOUNDRY_HEAD_REPO: 'owner/repo',
      FOUNDRY_REPOSITORY: 'owner/repo',
    })
    assert.notEqual(sneaky.status, 0)
    assert.match(sneaky.stderr, /unexpected paths: src\/index\.ts/)
    const fork = runReleaseDiff({
      FOUNDRY_BASE_SHA: baseSha,
      FOUNDRY_HEAD_REF: 'release-please--branches--main--v1.0.0',
      FOUNDRY_HEAD_REPO: 'evil/fork',
      FOUNDRY_REPOSITORY: 'owner/repo',
    })
    assert.notEqual(fork.status, 0)
    assert.match(fork.stderr, /same-repository/)
  })

  it('produces a non-destructive release recovery plan', () => {
    const plan = buildReleaseRecoveryPlan({
      tags: ['v1.0.0', 'v1.1.0'],
      releases: [{ tagName: 'v1.0.0' }],
      releasePrs: [{ number: 9, title: 'chore(main): release 1.1.0' }],
      packageVersions: ['1.1.0'],
    })
    assert.deepEqual(plan.missingGitHubReleases, ['v1.1.0'])
    assert.deepEqual(plan.pendingReleasePullRequests, [
      { number: 9, title: 'chore(main): release 1.1.0' },
    ])
    assert.equal(plan.packageVersionMismatch, false)
    assert.match(plan.actions[0], /v1\.1\.0/)
  })
})

/** @param {string} stem */
/**
 * @param {string} file
 * @returns {Array<{ file: string, line: number }>} checkout steps that lack persist-credentials: false
 */
function listCheckoutStepsWithoutPersistCredentialsFalse(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const checkoutPattern = /^\s*uses:\s*actions\/checkout@/
  const stepStartPattern = /^(\s*)-\s+/
  const issues = []

  for (let i = 0; i < lines.length; i++) {
    const checkoutMatch = lines[i].match(checkoutPattern)
    if (!checkoutMatch) continue

    const usesIndent = (lines[i].match(/^\s*/) || [''])[0].length
    let stepIndent = usesIndent
    for (let k = i - 1; k >= 0; k--) {
      const stepMatch = lines[k].match(stepStartPattern)
      if (stepMatch) {
        stepIndent = stepMatch[1].length
        break
      }
    }

    let hasWith = false
    let inWith = false
    let withIndent = -1
    let persistValue = null

    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j]
      if (!raw.trim()) continue

      const stepMatch = raw.match(stepStartPattern)
      if (stepMatch && stepMatch[1].length <= stepIndent) break
      if (/^\S/.test(raw)) break

      const indent = (raw.match(/^\s*/) || [''])[0].length
      const trimmed = raw.trim()

      if (trimmed === 'with:') {
        if (indent === usesIndent) {
          hasWith = true
          inWith = true
          withIndent = indent
        }
        continue
      }

      if (!inWith) continue
      if (indent <= withIndent) {
        inWith = false
        continue
      }

      const match = trimmed.match(/^persist-credentials:\s*(.+)$/)
      if (match) {
        persistValue = match[1].trim()
      }
    }

    if (!hasWith || persistValue !== 'false') {
      issues.push({ file, line: i + 1 })
    }
  }

  return issues
}

function legacyCaller(stem) {
  return [
    'name: Code Foundry',
    '',
    'on:',
    '  push:',
    '    branches: [main, staging]',
    '  pull_request:',
    '    branches: [main, staging]',
    '  workflow_dispatch:',
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    `  ${stem}:`,
    `    name: ${stem}`,
    `    uses: 0xPlayerOne/code-foundry/.github/workflows/${stem}.yml@v0.31.12`,
    '    with:',
    '      runtime-repository: 0xPlayerOne/code-foundry',
    '      runtime-ref: v0.31.12',
    '      runner: ubuntu-latest',
    '    secrets: inherit',
    '',
  ].join('\n')
}

function exists(file) {
  try {
    readFileSync(file)
    return true
  } catch {
    return false
  }
}
