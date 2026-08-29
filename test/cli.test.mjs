import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { appendFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectLanguages, recommendRunners, resolveProfile } from '../src/lib/profile.mjs'
import { approvedReleaseFiles, buildReconciliationPullRequestBody, buildReleaseRecoveryPlan, classifyPromotion, classifyReconciliation, reconciliationPullRequestBranch, reconciliationPullRequestTitle, selectGeneratedReleasePrs, selectReconciliationPullRequest, selectReleaseCredential, validateReleasePullRequests } from '../src/lib/release-policy.mjs'
import { validateCargoLockVersions, validateGeneratedReleaseDiff } from '../src/lib/release-policy.mjs'
import { buildReleaseConfig, buildReleaseManifest, detectReleasePackages, validateReleaseConfig } from '../src/lib/release-manifest.mjs'
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
import { hasDeliveredHook, releaseDeliveryKey, selectHookDelivery } from '../src/lib/release-hook.mjs'
import { doctor } from '../src/commands/doctor.mjs'
import { doctorGithub } from '../src/lib/github-doctor.mjs'
import { reconcileRelease } from '../src/commands/release.mjs'
import { syncRepository } from '../src/commands/sync.mjs'
import { buildPausedRuleset, buildResumedRuleset, CI_BILLING_REQUIRED_CHECK } from '../src/commands/ci.mjs'

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
const runtime = fileURLToPath(new URL('../src/runtime.mjs', import.meta.url))
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

/**
 * Assert main is an ancestor of head in the remote-tracked branch refs.
 * @param {Object} context
 * @param {Function} context.run
 * @param {string} context.base
 * @param {string} context.head
 */
function assertRemoteMainAncestor(context) {
  const { run, base, head } = context
  const fetched = run(['fetch', 'origin', base, head])
  assert.equal(fetched.status, 0, fetched.stderr)
  const ancestor = run(['merge-base', '--is-ancestor', `origin/${base}`, `origin/${head}`])
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
  const payload = secretNames.map((name) => ({ name })).map((entry) => JSON.stringify(entry)).join(',\n')
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set -euo pipefail
if [ \"$1\" = \"--version\" ]; then
  echo 'gh version 2.55.0'
  exit 0
fi
if [ \"$1\" = \"secret\" ] && [ \"$2\" = \"list\" ]; then
  cat <<'JSON'
[${payload}]
JSON
  exit 0
fi
if [ \"$1\" = \"api\" ]; then
  case \"$2\" in
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
if [ \"$1\" = \"variable\" ] && [ \"$2\" = \"list\" ]; then
  echo '[]'
  exit 0
fi
if [ \"$1\" = \"pr\" ] && [ \"$2\" = \"list\" ]; then
  echo '[]'
  exit 0
fi
echo '{}'
`,
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
  const run = (args) => git(root, args)
  run(['init', '-q'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test'])
  run(['remote', 'add', 'origin', remote])
  return { root, remote, run }
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
  const { root, remote, run } = createReconcileWorkspace()
  const readRef = (ref) => {
    const result = run(['rev-parse', ref])
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  const commit = (message) => {
    const result = run(['commit', '-m', message])
    assert.equal(result.status, 0, result.stderr)
    return readRef('HEAD')
  }

  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n')
  writeFileSync(join(root, 'src/index.ts'), 'export const base = 1\n')
  run(['add', 'package.json', 'CHANGELOG.md', 'src/index.ts'])
  commit('chore: initial')
  run(['branch', '-M', 'main'])

  run(['checkout', '-q', '-b', 'staging'])
  if (withStagingCommit) {
    writeFileSync(join(root, 'src/feature-pending.ts'), 'export const pending = 1\n')
    run(['add', 'src/feature-pending.ts'])
    commit('feat: pending work')
  }

  run(['checkout', '-q', 'main'])
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.1"}\n')
  appendFileSync(join(root, 'CHANGELOG.md'), '\n## 1.0.1\n', 'utf8')
  run(['add', 'package.json', 'CHANGELOG.md'])
  commit('chore(main): release 1.0.1')

  run(['push', '-u', 'origin', 'main'])
  run(['checkout', '-q', 'staging'])
  run(['push', '-u', 'origin', 'staging'])
  return { root, remote, run, readRef, commit }
}

const POLICY_PUSH_FAILURE = 'remote: error: GH007: Your push was rejected by a repository rule.\nremote: error: protected branch hook declined.\nTo github.com/owner/repo.git\n ! [remote rejected] staging -> staging (push declined by rule)'

/**
 * @param {(git: string) => void} fn
 * @param {string} message
 */
function withFakeGitPushFailure(fn, message) {
  const oldPath = process.env.PATH
  const toolDir = mkdtempSync(join(tmpdir(), 'code-foundry-git-failure-'))
  const script = join(toolDir, 'git')
  const originalGit = spawnSync('sh', ['-lc', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
  writeFileSync(
    script,
    `#!/bin/sh
if [ "$1" = "push" ] && [ "$2" = "origin" ]; then
  echo "${message}"
  exit 1
fi
exec ${originalGit} "$@"
`,
  )
  chmodSync(script, 0o755)
  process.env.PATH = `${toolDir}:${oldPath}`
  try {
    return fn()
  } finally {
    process.env.PATH = oldPath
    rmSync(toolDir, { recursive: true, force: true })
  }
}

/**
 * Fail only the exact-lease reconcile push to staging so the policy fallback
 * can still create and refresh the reconciliation head branch.
 * @param {Function} fn
 * @param {string} message
 */
function withFakeStagingPolicyPushFailure(fn, message) {
  const oldPath = process.env.PATH
  const toolDir = mkdtempSync(join(tmpdir(), 'code-foundry-git-policy-'))
  const script = join(toolDir, 'git')
  const originalGit = spawnSync('sh', ['-lc', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
  writeFileSync(
    script,
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    --force-with-lease=refs/heads/staging:*)
      echo "${message}"
      exit 1
      ;;
  esac
done
exec ${originalGit} "$@"
`,
  )
  chmodSync(script, 0o755)
  process.env.PATH = `${toolDir}:${oldPath}`
  try {
    return fn()
  } finally {
    process.env.PATH = oldPath
    rmSync(toolDir, { recursive: true, force: true })
  }
}

const fakeReconcileGhSource = `#!/usr/bin/env node
'use strict'
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')

const stateFile = process.env.FAKE_GH_STATE
const logFile = process.env.FAKE_GH_LOG
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const args = process.argv.slice(2)
const log = (line) => fs.appendFileSync(logFile, line + '\\n')
const read = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const remoteTip = (branch) => {
  const result = spawnSync('git', ['ls-remote', '--heads', 'origin', 'refs/heads/' + branch], { encoding: 'utf8' })
  if (result.status !== 0) return ''
  const [sha] = result.stdout.trim().split(/\\t/, 1)
  return sha || ''
}

log('gh ' + args.join(' '))

if (args[0] === '--version') {
  process.stdout.write('gh version 2.55.0\\n')
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'list') {
  if (process.env.FAKE_GH_FAIL_LIST) {
    process.stderr.write('gh: pr list failed\\n')
    process.exit(1)
  }
  const head = read('--head')
  const prs = state.prs
    .filter((pr) => !head || pr.headRefName === head)
    .map((pr) => ({ ...pr, headRefOid: remoteTip(pr.headRefName) }))
  process.stdout.write(JSON.stringify(prs))
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'create') {
  if (process.env.FAKE_GH_FAIL_CREATE) {
    process.stderr.write(process.env.FAKE_GH_FAIL_CREATE_MESSAGE || 'gh: pr create failed\\n')
    process.exit(1)
  }
  const head = read('--head')
  const pr = {
    number: state.nextNumber,
    title: read('--title'),
    body: read('--body'),
    headRefName: head,
    baseRefName: read('--base'),
    headRefOid: remoteTip(head),
    url: 'https://github.com/' + process.env.FAKE_GH_REPO + '/pull/' + state.nextNumber,
    state: 'OPEN',
  }
  state.prs.push(pr)
  state.nextNumber += 1
  fs.writeFileSync(stateFile, JSON.stringify(state))
  process.stdout.write(pr.url + '\\n')
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'edit') {
  const pr = state.prs.find((entry) => String(entry.number) === args[2])
  if (pr) {
    pr.body = read('--body')
    fs.writeFileSync(stateFile, JSON.stringify(state))
  }
  process.exit(0)
}
process.stdout.write('{}\\n')
`

/**
 * Run fn with a fake gh CLI that records calls and manages seeded open pull
 * requests, mirroring gh pr list/create/edit behavior for the reconciliation
 * pull request fallback.
 * @param {{ prs?: Array<Record<string, unknown>>, failList?: boolean, failCreate?: boolean, failCreateMessage?: string }} seed
 * @param {Function} fn
 * @returns {{ result: unknown, log: string, state: { prs: Array<Record<string, unknown>>, nextNumber: number } }}
 */
function withReconcileGh(seed, fn) {
  const oldPath = process.env.PATH
  const dir = mkdtempSync(join(tmpdir(), 'code-foundry-gh-reconcile-'))
  const script = join(dir, 'gh')
  const stateFile = join(dir, 'state.json')
  const logFile = join(dir, 'calls.log')
  writeFileSync(stateFile, JSON.stringify({ prs: seed.prs ?? [], nextNumber: seed.nextNumber ?? 42 }))
  writeFileSync(logFile, '')
  writeFileSync(script, fakeReconcileGhSource)
  chmodSync(script, 0o755)
  process.env.FAKE_GH_STATE = stateFile
  process.env.FAKE_GH_LOG = logFile
  process.env.FAKE_GH_REPO = 'owner/repo'
  if (seed.failList) process.env.FAKE_GH_FAIL_LIST = '1'
  if (seed.failCreate) process.env.FAKE_GH_FAIL_CREATE = '1'
  if (seed.failCreateMessage) process.env.FAKE_GH_FAIL_CREATE_MESSAGE = seed.failCreateMessage
  process.env.PATH = `${dir}:${oldPath}`
  try {
    return {
      result: fn(),
      log: readFileSync(logFile, 'utf8'),
      state: JSON.parse(readFileSync(stateFile, 'utf8')),
    }
  } finally {
    process.env.PATH = oldPath
    delete process.env.FAKE_GH_STATE
    delete process.env.FAKE_GH_LOG
    delete process.env.FAKE_GH_REPO
    delete process.env.FAKE_GH_FAIL_LIST
    delete process.env.FAKE_GH_FAIL_CREATE
    delete process.env.FAKE_GH_FAIL_CREATE_MESSAGE
    rmSync(dir, { recursive: true, force: true })
  }
}

function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
}

describe('code-foundry CLI', () => {
  it('prints help without requiring a project or shell tools', () => {
    const result = run('--help')

    assert.equal(result.status, 0)
    assert.match(result.stdout, /code-foundry .* initialize and maintain/)
  })

  it('rejects unknown commands with a useful exit code', () => {
    const result = run('unknown-command')

    assert.equal(result.status, 2)
    assert.match(result.stderr, /unknown command: unknown-command/)
  })

  it('rejects unknown CI billing subcommands', () => {
    const result = run('ci', 'disable')

    assert.equal(result.status, 2)
    assert.match(result.stderr, /use ci pause, ci resume, or ci status/)
  })

  it('removes and restores only the managed CI gate in a ruleset', () => {
    const ruleset = {
      id: 42,
      name: 'code-foundry-main',
      rules: [
        { type: 'deletion' },
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: false,
            do_not_enforce_on_create: false,
            required_status_checks: [
              { context: CI_BILLING_REQUIRED_CHECK, integration_id: 15368 },
              { context: 'Deploy / Preview', integration_id: 15368 },
            ],
          },
        },
        { type: 'non_fast_forward' },
      ],
    }

    const paused = buildPausedRuleset(ruleset)
    assert.deepEqual(
      paused.ruleset.rules.find((rule) => rule.type === 'required_status_checks').parameters.required_status_checks,
      [{ context: 'Deploy / Preview', integration_id: 15368 }],
    )
    assert.deepEqual(paused.backup.checks, [{ context: CI_BILLING_REQUIRED_CHECK, integration_id: 15368 }])
    assert.deepEqual(paused.ruleset.rules.filter((rule) => rule.type !== 'required_status_checks'), [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
    ])

    const resumed = buildResumedRuleset(paused.ruleset, paused.backup)
    assert.equal(resumed.changed, true)
    assert.deepEqual(
      resumed.ruleset.rules.find((rule) => rule.type === 'required_status_checks').parameters.required_status_checks,
      [
        { context: 'Deploy / Preview', integration_id: 15368 },
        { context: CI_BILLING_REQUIRED_CHECK, integration_id: 15368 },
      ],
    )
  })

  it('removes the status-check rule when the managed gate is its only check', () => {
    const ruleset = {
      id: 42,
      name: 'code-foundry-main',
      rules: [
        { type: 'pull_request', parameters: { required_approving_review_count: 0 } },
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: true,
            do_not_enforce_on_create: false,
            required_status_checks: [{ context: CI_BILLING_REQUIRED_CHECK, integration_id: 15368 }],
          },
        },
      ],
    }

    const paused = buildPausedRuleset(ruleset)
    assert.deepEqual(paused.ruleset.rules, [
      { type: 'pull_request', parameters: { required_approving_review_count: 0 } },
    ])
    const resumed = buildResumedRuleset(paused.ruleset, paused.backup)
    assert.deepEqual(resumed.ruleset.rules[1], {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
        required_status_checks: [{ context: CI_BILLING_REQUIRED_CHECK, integration_id: 15368 }],
      },
    })
  })

  it('renders the shared billing guard into every generated workflow job', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-ci-billing-'))
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
    writeFileSync(
      join(root, '.github/code-foundry.yml'),
      'languages: typescript\npackage_manager: bun\nfeatures: all\nopencode_security: true\ngit_workflow: staging-release\nmerge_strategy: rebase\nrelease_merge_strategy: rebase\n',
    )

    syncRepository({ target: root, source: process.cwd() })
    for (const file of ['draft-pr', 'opencode-security', 'release-pr', 'release', 'validation']) {
      const workflow = readFileSync(join(root, `.github/workflows/${file}.yml`), 'utf8')
      const jobs = workflow.slice(workflow.indexOf('\njobs:\n'))
      const jobCount = [...jobs.matchAll(/^  [a-z][a-z0-9-]*:\s*$/gm)].length
      const guardCount = [...jobs.matchAll(/CI_BILLING_PAUSED/g)].length
      assert.ok(jobCount > 0, `${file} has root jobs`)
      assert.ok(guardCount >= jobCount, `${file} guards all ${jobCount} root jobs`)
    }
  })

  it('allows only an explicit manual release to bypass the billing pause', () => {
    const caller = readFileSync('.github/workflows/release_self-ci.yml', 'utf8')
    const release = readFileSync('.github/workflows/release.yml', 'utf8')

    assert.match(caller, /release-while-paused:\n\s+description:/)
    assert.match(caller, /release-while-paused:[\s\S]*?type: boolean[\s\S]*?default: false/)
    assert.match(caller, /if: vars\.CI_BILLING_PAUSED != 'true' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\['release-while-paused'\] == true\)/)
    assert.match(caller, /billing-pause-bypass: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\['release-while-paused'\] == true \}\}/)

    assert.match(release, /billing-pause-bypass:\n\s+description:/)
    assert.match(release, /billing-pause-bypass:[\s\S]*?type: boolean[\s\S]*?default: false/)
    for (const job of ['release', 'reconcile', 'post-release', 'npm']) {
      const block = release.match(new RegExp(`^  ${job}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:|(?![\\s\\S]))`, 'm'))?.[1] ?? ''
      assert.match(block, /vars\.CI_BILLING_PAUSED != 'true' \|\| inputs\['billing-pause-bypass'\] == true/)
    }

    for (const file of ['draft-pr_self-ci.yml', 'opencode-security_self-ci.yml', 'release-pr_self-ci.yml', 'validation_self-ci.yml']) {
      const workflow = readFileSync(`.github/workflows/${file}`, 'utf8')
      assert.doesNotMatch(workflow, /release-while-paused|billing-pause-bypass/)
    }
  })

  it('keeps paid GitHub security features opt-in for private repositories', () => {
    const result = spawnSync(process.execPath, [runtime, 'codeql'], {
      encoding: 'utf8',
      env: { ...testEnv, REPO_FOUNDRY_PRIVATE: 'true' },
    })

    assert.equal(result.status, 0)
    assert.match(result.stdout, /enabled=false/)
    assert.match(result.stdout, /languages=\[\]/)
  })

  it('treats internal repositories like private repositories for auto policies', () => {
    const result = spawnSync(process.execPath, [runtime, 'codeql'], {
      encoding: 'utf8',
      env: { ...testEnv, REPO_FOUNDRY_VISIBILITY: 'internal', REPO_FOUNDRY_PRIVATE: 'false' },
    })

    assert.equal(result.status, 0)
    assert.match(result.stdout, /enabled=false/)
  })

  it('profiles language-specific repositories without scanning dependencies', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-profile-'))
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "fixture"\n')
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    writeFileSync(join(root, 'node_modules/vendor.js'), 'ignored fixture content\n')

    assert.deepEqual(detectLanguages(root), ['rust'])
    assert.equal(resolveProfile(root).package_manager, 'none')
  })

  it('skips root tooling when detected languages only exist in nested source trees', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-nested-source-'))
    mkdirSync(join(root, '.github'), { recursive: true })
    mkdirSync(join(root, 'sdk/typescript'), { recursive: true })
    mkdirSync(join(root, 'scripts'), { recursive: true })
    writeFileSync(join(root, 'sdk/typescript/index.ts'), 'export const value = 1\n')
    writeFileSync(join(root, 'scripts/tool.py'), 'print("tool")\n')
    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript,python\npackage_manager: none\n')

    for (const task of ['format', 'lint', 'type_check', 'build', 'unit', 'integration', 'e2e', 'smoke']) {
      const result = spawnSync(process.execPath, [runtime, 'ci', 'should_run', task], {
        cwd: root,
        encoding: 'utf8',
        env: testEnv,
      })
      assert.equal(result.status, 0, `${task}: ${result.stderr}`)
      assert.match(result.stdout, /applicable=false/)
    }
  })

  it('initializes a language-neutral repository without formatter configs', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-init-'))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/workflows/slither.yml'), 'name: Slither\n')
    syncRepository({ target: root, source: process.cwd(), init: true })

    assert.equal(resolveProfile(root).languages, 'none')
    assert.match(readFileSync(join(root, '.github/code-foundry.yml'), 'utf8'), /toolchain: auto/)
    assert.match(readFileSync(join(root, '.github/code-foundry.yml'), 'utf8'), /codeql_rust_shards: '\["all"\]'/)
    assert.match(readFileSync(join(root, '.github/code-foundry.yml'), 'utf8'), /codeql_rust_threads: 1/)
    assert.match(readFileSync(join(root, '.github/code-foundry.yml'), 'utf8'), /codeql_rust_max_parallel: 1/)
    assert.match(readFileSync(join(root, '.github/code-foundry.yml'), 'utf8'), /post_release_workflow:\n/)
    assert.equal(exists(join(root, 'ruff.toml')), false)
    assert.equal(exists(join(root, '.prettierrc')), false)
    assert.match(readFileSync(join(root, 'LICENSE'), 'utf8'), /GNU GENERAL PUBLIC LICENSE/)
    const validationCaller = readFileSync(join(root, '.github/workflows/validation.yml'), 'utf8')
    assert.match(validationCaller, /code-foundry\/\.github\/workflows\/validation\.yml@v/)
    assert.equal(exists(join(root, '.github/workflows/slither.yml')), true)
    assert.equal(exists(join(root, '.github/workflows/opencode-security.yml')), false)
    for (const legacy of ['ci', 'test', 'security', 'codeql']) {
      assert.equal(exists(join(root, `.github/workflows/${legacy}.yml`)), false, legacy)
    }
    assert.match(validationCaller, /rust-shards: '\["all"\]'/)
    assert.match(validationCaller, /rust-threads: '1'/)
    assert.match(validationCaller, /rust-max-parallel: 1/)
    assert.equal(exists(join(root, 'docs/EXTENSIONS.md')), true)
    doctor(root)
  })

  it('installs the Apache 2.0 license for consumers configured with apache-2.0', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-apache-license-'))
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(
      join(root, '.github/code-foundry.yml'),
      [
        'languages: none',
        'package_manager: none',
        'license: apache-2.0',
        '',
      ].join('\n')
    )

    syncRepository({ target: root, source: process.cwd() })
    const license = readFileSync(join(root, 'LICENSE'), 'utf8')
    assert.match(license, /Apache License/)
    assert.match(license, /Version 2\.0, January 2004/)
    assert.match(license, /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/)
    assert.doesNotMatch(license, /GNU/)
    assert.match(readFileSync(join(root, '.github/code-foundry.yml'), 'utf8'), /license: apache-2\.0/)
  })

  it('rejects unsupported license policies with the supported list', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-license-policy-'))
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(
      join(root, '.github/code-foundry.yml'),
      [
        'languages: none',
        'package_manager: none',
        'license: bsd-3-clause',
        '',
      ].join('\n')
    )

    assert.throws(
      () => syncRepository({ target: root, source: process.cwd() }),
      /Unsupported license: bsd-3-clause; use gpl-3\.0-or-later, agpl-3\.0-or-later, apache-2\.0, mit, preserve, none\./
    )
    // Validation happens before any writes: the config must not gain default
    // additions and no generated baseline files may exist.
    assert.equal(
      readFileSync(join(root, '.github/code-foundry.yml'), 'utf8'),
      'languages: none\npackage_manager: none\nlicense: bsd-3-clause\n'
    )
    assert.deepEqual(readdirSync(root).sort(), ['.github'])
    assert.deepEqual(readdirSync(join(root, '.github')).sort(), ['code-foundry.yml'])
  })

  it('rejects unsafe Rust CodeQL parallelism configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-codeql-config-'))
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(
      join(root, '.github/code-foundry.yml'),
      "languages: rust\npackage_manager: none\ncodeql_rust_shards: '[\"../outside\"]'\n"
    )

    assert.throws(
      () => syncRepository({ target: root, source: process.cwd() }),
      /Invalid Rust CodeQL shard path/
    )
  })

  it('renders bounded Rust CodeQL parallelism from canonical configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-codeql-parallel-'))
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(
      join(root, '.github/code-foundry.yml'),
      [
        'languages: rust',
        'package_manager: none',
        "codeql_rust_shards: '[\"crates/api\",\"crates/worker\"]'",
        'codeql_rust_threads: 4',
        'codeql_rust_max_parallel: 2',
        '',
      ].join('\n')
    )

    syncRepository({ target: root, source: process.cwd() })
    const workflow = readFileSync(join(root, '.github/workflows/validation.yml'), 'utf8')
    assert.match(workflow, /rust-shards: '\["crates\/api","crates\/worker"\]'/)
    assert.match(workflow, /rust-threads: '4'/)
    assert.match(workflow, /rust-max-parallel: 2/)
  })

  it('renders the configured unit runner independently from the test runner', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-unit-runner-'))
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(
      join(root, '.github/code-foundry.yml'),
      [
        'languages: rust',
        'package_manager: none',
        'test_runner: ubuntu-latest',
        'unit_runner: ubuntu-latest',
        '',
      ].join('\n')
    )

    syncRepository({ target: root, source: process.cwd() })
    const workflow = readFileSync(join(root, '.github/workflows/validation.yml'), 'utf8')
    assert.match(workflow, /test-runner: ubuntu-latest/)
    assert.match(workflow, /unit-runner: ubuntu-latest/)
  })

  it('renders the configured default runner for validation mode classification', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-validation-runner-'))
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(
      join(root, '.github/code-foundry.yml'),
      [
        'languages: typescript',
        'package_manager: bun',
        'runner: ubuntu-latest',
        '',
      ].join('\n')
    )

    syncRepository({ target: root, source: process.cwd() })
    const workflow = readFileSync(join(root, '.github/workflows/validation.yml'), 'utf8')
    assert.match(workflow, /^  mode:\n(?:    .*\n)*?    runs-on: ubuntu-latest$/m)
  })

  it('migrates generated legacy callers and preserves custom workflows byte-for-byte', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-migrate-'))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\n')
    for (const stem of ['ci', 'test', 'security', 'codeql']) {
      writeFileSync(join(root, `.github/workflows/${stem}.yml`), legacyCaller(stem))
    }
    const custom = 'name: Deploy\n\non:\n  push:\n    branches: [main]\n\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n'
    writeFileSync(join(root, '.github/workflows/deploy.yml'), custom)

    const result = syncRepository({ target: root, source: process.cwd() })

    for (const stem of ['ci', 'test', 'security', 'codeql']) {
      assert.equal(exists(join(root, `.github/workflows/${stem}.yml`)), false, stem)
    }
    assert.equal(readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8'), custom)
    assert.equal(exists(join(root, '.github/workflows/validation.yml')), true)
    assert.ok(result.changed.includes('.github/workflows/ci.yml'))
    assert.ok(result.changed.includes('.github/workflows/validation.yml'))
    const caller = readFileSync(join(root, '.github/workflows/validation.yml'), 'utf8')
    assert.match(caller, /^\s+ref: v\d+\.\d+\.\d+$/m)
    assert.match(caller, /runtime-ref: v\d+\.\d+\.\d+/)
  })

  it('preserves unrecognized legacy-named callers as repository-owned workflows', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-preserve-'))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\n')
    const custom = 'name: Custom CI\n\non:\n  pull_request:\n\npermissions:\n  contents: read\n\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo custom\n'
    writeFileSync(join(root, '.github/workflows/ci.yml'), custom)

    syncRepository({ target: root, source: process.cwd() })

    assert.equal(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'), custom)
  })

  it('keeps the tiered topology idempotent across repeated syncs', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-idempotent-'))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/workflows/deploy.yml'), 'name: Deploy\n')
    syncRepository({ target: root, source: process.cwd(), init: true })

    const second = syncRepository({ target: root, source: process.cwd() })

    assert.deepEqual(second.changed, [])
    assert.equal(readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8'), 'name: Deploy\n')
  })

  it('keeps repository-owned .prettierignore entries stable across repeated syncs', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-prettierignore-idempotent-'))
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\n')
    writeFileSync(
      join(root, '.prettierignore'),
      ['# Local build output', 'dist/', 'coverage/', ''].join('\n')
    )

    const first = syncRepository({ target: root, source: process.cwd() })
    const merged = readFileSync(join(root, '.prettierignore'), 'utf8')

    assert.ok(first.changed.includes('.prettierignore'))
    assert.match(merged, /^# Generated release metadata is intentionally managed by Release Please\.\nCHANGELOG\.md/m)
    assert.match(merged, /^\.github\/\.code-foundry$/m)
    assert.equal((merged.match(/# Repository-specific rules/g) ?? []).length, 1)
    assert.match(merged, /# Repository-specific rules\n# Local build output\ndist\/\ncoverage\/$/m)

    const second = syncRepository({ target: root, source: process.cwd() })
    const afterSecond = readFileSync(join(root, '.prettierignore'), 'utf8')

    assert.ok(!second.changed.includes('.prettierignore'), second.changed.join(', '))
    assert.equal(afterSecond, merged)
    assert.equal((afterSecond.match(/# Repository-specific rules/g) ?? []).length, 1)
  })

  it('previews legacy caller removal in dry-run without writing files', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-dryrun-'))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\n')
    writeFileSync(join(root, '.github/workflows/ci.yml'), legacyCaller('ci'))

    const preview = syncRepository({ target: root, source: process.cwd(), dryRun: true })

    assert.ok(preview.changed.includes('.github/workflows/ci.yml'))
    assert.equal(exists(join(root, '.github/workflows/ci.yml')), true)
    assert.equal(exists(join(root, '.github/workflows/validation.yml')), false)
    const real = syncRepository({ target: root, source: process.cwd() })
    assert.equal(exists(join(root, '.github/workflows/ci.yml')), false)
    assert.equal(exists(join(root, '.github/workflows/validation.yml')), true)
    assert.ok(real.changed.includes('.github/workflows/validation.yml'))
  })

  it('doctor flags stale legacy callers and unpinned or mismatched runtime refs', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-doctor-validation-'))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\n')
    syncRepository({ target: root, source: process.cwd() })
    const callerPath = join(root, '.github/workflows/validation.yml')
    const captureWarnings = (fn) => {
      /** @type {string[]} */
      const warnings = []
      const original = console.warn
      console.warn = (message) => warnings.push(String(message))
      try { fn() } finally { console.warn = original }
      return warnings
    }
    const captureErrors = (fn) => {
      /** @type {string[]} */
      const errors = []
      const original = console.error
      console.error = (message) => errors.push(String(message))
      try { fn() } catch { /* doctor throws only a summary; details are in errors */ } finally { console.error = original }
      return errors
    }
    writeFileSync(join(root, '.github/workflows/ci.yml'), legacyCaller('ci'))
    const stale = captureWarnings(() => doctor(root))
    assert.ok(stale.some((message) => /stale generated legacy caller ci\.yml/.test(message)), stale.join('\n'))

    const mismatched = readFileSync(callerPath, 'utf8').replace(/^(\s+)ref: v\d+\.\d+\.\d+$/m, '$1ref: v0.31.0')
    writeFileSync(callerPath, mismatched)
    const mismatchErrors = captureErrors(() => doctor(root))
    assert.ok(mismatchErrors.some((message) => /mismatched runtime refs/.test(message)), mismatchErrors.join('\n'))

    const unpinned = readFileSync(callerPath, 'utf8')
      .replace(/runtime-ref: v\d+\.\d+\.\d+/, 'runtime-ref: main')
      .replace(/^(\s+)ref: v\d+\.\d+\.\d+$/m, '$1ref: main')
    writeFileSync(callerPath, unpinned)
    const warning = captureWarnings(() => doctor(root))
    assert.ok(warning.some((message) => /not a released tag/.test(message)), warning.join('\n'))
  })

  it('reports both CODE_FOUNDRY_TOKEN and RELEASE_PLEASE_TOKEN states in the github doctor', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-doctor-tokens-'))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })

    const both = withFakeGh(['CODE_FOUNDRY_TOKEN', 'RELEASE_PLEASE_TOKEN'], () =>
      withGitHubEnv({ GITHUB_REPOSITORY: 'owner/repo' }, () => doctorGithub(root))
    )
    assert.equal(both.details.secrets.codeFoundryTokenPresent, true)
    assert.equal(both.details.secrets.releasePleaseTokenPresent, true)
    assert.equal(both.details.secrets.stagingDeployKeyPresent, false)

    for (const token of ['CODE_FOUNDRY_TOKEN', 'RELEASE_PLEASE_TOKEN']) {
      const one = withFakeGh([token], () =>
        withGitHubEnv({ GITHUB_REPOSITORY: 'owner/repo' }, () => doctorGithub(root))
      )
      assert.doesNotMatch(one.warnings.join(' '), /are both absent/i)
    }

    const neither = withFakeGh([], () =>
      withGitHubEnv({ GITHUB_REPOSITORY: 'owner/repo' }, () => doctorGithub(root))
    )
    const messages = neither.warnings.join(' ')
    assert.equal(neither.details.secrets.codeFoundryTokenPresent, false)
    assert.equal(neither.details.secrets.releasePleaseTokenPresent, false)
    assert.equal(neither.details.secrets.stagingDeployKeyPresent, false)
    assert.match(messages, /are both absent/i)
    assert.match(messages, /CODE_FOUNDRY_TOKEN.*RELEASE_PLEASE_TOKEN/)

    const keyOnly = withFakeGh(['STAGING_DEPLOY_KEY'], () =>
      withGitHubEnv({ GITHUB_REPOSITORY: 'owner/repo' }, () => doctorGithub(root))
    )
    assert.equal(keyOnly.details.secrets.codeFoundryTokenPresent, false)
    assert.equal(keyOnly.details.secrets.releasePleaseTokenPresent, false)
    assert.equal(keyOnly.details.secrets.stagingDeployKeyPresent, true)

    rmSync(root, { recursive: true, force: true })
  })
  it('passes dedicated token secrets to PR creation reusable workflows', () => {
    const draftCallee = readFileSync('.github/workflows/draft-pr.yml', 'utf8')
    assert.match(draftCallee, /CODE_FOUNDRY_TOKEN:\n\s+required: false/)
    assert.match(draftCallee, /RELEASE_PLEASE_TOKEN:\n\s+required: false/)
    assert.match(draftCallee, /GH_TOKEN: \$\{\{ github\.token \}\}/)
    assert.match(draftCallee, /AUTOMATION_TOKEN: \$\{\{ secrets\.CODE_FOUNDRY_TOKEN \|\| secrets\.RELEASE_PLEASE_TOKEN \}\}/)
    assert.match(draftCallee, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/)
    assert.match(draftCallee, /CREATE_ARGS=\(/)
    assert.match(draftCallee, /DRAFT_ARGS=\("\$\{CREATE_ARGS\[@\]\}" --field draft=true\)/)
    assert.doesNotMatch(draftCallee, /gh pr create/)

    const draftCaller = readFileSync('.github/workflows/draft-pr_self-ci.yml', 'utf8')
    assert.match(draftCaller, /secrets:\n\s+CODE_FOUNDRY_TOKEN: \$\{\{ secrets\.CODE_FOUNDRY_TOKEN \}\}/)
    assert.match(draftCaller, /secrets:\n\s+CODE_FOUNDRY_TOKEN: \$\{\{ secrets\.CODE_FOUNDRY_TOKEN \}\}\n\s+RELEASE_PLEASE_TOKEN: \$\{\{ secrets\.RELEASE_PLEASE_TOKEN \}\}/)

    const releaseCaller = readFileSync('.github/workflows/release-pr_self-ci.yml', 'utf8')
    assert.match(releaseCaller, /on:\n\s+push:\n\s+branches: \[staging\]/)
    assert.match(releaseCaller, /secrets:\n\s+CODE_FOUNDRY_TOKEN: \$\{\{ secrets\.CODE_FOUNDRY_TOKEN \}\}/)
    assert.match(releaseCaller, /RELEASE_PLEASE_TOKEN: \$\{\{ secrets\.RELEASE_PLEASE_TOKEN \}\}/)

    const releaseMainCaller = readFileSync('.github/workflows/release_self-ci.yml', 'utf8')
    assert.match(releaseMainCaller, /STAGING_DEPLOY_KEY: \$\{\{ secrets\.STAGING_DEPLOY_KEY \}\}/)

    const validationCaller = readFileSync('.github/workflows/validation_self-ci.yml', 'utf8')
    assert.match(validationCaller, /types:\n\s+- opened\n\s+- synchronize\n\s+- reopened\n\s+- ready_for_review/)
  })
  it('creates draft PRs through REST and falls back from rejected automation tokens', () => {
    const workflow = readFileSync('.github/workflows/draft-pr.yml', 'utf8')
    const stepSlice = (name) => {
      const start = workflow.indexOf(`- name: ${name}\n`)
      assert.ok(start !== -1, `workflow has a ${name} step`)
      const next = workflow.indexOf('- name: ', start + 1)
      return next === -1 ? workflow.slice(start) : workflow.slice(start, next)
    }

    const checkStep = stepSlice('Check')
    assert.match(checkStep, /GH_TOKEN: \$\{\{ github\.token \}\}/)
    assert.doesNotMatch(checkStep, /CODE_FOUNDRY_TOKEN|RELEASE_PLEASE_TOKEN/)

    const createStep = stepSlice('Create')
    assert.match(createStep, /AUTOMATION_TOKEN: \$\{\{ secrets\.CODE_FOUNDRY_TOKEN \|\| secrets\.RELEASE_PLEASE_TOKEN \}\}/)
    assert.match(createStep, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/)
    assert.match(createStep, /"repos\/\$\{GITHUB_REPOSITORY\}\/pulls"/)
    assert.match(createStep, /--method POST/)
    assert.match(createStep, /--field base="\$\{\{\s*inputs\.base\s*\}\}"/)
    assert.match(createStep, /--field head="\$BRANCH"/)
    assert.match(createStep, /--field title="\$PR_TITLE"/)
    assert.match(createStep, /--field body="@\$BODY_FILE"/)
    assert.match(createStep, /GH_TOKEN="\$AUTOMATION_TOKEN" gh api "\$\{CREATE_ARGS\[@\]\}"/)
    assert.match(createStep, /DRAFT_ARGS=\("\$\{CREATE_ARGS\[@\]\}" --field draft=true\)/)
    assert.match(createStep, /GH_TOKEN="\$GITHUB_TOKEN" gh api "\$\{DRAFT_ARGS\[@\]\}"/)
    assert.match(createStep, /Manual PR readiness required/)
    assert.doesNotMatch(createStep, /echo "\$AUTOMATION_TOKEN"|printenv|GITHUB_OUTPUT/)
    assert.doesNotMatch(workflow, /gh pr create/)
  })
  it('fails closed on a non-rebase release merge strategy and never uses --admin', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8')

    assert.match(workflow, /if \(!releaseConfig\.packages && !releaseConfig\['release-type'\]\)/)
    assert.match(workflow, /legacyReleaseType = releaseType/)
    assert.match(workflow, /else if \(!fs\.existsSync\('\.release-please-manifest\.json'\)\)/)
    assert.match(workflow, /run code-foundry sync to bootstrap the release manifest/)
    assert.match(workflow, /config-file: release-please-config\.json/)
    assert.match(workflow, /release-type: \$\{\{ steps\.profile\.outputs\.legacy_release_type \}\}/)
    assert.match(workflow, /release validate-prs/)
    assert.doesNotMatch(workflow, /--admin/)
    assert.match(workflow, /release_merge_strategy must be "rebase"/)
    assert.match(workflow, /release automation never defaults to merge/)
    assert.doesNotMatch(workflow, /release_merge_strategy \|\| config\.merge_strategy/)
    assert.doesNotMatch(workflow, /\|\| 'merge'/)
    assert.match(workflow, /release_merge_strategy=\$\{releaseMergeStrategy\}/)
    assert.match(workflow, /\$\{\{\s*steps\.profile\.outputs\.release_merge_strategy\s*\}\}/)
    assert.match(workflow, /release_head=\$\(gh pr view \"\$pr\"[\s\S]*--json headRefOid[\s\S]*--jq '\.headRefOid'\)/)
    assert.match(workflow, /--match-head-commit \"\$release_head\"/)
    assert.match(workflow, /if \[ -z \"\$release_head\" \]/)
    assert.match(workflow, /name: Reconcile\n\s+needs: release\n\s+# A normal promotion push can successfully run Release Please without/)
    assert.match(workflow, /if: \(vars\.CI_BILLING_PAUSED != 'true' \|\| inputs\['billing-pause-bypass'\] == true\) && needs\.release\.result == 'success' && needs\.release\.outputs\.release_created == 'true'/)
    assert.match(workflow, /name: Reconcile[\s\S]*?GH_TOKEN: \$\{\{ github\.token \}\}/)
  })

  it('uses GitHub merge state as the guarded release required-check gate', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8')

    // GitHub's merge state includes branch-policy evaluation. The workflow
    // must use it directly because gh pr checks --required can return an empty
    // result for ruleset-backed required contexts in private repositories.
    assert.match(workflow, /Waiting for release PR #\$pr to become mergeable under branch policy/)
    assert.match(workflow, /--json mergeStateStatus,mergeable/)
    assert.match(workflow, /'\[\.mergeStateStatus, \.mergeable\] \| @tsv'/)
    assert.doesNotMatch(workflow, /gh pr checks "\$pr"[\s\S]*--required/)
    assert.match(workflow, /authoritative required-check gate/)
    assert.match(workflow, /case "\$merge_state" in/)
    assert.match(workflow, /CLEAN\|UNSTABLE\)\n\s+if \[ "\$mergeable" = MERGEABLE \]; then\n\s+break/)
    assert.match(workflow, /DIRTY\)\n\s+echo "Release PR #\$pr is not mergeable \(mergeStateStatus=\$merge_state\)/)
    assert.match(workflow, /\[ "\$mergeable" = CONFLICTING \]/)
    assert.match(workflow, /resolve conflicts before retrying the release/)
    assert.match(workflow, /merge_state=UNKNOWN\n\s+mergeable=UNKNOWN/)

    // Non-required checks do not block the merge: UNSTABLE with mergeable
    // MERGEABLE is accepted immediately, while BLOCKED, BEHIND, and UNKNOWN
    // keep the guard polling.
    assert.match(workflow, /\{ \[ "\$merge_state" != CLEAN \] && \[ "\$merge_state" != UNSTABLE \]; \} \|\| \[ "\$mergeable" != MERGEABLE \]/)

    // The guard must be bounded: 30 attempts at a 10 second interval, and a
    // useful fail-closed error when the PR never reaches an accepted state.
    // Transient gh failures reset the state to UNKNOWN instead of dropping it
    // to empty.
    assert.match(workflow, /for attempt in \$\(seq 1 30\)/)
    assert.match(workflow, /sleep 10/)
    assert.match(workflow, /did not become mergeable within the mergeability window \(last mergeStateStatus=\$merge_state, mergeable=\$mergeable\)/)
    assert.match(workflow, /Required checks may still be pending or branch policy blocks the merge/)
    assert.match(workflow, /treat the state as unknown and keep polling/)

    // The guard runs before the merge, which still keeps match-head SHA
    // protection and delete-branch, and never falls back to --admin.
    const guardIndex = workflow.indexOf('--json mergeStateStatus,mergeable')
    const timeoutIndex = workflow.indexOf('did not become mergeable within the mergeability window')
    const mergeIndex = workflow.indexOf('gh pr merge "$pr"')
    assert.ok(guardIndex !== -1 && timeoutIndex !== -1 && mergeIndex !== -1)
    assert.ok(guardIndex < timeoutIndex && timeoutIndex < mergeIndex)
    assert.match(workflow, /gh pr merge "\$pr"[\s\S]*--match-head-commit "\$release_head"[\s\S]*--delete-branch/)
    assert.doesNotMatch(workflow, /--admin/)
  })

  it('doctor and sync reject merge strategies outside the audit topology', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-merge-policy-'))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    const captureErrors = (fn) => {
      /** @type {string[]} */
      const errors = []
      const original = console.error
      console.error = (message) => errors.push(String(message))
      try { fn() } catch { /* doctor throws only a summary; details are in errors */ } finally { console.error = original }
      return errors
    }

    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\ngit_workflow: staging-release\nmerge_strategy: rebase\nrelease_merge_strategy: rebase\n')
    syncRepository({ target: root, source: process.cwd() })
    assert.doesNotThrow(() => doctor(root))

    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\ngit_workflow: staging-release\nmerge_strategy: merge\nrelease_merge_strategy: merge\n')
    const promotion = captureErrors(() => doctor(root))
    assert.ok(promotion.some((message) => /merge_strategy must be "rebase"/.test(message)), promotion.join('\n'))
    assert.ok(promotion.some((message) => /release_merge_strategy must be "rebase"/.test(message)), promotion.join('\n'))
    assert.throws(() => syncRepository({ target: root, source: process.cwd() }), /Unsupported merge_strategy: merge/)

    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\ngit_workflow: staging-release\nmerge_strategy: rebase\nrelease_merge_strategy: squash\n')
    const release = captureErrors(() => doctor(root))
    assert.ok(release.some((message) => /release_merge_strategy must be "rebase"/.test(message)), release.join('\n'))
    assert.throws(() => syncRepository({ target: root, source: process.cwd() }), /Unsupported release_merge_strategy: squash/)

    // Release automation is the only consumer of release_merge_strategy;
    // a profile without the release feature never needs the key. merge_strategy
    // is likewise only enforced by the staging-release topology: a direct
    // repository may carry any value (or none) because no promotion exists.
    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\nfeatures: ci,test\ngit_workflow: staging-release\nmerge_strategy: rebase\n')
    assert.doesNotThrow(() => syncRepository({ target: root, source: process.cwd() }))

    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\nmerge_strategy: merge\n')
    assert.doesNotThrow(() => syncRepository({ target: root, source: process.cwd() }))
    assert.doesNotThrow(() => doctor(root))
    rmSync(root, { recursive: true, force: true })
  })

  it('renders the direct topology by default and drops every staging reference', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-direct-'))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    // No existing config: sync with init writes the fully resolved default.
    syncRepository({ target: root, source: process.cwd(), init: true })

    const config = readFileSync(join(root, '.github/code-foundry.yml'), 'utf8')
    assert.match(config, /^git_workflow: direct$/m)

    const validation = readFileSync(join(root, '.github/workflows/validation.yml'), 'utf8')
    assert.match(validation, /branches: \[main\]/)
    assert.doesNotMatch(validation, /staging/)

    const draft = readFileSync(join(root, '.github/workflows/draft-pr.yml'), 'utf8')
    assert.match(draft, /base: main/)
    assert.doesNotMatch(draft, /base: staging/)

    const dependabot = readFileSync(join(root, '.github/dependabot.yml'), 'utf8')
    assert.match(dependabot, /target-branch: main/)
    assert.doesNotMatch(dependabot, /target-branch: staging/)
    assert.doesNotMatch(dependabot, /package-ecosystem: cargo/)

    // No promotion caller and no promotion prose in the direct topology.
    assert.ok(!existsSync(join(root, '.github/workflows/release-pr.yml')), 'direct sync must not emit release-pr.yml')
    const contributing = readFileSync(join(root, '.github/CONTRIBUTING.md'), 'utf8')
    assert.match(contributing, /Branch from `main` and target pull requests at `main`/)
    assert.doesNotMatch(contributing, /Branch from `staging`/)
    assert.doesNotMatch(contributing, /target normal pull requests here/)
    assert.doesNotMatch(contributing, /staging` → `main` release PR/)
    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    assert.match(agents, /branch from `main` and target pull requests at `main`/)
    assert.doesNotMatch(agents, /staging/)
    const security = readFileSync(join(root, '.github/SECURITY.md'), 'utf8')
    assert.match(security, /The latest commit on `main` receives security patches/)
    assert.doesNotMatch(security, /staging/)

    // Idempotent: a second sync must not churn the direct flavor.
    const second = syncRepository({ target: root, source: process.cwd() })
    assert.deepEqual(second.changed, [])
    rmSync(root, { recursive: true, force: true })
  })

  it('renders prettier-canonical CONTRIBUTING.md tables for both topologies', () => {
    // Regression: the runtime template and every DIRECT_DOC_REPLACEMENTS
    // variant must render tables prettier@3.9.6-canonical, otherwise the
    // fleet Format check fails on the synced document.
    const content = readFileSync(join(process.cwd(), '.github/CONTRIBUTING.md'), 'utf8')
    for (const wf of ['staging-release', 'direct']) {
      const root = mkdtempSync(join(tmpdir(), 'code-foundry-canon-'))
      mkdirSync(join(root, '.github/workflows'), { recursive: true })
      writeFileSync(join(root, '.github/code-foundry.yml'), `languages: typescript\npackage_manager: bun\ngit_workflow: ${wf}\n`)
      syncRepository({ target: root, source: process.cwd() })
      const rendered = readFileSync(join(root, '.github/CONTRIBUTING.md'), 'utf8')
      // The replacement must actually fire: staging keeps the staging row,
      // direct drops it.
      assert.strictEqual(rendered.includes('Pull request targeting `staging`'), wf === 'staging-release')
      assert.strictEqual(rendered.includes('Working branch               | `staging`') || rendered.includes('Working branch | `staging`'), wf === 'staging-release')
      // No unpadded separator line may survive: prettier pads markdown tables.
      assert.doesNotMatch(rendered, /\| --- \|/)
      // Idempotent sync must not churn the canonical document.
      const second = syncRepository({ target: root, source: process.cwd() })
      assert.deepEqual(second.changed, [])
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('renders the staging-release topology when configured', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-staging-'))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\ngit_workflow: staging-release\n')
    syncRepository({ target: root, source: process.cwd() })

    const validation = readFileSync(join(root, '.github/workflows/validation.yml'), 'utf8')
    assert.match(validation, /branches: \[main, staging\]/)

    const draft = readFileSync(join(root, '.github/workflows/draft-pr.yml'), 'utf8')
    assert.match(draft, /base: staging/)

    const dependabot = readFileSync(join(root, '.github/dependabot.yml'), 'utf8')
    assert.match(dependabot, /target-branch: staging/)
    assert.doesNotMatch(dependabot, /package-ecosystem: cargo/)

    // The promotion caller and staging contribution policy are kept.
    assert.ok(existsSync(join(root, '.github/workflows/release-pr.yml')), 'staging-release sync must emit release-pr.yml')
    const contributing = readFileSync(join(root, '.github/CONTRIBUTING.md'), 'utf8')
    assert.match(contributing, /Branch from `staging` and target pull requests at `staging`/)
    rmSync(root, { recursive: true, force: true })
  })

  it('renders Cargo Dependabot updates only for Rust repositories', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-rust-dependabot-'))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: rust\npackage_manager: none\n')
    syncRepository({ target: root, source: process.cwd() })

    const dependabot = readFileSync(join(root, '.github/dependabot.yml'), 'utf8')
    assert.match(dependabot, /package-ecosystem: cargo/)
    rmSync(root, { recursive: true, force: true })
  })

  it('rejects an unknown git_workflow and prunes a stale promotion caller on flip to direct', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-gitflow-'))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\ngit_workflow: nonsense\n')
    assert.throws(() => syncRepository({ target: root, source: process.cwd() }), /Unsupported git_workflow: nonsense/)

    // A repository that already carries a generated promotion caller flips to
    // direct: sync must remove the caller so it cannot linger dormant.
    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\n')
    writeFileSync(join(root, '.github/workflows/release-pr.yml'), 'name: Code Foundry\non:\n  push:\n    branches: [staging]\npermissions:\n  contents: write\njobs:\n  release-pr:\n    name: Release PR\n    uses: 0xPlayerOne/code-foundry/.github/workflows/release-pr.yml@v1.2.3\n    with:\n      runtime-repository: 0xPlayerOne/code-foundry\n      runtime-ref: v1.2.3\n    secrets:\n      CODE_FOUNDRY_TOKEN: ${{ secrets.CODE_FOUNDRY_TOKEN }}\n')
    syncRepository({ target: root, source: process.cwd() })
    assert.ok(!existsSync(join(root, '.github/workflows/release-pr.yml')), 'direct sync must prune a stale generated promotion caller')
    rmSync(root, { recursive: true, force: true })
  })

  it('documents that GitHub Stacks is outside the merge topology', () => {
    const workflows = readFileSync('docs/WORKFLOWS.md', 'utf8')
    assert.match(workflows, /GitHub Stacks/)
    assert.match(workflows, /does\s+not reduce required workflow runs/)
    assert.match(workflows, /not part of this topology/)
  })

  it('normalizes generated release PR state when draft permissions are unavailable', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8')

    assert.match(workflow, /name: Detect release credentials/)
    assert.match(workflow, /auto_merge=false/)
    assert.match(workflow, /name: Normalize generated release PR draft state/)
    assert.match(workflow, /gh pr ready --undo/)
    assert.match(workflow, /No valid automation token is available \(absent or rejected by GitHub\)/)
    assert.match(workflow, /name: Leave release pull request for manual merge/)
    assert.match(workflow, /steps\.credentials\.outputs\.auto_merge != 'true'/)
    assert.match(workflow, /steps\.credentials\.outputs\.auto_merge == 'true'/)
    assert.match(workflow, /RELEASE_PLEASE_TOKEN: \$\{\{ needs\.release\.outputs\.token_source == 'configured' && \(secrets\.CODE_FOUNDRY_TOKEN \|\| secrets\.RELEASE_PLEASE_TOKEN\) \|\| github\.token \}\}/)
    assert.match(workflow, /GH_TOKEN: \$\{\{ needs\.release\.outputs\.token_source == 'configured' && \(secrets\.CODE_FOUNDRY_TOKEN \|\| secrets\.RELEASE_PLEASE_TOKEN\) \|\| github\.token \}\}/)
  })
  it('validates release automation credentials and fails over to the workflow token', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8')
    const stepSlice = (name) => {
      const start = workflow.indexOf(`- name: ${name}\n`)
      assert.ok(start !== -1, `workflow has a ${name} step`)
      const next = workflow.indexOf('- name: ', start + 1)
      return next === -1 ? workflow.slice(start) : workflow.slice(start, next)
    }

    // The configured automation token is validated with authenticated REST
    // against the current repository (NiftyLeague rejects long-lived
    // fine-grained tokens with HTTP 403 even on REST, so the gh api probe is
    // the single source of truth for the credential selection). The response
    // body is discarded and only the exit status selects the credential.
    const credentialsStep = stepSlice('Detect release credentials')
    assert.match(credentialsStep, /GH_TOKEN: \$\{\{ secrets\.CODE_FOUNDRY_TOKEN \|\| secrets\.RELEASE_PLEASE_TOKEN \}\}/)
    assert.match(credentialsStep, /if \[ "\$HAS_AUTOMATION_TOKEN" = true \] && gh api "repos\/\$\{GITHUB_REPOSITORY\}" --jq '\.full_name' >\/dev\/null 2>&1/)
    assert.match(credentialsStep, /token_source=configured/)
    assert.match(credentialsStep, /token_source=fallback/)
    assert.match(credentialsStep, /::warning title=Release token fallback::/)

    // auto_merge stays true only in the branch where the configured token was
    // validated; any absence or rejection selects the short-lived workflow
    // token and leaves the release PR for manual merge.
    const ghProbe = credentialsStep.indexOf('gh api')
    const autoMergeTrue = credentialsStep.indexOf('echo "auto_merge=true"')
    const configured = credentialsStep.indexOf('token_source=configured')
    const fallback = credentialsStep.indexOf('token_source=fallback')
    const autoMergeFalse = credentialsStep.indexOf('echo "auto_merge=false"')
    assert.ok(ghProbe !== -1 && autoMergeTrue !== -1 && configured !== -1 && fallback !== -1 && autoMergeFalse !== -1)
    assert.ok(ghProbe < autoMergeTrue && autoMergeTrue < configured, 'auto_merge=true must follow a successful gh api validation')
    assert.ok(autoMergeFalse < fallback, 'fallback selection must follow auto_merge=false')

    // The token value must never be echoed, exported to outputs, or otherwise
    // logged: the step env carries the (masked) secret, the run block only
    // lets gh read it from the environment.
    const credentialsRun = credentialsStep.slice(credentialsStep.indexOf('run: |'))
    assert.doesNotMatch(credentialsRun, /(?:\$|\$\{)GH_TOKEN/)
    assert.doesNotMatch(credentialsRun, /printenv/)
    assert.doesNotMatch(credentialsRun, /GH_TOKEN[^\n]*GITHUB_OUTPUT/)

    // Two mutually-exclusive Release Please steps: the configured secret only
    // when it validated, github.token otherwise. Action inputs cannot carry a
    // shell-selected secret, so the selection happens in the if conditions.
    const automationStep = stepSlice('Release Please (automation token)')
    assert.match(automationStep, /id: release_automation/)
    assert.match(automationStep, /if: steps\.profile\.outputs\.release_type != 'none' && steps\.credentials\.outputs\.token_source == 'configured'/)
    assert.match(automationStep, /token: \$\{\{ secrets\.CODE_FOUNDRY_TOKEN \|\| secrets\.RELEASE_PLEASE_TOKEN \}\}/)
    assert.match(automationStep, /config-file: release-please-config\.json/)
    assert.match(automationStep, /release-type: \$\{\{ steps\.profile\.outputs\.legacy_release_type \}\}/)
    assert.doesNotMatch(automationStep, /github\.token/)

    const workflowStep = stepSlice('Release Please (workflow token)')
    assert.match(workflowStep, /id: release_workflow/)
    assert.match(workflowStep, /if: steps\.profile\.outputs\.release_type != 'none' && steps\.credentials\.outputs\.token_source != 'configured'/)
    assert.match(workflowStep, /token: \$\{\{ github\.token \}\}/)
    assert.match(workflowStep, /config-file: release-please-config\.json/)
    assert.doesNotMatch(workflowStep, /CODE_FOUNDRY_TOKEN|RELEASE_PLEASE_TOKEN/)
    assert.doesNotMatch(workflow, /token: \$\{\{ secrets\.CODE_FOUNDRY_TOKEN \|\| secrets\.RELEASE_PLEASE_TOKEN \|\| github\.token \}\}/)

    // The normalize step keeps the stable release id so job outputs and
    // downstream jobs keep reading steps.release.outputs.* unchanged, and it
    // forwards release_created, tag_name, and prs_created from whichever of
    // the two action steps ran.
    const normalizeStep = stepSlice('Normalize Release Please outputs')
    assert.match(normalizeStep, /id: release/)
    for (const [source, prefix] of [['release_automation', 'AUTOMATION'], ['release_workflow', 'WORKFLOW']]) {
      assert.match(normalizeStep, new RegExp(`${prefix}_RELEASE_CREATED: \\$\\{\\{ steps\\.${source}\\.outputs\\.release_created \\}\\}`))
      assert.match(normalizeStep, new RegExp(`${prefix}_TAG_NAME: \\$\\{\\{ steps\\.${source}\\.outputs\\.tag_name \\}\\}`))
      assert.match(normalizeStep, new RegExp(`${prefix}_PRS_CREATED: \\$\\{\\{ steps\\.${source}\\.outputs\\.prs_created \\}\\}`))
      assert.match(normalizeStep, new RegExp(`release_created=\\$${prefix}_RELEASE_CREATED`))
      assert.match(normalizeStep, new RegExp(`tag_name=\\$${prefix}_TAG_NAME`))
      assert.match(normalizeStep, new RegExp(`prs_created=\\$${prefix}_PRS_CREATED`))
    }
    assert.match(workflow, /release_created: \$\{\{ steps\.release\.outputs\.release_created \|\| 'false' \}\}/)
    assert.match(workflow, /tag_name: \$\{\{ steps\.release\.outputs\.tag_name \}\}/)
    assert.match(workflow, /token_source: \$\{\{ steps\.credentials\.outputs\.token_source \}\}/)

    // The same selected credential backs every shell step that lists, readies,
    // edits, validates, and merges generated release PRs: the draft-state step
    // and the merge step must use the identical selection expression, and the
    // post-release job must reuse the release job's token_source output.
    const selected = /steps\.credentials\.outputs\.token_source == 'configured' && \(secrets\.CODE_FOUNDRY_TOKEN \|\| secrets\.RELEASE_PLEASE_TOKEN\) \|\| github\.token/
    const draftStep = stepSlice('Normalize generated release PR draft state')
    const mergeStep = stepSlice('Merge generated version pull requests')
    assert.match(draftStep, new RegExp(`GH_TOKEN: \\$\\{\\{ ${selected.source} \\}\\}`))
    assert.match(mergeStep, new RegExp(`GH_TOKEN: \\$\\{\\{ ${selected.source} \\}\\}`))
    const draftLine = draftStep.split('\n').find((line) => line.includes('GH_TOKEN:'))
    const mergeLine = mergeStep.split('\n').find((line) => line.includes('GH_TOKEN:'))
    assert.equal(draftLine, mergeLine, 'draft and merge steps must use the same selected credential')
    assert.match(draftStep, /AUTO_MERGE: \$\{\{ steps\.credentials\.outputs\.auto_merge \}\}/)
    assert.match(draftStep, /if \[ "\$AUTO_MERGE" = true \]/)
    assert.doesNotMatch(workflow, /GH_TOKEN: \$\{\{ secrets\.CODE_FOUNDRY_TOKEN \|\| secrets\.RELEASE_PLEASE_TOKEN \|\| github\.token \}\}/)

    const postReleaseEnv = workflow.slice(workflow.indexOf('post-release:\n'))
    assert.match(postReleaseEnv, /RELEASE_PLEASE_TOKEN: \$\{\{ needs\.release\.outputs\.token_source == 'configured' && \(secrets\.CODE_FOUNDRY_TOKEN \|\| secrets\.RELEASE_PLEASE_TOKEN\) \|\| github\.token \}\}/)
    assert.match(postReleaseEnv, /GH_TOKEN: \$\{\{ needs\.release\.outputs\.token_source == 'configured' && \(secrets\.CODE_FOUNDRY_TOKEN \|\| secrets\.RELEASE_PLEASE_TOKEN\) \|\| github\.token \}\}/)
  })
  it('allows only release metadata during post-release reconciliation', () => {
    const allowed = approvedReleaseFiles({
      'extra-files': ['version.txt'],
      packages: { web: { 'extra-files': ['src/version.ts'] } },
    })
    assert.deepEqual(
      classifyReconciliation({
        mainSha: 'main',
        stagingSha: 'staging',
        mainOnlyCommits: [{ sha: 'r1', changedPaths: ['CHANGELOG.md', 'package.json'] }],
        stagingOnlyCommits: [],
        allowed,
      }),
      { action: 'fast-forward', targetSha: 'main', reason: 'main only added approved release metadata.' },
    )
    assert.equal(
      classifyReconciliation({
        mainSha: 'main',
        stagingSha: 'staging',
        mainOnlyCommits: [{ sha: 'r1', changedPaths: ['src/index.ts'] }],
        stagingOnlyCommits: [],
        allowed,
      }).action,
      'fail',
    )
    assert.deepEqual(
      classifyReconciliation({
        mainSha: 'main',
        stagingSha: 'staging',
        mainOnlyCommits: [],
        stagingOnlyCommits: [],
        allowed,
      }),
      { action: 'aligned', targetSha: 'main', reason: 'Branches have different history but identical content.' },
    )
  })

  it('classifies historical workflow commits by their final tree delta', () => {
    assert.deepEqual(
      classifyReconciliation({
        mainSha: 'main',
        stagingSha: 'staging',
        directChangedPaths: ['CHANGELOG.md', 'Cargo.toml', 'Cargo.lock'],
        mainOnlyCommits: [{ sha: 'workflow-main', changedPaths: ['.github/workflows/release.yml'] }],
        stagingOnlyCommits: [{ sha: 'workflow-staging', changedPaths: ['.github/workflows/release.yml'] }],
        allowed: approvedReleaseFiles(),
      }),
      { action: 'fast-forward', targetSha: 'main', reason: 'Branches differ only by approved release metadata.' },
    )
  })

  it('synchronizes validated main changes when staging has no unpromoted work', () => {
    assert.deepEqual(
      classifyReconciliation({
        mainSha: 'main',
        stagingSha: 'staging',
        directChangedPaths: ['CHANGELOG.md', 'src/index.ts'],
        mainOnlyCommits: [{ sha: 'main-code', changedPaths: ['src/index.ts'] }],
        stagingOnlyCommits: [],
        allowed: approvedReleaseFiles(),
      }),
      {
        action: 'fast-forward',
        targetSha: 'main',
        reason: 'main contains validated changes that staging must inherit.',
      },
    )
  })

  it('recommends replaying staging-only work even when it touches release-only files', () => {
    const allowed = approvedReleaseFiles()
    assert.deepEqual(
      classifyReconciliation({
        mainSha: 'main',
        stagingSha: 'staging',
        mainOnlyCommits: [{ sha: 'r1', changedPaths: ['package.json'] }],
        stagingOnlyCommits: [{ sha: 's1', changedPaths: ['package.json', 'bun.lock'] }],
        allowed,
      }),
      {
        action: 'rebase-staging',
        targetSha: 'main',
        mainOnly: ['r1'],
        stagingOnly: ['s1'],
        reason: 'staging contains unpromoted commits; replay them onto main.',
      },
    )
  })

  it('fails when main-only commits include non-release files', () => {
    const allowed = approvedReleaseFiles()
    assert.equal(
      classifyReconciliation({
        mainSha: 'main',
        stagingSha: 'staging',
        mainOnlyCommits: [{ sha: 'main-commit', changedPaths: ['src/index.ts'] }],
        stagingOnlyCommits: [],
        allowed,
      }).action,
      'fail',
    )
    assert.equal(
      classifyReconciliation({
        mainSha: 'main',
        stagingSha: 'staging',
        mainOnlyCommits: [{ sha: 'main-commit', changedPaths: ['src/index.ts'] }],
        stagingOnlyCommits: [{ sha: 'staging-commit', changedPaths: ['src/feature.ts'] }],
        allowed,
      }).action,
      'fail',
    )
  })

  it('rebase-staging historical main-only paths absent from the final tree delta', () => {
    const allowed = approvedReleaseFiles()
    assert.deepEqual(
      classifyReconciliation({
        mainSha: 'main',
        stagingSha: 'staging',
        directChangedPaths: ['CHANGELOG.md', 'src/index.ts'],
        mainOnlyCommits: [
          { sha: 'release-commit', changedPaths: ['CHANGELOG.md', 'package.json'] },
          { sha: 'historical-workflow', changedPaths: ['.github/workflows/release.yml'] },
        ],
        stagingOnlyCommits: [{ sha: 'staging-feature', changedPaths: ['src/index.ts'] }],
        allowed,
      }),
      {
        action: 'rebase-staging',
        targetSha: 'main',
        mainOnly: ['release-commit', 'historical-workflow'],
        stagingOnly: ['staging-feature'],
        reason: 'staging contains unpromoted commits; replay them onto main.',
      },
    )
  })

  it('replays staging work after validated main changes', () => {
    const allowed = approvedReleaseFiles()
    assert.deepEqual(
      classifyReconciliation({
        mainSha: 'main',
        stagingSha: 'staging',
        directChangedPaths: ['CHANGELOG.md', '.github/workflows/release.yml'],
        mainOnlyCommits: [
          { sha: 'main-workflow', changedPaths: ['.github/workflows/release.yml'] },
        ],
        stagingOnlyCommits: [{ sha: 'staging-feature', changedPaths: ['src/index.ts'] }],
        allowed,
      }),
      {
        action: 'rebase-staging',
        targetSha: 'main',
        mainOnly: ['main-workflow'],
        stagingOnly: ['staging-feature'],
        reason: 'staging contains unpromoted commits; replay them onto main.',
      },
    )
  })

  it('keeps historical main-only path rejection strict without directChangedPaths', () => {
    const allowed = approvedReleaseFiles()
    assert.equal(
      classifyReconciliation({
        mainSha: 'main',
        stagingSha: 'staging',
        mainOnlyCommits: [
          { sha: 'main-workflow', changedPaths: ['.github/workflows/release.yml'] },
        ],
        stagingOnlyCommits: [{ sha: 'staging-feature', changedPaths: ['src/index.ts'] }],
        allowed,
      }).action,
      'fail',
    )
  })

  it('plans local synchronization for validated main-only source changes', () => {
    const { root, remote, run } = createReconcileWorkspace()
    const commit = (message) => {
      const result = run(['commit', '-m', message])
      assert.equal(result.status, 0, result.stderr)
      return run(['rev-parse', 'HEAD']).stdout.trim()
    }

    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n')
    run(['add', 'package.json', 'CHANGELOG.md'])
    commit('chore: initial')
    run(['branch', '-M', 'main'])

    run(['checkout', '-q', '-b', 'staging'])
    run(['checkout', '-q', 'main'])
    writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1\n')
    run(['add', 'src/index.ts'])
    commit('chore(main): touch source')

    assert.deepEqual(
      reconcileRelease(root, { github: false, dryRun: false, base: 'main', head: 'staging' }),
      {
        action: 'fast-forward',
        targetSha: run(['rev-parse', 'main']).stdout.trim(),
        reason: 'main contains validated changes that staging must inherit.',
      },
    )
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  })

  it('fails when commit metadata inspection is indeterminate', () => {
    const allowed = approvedReleaseFiles()
    assert.equal(
      classifyReconciliation({
        mainSha: 'main',
        stagingSha: 'staging',
        mainOnlyCommits: [{ sha: 'main-commit', changedPaths: undefined }],
        stagingOnlyCommits: [],
        allowed,
      }).action,
      'fail',
    )
  })

  it('plans a rebase for the promotion-copy deadlock topology', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-reconcile-deadlock-'))
    const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    const readRef = (ref) => {
      const result = git(['rev-parse', ref])
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    const commit = (message) => {
      const result = git(['commit', '-m', message])
      assert.equal(result.status, 0, result.stderr)
      return readRef('HEAD')
    }
    const cherryPick = (sha) => {
      const result = git(['cherry-pick', sha])
      assert.equal(result.status, 0, result.stderr)
    }

    git(['init', '-q'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n')
    writeFileSync(join(root, 'src/index.ts'), 'export const base = 1\n')
    git(['add', 'package.json', 'CHANGELOG.md', 'src/index.ts'])
    commit('chore: initial')
    git(['branch', '-M', 'main'])

    git(['checkout', '-q', '-b', 'staging'])
    writeFileSync(join(root, 'src/feature-a.ts'), 'export const a = 1\n')
    git(['add', 'src/feature-a.ts'])
    const featureAOnStaging = commit('feat: add a')
    writeFileSync(join(root, 'src/feature-b.ts'), 'export const b = 1\n')
    git(['add', 'src/feature-b.ts'])
    const featureBOnStaging = commit('feat: add b')

    git(['checkout', '-q', 'main'])
    cherryPick(featureAOnStaging)
    cherryPick(featureBOnStaging)
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.1"}\n')
    appendFileSync(join(root, 'CHANGELOG.md'), '\n## 1.0.1\n', 'utf8')
    git(['add', 'package.json', 'CHANGELOG.md'])
    const releaseCommitSha = commit('chore(main): release 1.0.1')

    git(['checkout', '-q', 'staging'])
    writeFileSync(join(root, 'src/feature-c.ts'), 'export const c = 1\n')
    git(['add', 'src/feature-c.ts'])
    const featureOnlySha = commit('feat: add c')

    const beforeMain = readRef('main')
    const beforeStaging = readRef('staging')
    const plan = reconcileRelease(root, { github: false, dryRun: true, base: 'main', head: 'staging' })
    assert.equal(plan.action, 'rebase-staging')
    assert.deepEqual(plan.mainOnly, [releaseCommitSha])
    assert.equal(plan.stagingOnly.length, 1)
    assert.equal(plan.stagingOnly[0], featureOnlySha)
    assert.equal(beforeMain, readRef('main'))
    assert.equal(beforeStaging, readRef('staging'))
    rmSync(root, { recursive: true, force: true })
  })

  it('replays pending staging-only work on a bare remote', () => {
    const { root, remote, run } = createReconcileWorkspace()
    const readRef = (ref) => {
      const result = run(['rev-parse', ref])
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    const commit = (message) => {
      const result = run(['commit', '-m', message])
      assert.equal(result.status, 0, result.stderr)
      return readRef('HEAD')
    }

    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n')
    writeFileSync(join(root, 'src/index.ts'), 'export const base = 1\n')
    run(['add', 'package.json', 'CHANGELOG.md', 'src/index.ts'])
    commit('chore: initial')
    run(['branch', '-M', 'main'])

    run(['checkout', '-q', '-b', 'staging'])
    writeFileSync(join(root, 'src/feature-pending.ts'), 'export const pending = 1\n')
    run(['add', 'src/feature-pending.ts'])
    commit('feat: pending work')

    run(['checkout', '-q', 'main'])
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.1"}\n')
    appendFileSync(join(root, 'CHANGELOG.md'), '\n## 1.0.1\n', 'utf8')
    run(['add', 'package.json', 'CHANGELOG.md'])
    commit('chore(main): release 1.0.1')

    run(['push', '-u', 'origin', 'main'])
    run(['checkout', '-q', 'staging'])
    run(['push', '-u', 'origin', 'staging'])

    const before = remoteHeadSha(root, 'staging')
    const plan = withGitHubEnv({
      GITHUB_REPOSITORY: 'owner/repo',
      GH_TOKEN: 'token',
    }, () => reconcileRelease(root, { github: true, dryRun: false, base: 'main', head: 'staging' }))
    const after = remoteHeadSha(root, 'staging')

    assert.equal(plan.action, 'rebase-staging')
    assert.equal(plan.synchronization, 'replay')
    assert.notEqual(before, after)
    assertRemoteMainAncestor({ run, base: 'main', head: 'staging' })
    const replayFile = run(['show', `${after}:src/feature-pending.ts`])
    assert.equal(replayFile.status, 0)
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  })

  it('does not mutate remote staging when replay conflicts and leaves it unchanged', () => {
    const { root, remote, run } = createReconcileWorkspace()
    const readRef = (ref) => {
      const result = run(['rev-parse', ref])
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    const commit = (message) => {
      const result = run(['commit', '-m', message])
      assert.equal(result.status, 0, result.stderr)
      return readRef('HEAD')
    }

    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n')
    run(['add', 'package.json', 'CHANGELOG.md'])
    commit('chore: initial')
    run(['branch', '-M', 'main'])

    run(['checkout', '-q', '-b', 'staging'])
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.1-staging"}\n')
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.1-staging\n')
    run(['add', 'package.json', 'CHANGELOG.md'])
    commit('feat: pending release-only change')

    run(['checkout', '-q', 'main'])
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.1-main"}\n')
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.1-main\n')
    run(['add', 'package.json', 'CHANGELOG.md'])
    commit('chore(main): release patch')

    run(['push', '-u', 'origin', 'main'])
    run(['checkout', '-q', 'staging'])
    run(['push', '-u', 'origin', 'staging'])

    const before = remoteHeadSha(root, 'staging')
    const runReconcile = () => withGitHubEnv({
      GITHUB_REPOSITORY: 'owner/repo',
      GH_TOKEN: 'token',
    }, () => reconcileRelease(root, { github: true, dryRun: false, base: 'main', head: 'staging' }))
    assert.throws(runReconcile, /conflict|Cherry-pick|replay/)
    const after = remoteHeadSha(root, 'staging')
    assert.equal(before, after)
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  })

  it('retries stale leases without clobbering concurrent remote updates', () => {
    const { root, remote, run } = createReconcileWorkspace()
    const readRef = (ref) => {
      const result = run(['rev-parse', ref])
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    const commit = (message) => {
      const result = run(['commit', '-m', message])
      assert.equal(result.status, 0, result.stderr)
      return readRef('HEAD')
    }

    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
    writeFileSync(join(root, 'src/index.ts'), 'export const base = 1\n')
    run(['add', 'package.json', 'src/index.ts'])
    commit('chore: initial')
    run(['branch', '-M', 'main'])

    run(['checkout', '-q', '-b', 'staging'])
    writeFileSync(join(root, 'src/feature-pending.ts'), 'export const pending = 1\n')
    run(['add', 'src/feature-pending.ts'])
    commit('feat: pending work')

    run(['checkout', '-q', 'main'])
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.1"}\n')
    run(['add', 'package.json'])
    commit('chore(main): release 1.0.1')

    run(['push', '-u', 'origin', 'main'])
    run(['checkout', '-q', 'staging'])
    run(['push', '-u', 'origin', 'staging'])

    const toolDir = mkdtempSync(join(tmpdir(), 'code-foundry-git-wrapper-'))
    const wrapperScript = join(toolDir, 'git')
    const originalPath = process.env.PATH
    const originalGitPath = spawnSync('sh', ['-lc', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
    const triggerFile = join(toolDir, 'triggered')
    writeFileSync(wrapperScript, `#!/bin/sh\nif [ \"$1\" = \"push\" ] && [ \"$2\" = \"origin\" ] && [ ! -f \"$TRIGGER_FILE\" ]; then\n  printf 1 > \"$TRIGGER_FILE\"\n  \"$ORIGINAL_GIT\" -C \"$REPO_ROOT\" checkout -q staging\n  printf 'export const concurrent = true\\n' > \"$REPO_ROOT/src/concurrent.ts\"\n  \"$ORIGINAL_GIT\" -C \"$REPO_ROOT\" add src/concurrent.ts\n  \"$ORIGINAL_GIT\" -C \"$REPO_ROOT\" commit -m 'chore: concurrent staging update'\n  \"$ORIGINAL_GIT\" -C \"$REPO_ROOT\" push -q origin staging\nfi\nexec \"$ORIGINAL_GIT\" \"$@\"\n`)
    chmodSync(wrapperScript, 0o755)
    process.env.TRIGGER_FILE = triggerFile
    process.env.ORIGINAL_GIT = originalGitPath
    process.env.REPO_ROOT = root
    process.env.PATH = `${toolDir}:${originalPath}`

    const before = remoteHeadSha(root, 'staging')
    let plan
    try {
      plan = withGitHubEnv({
        GITHUB_REPOSITORY: 'owner/repo',
        GH_TOKEN: 'token',
      }, () => reconcileRelease(root, { github: true, dryRun: false, base: 'main', head: 'staging' }))
    } finally {
      process.env.PATH = originalPath
      delete process.env.TRIGGER_FILE
      delete process.env.ORIGINAL_GIT
      delete process.env.REPO_ROOT
    }

    assert.equal(plan.action, 'rebase-staging')
    assert.equal(plan.synchronization, 'replay')
    const after = remoteHeadSha(root, 'staging')
    assert.notEqual(before, after)
    assert.equal(run(['show', `${after}:src/concurrent.ts`]).status, 0)
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
    rmSync(toolDir, { recursive: true, force: true })
  })

  it('classifies push authentication failures from raw diagnostic output', () => {
    const { root, remote, run } = createReconcileWorkspace()
    const readRef = (ref) => {
      const result = run(['rev-parse', ref])
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    const commit = (message) => {
      const result = run(['commit', '-m', message])
      assert.equal(result.status, 0, result.stderr)
      return readRef('HEAD')
    }

    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
    writeFileSync(join(root, 'src/index.ts'), 'export const base = 1\n')
    run(['add', 'package.json', 'src/index.ts'])
    commit('chore: initial')
    run(['branch', '-M', 'main'])

    run(['checkout', '-q', '-b', 'staging'])
    run(['checkout', '-q', 'main'])
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.1"}\n')
    run(['add', 'package.json'])
    commit('chore(main): release 1.0.1')

    run(['push', '-u', 'origin', 'main'])
    run(['checkout', '-q', 'staging'])
    run(['push', '-u', 'origin', 'staging'])

    const failure = 'fatal: Authentication failed for https://abc123:secrets@github.com/owner/repo.git/'
    const runReconcile = () => withFakeGitPushFailure(
      () => withGitHubEnv(
        {
          GITHUB_REPOSITORY: 'owner/repo',
          GH_TOKEN: 'token',
        },
        () => reconcileRelease(root, { github: true, dryRun: false, base: 'main', head: 'staging' }),
      ),
      failure,
    )

    let caught
    try {
      runReconcile()
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof Error)
    assert.match(caught.message, /authentication failed/i)
    assert.equal(caught.message.includes('https://abc123:secrets@github.com'), false)
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  })

  it('flattens reusable release job names below a Release caller job', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8')

    // The caller workflow is named Code Foundry with a job named Release, so
    // reusable job names must be flat (Version, Reconcile, Post Hook,
    // Publish npm) to render Code Foundry / Release / Version instead of
    // Code Foundry / Release / Release / Version.
    assert.match(workflow, /^  release:\n    name: Version\n/m)
    assert.match(workflow, /^  reconcile:\n    name: Reconcile\n/m)
    assert.match(workflow, /^  post-release:\n    name: Post Hook\n/m)
    assert.match(workflow, /^  npm:\n    name: Publish npm\n/m)
    assert.doesNotMatch(workflow, /name: Release \/ Version/)
    assert.doesNotMatch(workflow, /name: Release \/ Reconcile/)
    assert.doesNotMatch(workflow, /name: Release \/ Post Hook/)
    assert.doesNotMatch(workflow, /name: Release \/ Publish npm/)
    assert.doesNotMatch(workflow, /name: Release \/ /)

    const caller = readFileSync('.github/workflows/release_self-ci.yml', 'utf8')
    assert.match(caller, /^  release:\n    name: Release\n/m)
  })

  it('keeps reconciliation pull request metadata deterministic and reuse-safe', () => {
    assert.equal(reconciliationPullRequestBranch('main', 'staging'), 'code-foundry/reconcile/main-to-staging')
    assert.equal(reconciliationPullRequestTitle({ targetHead: 'staging', sourceBase: 'main' }), 'chore(staging): reconcile release metadata from main')
    const body = buildReconciliationPullRequestBody({
      sourceBase: 'main',
      targetHead: 'staging',
      mainSha: 'main-tip',
      stagingSha: 'staging-tip',
      targetSha: 'main-tip',
      action: 'fast-forward',
      pushError: 'remote: error: GH007: rejected by a repository rule',
    })
    assert.match(body, /## Automated release reconciliation/)
    assert.match(body, /generated by Code Foundry release reconciliation/)
    // The body names the protected PR base (staging) and the source (main).
    assert.match(body, /- Base `staging`: `staging-tip`/)
    assert.match(body, /- `main` tip: `main-tip`/)
    assert.match(body, /main-tip/)
    assert.match(body, /staging-tip/)
    assert.match(body, /GH007: rejected by a repository rule/)
    assert.match(body, /fail the release job closed/)
    assert.match(body, /updated instead of duplicated/)

    const branch = reconciliationPullRequestBranch('main', 'staging')
    const title = reconciliationPullRequestTitle({ targetHead: 'staging', sourceBase: 'main' })
    assert.deepEqual(selectReconciliationPullRequest([], { targetBase: 'staging', branch, title }), { create: true })
    const ours = { number: 5, title, headRefName: branch, baseRefName: 'staging', url: 'https://github.com/owner/repo/pull/5' }
    assert.deepEqual(selectReconciliationPullRequest([ours], { targetBase: 'staging', branch, title }), { create: false, reuse: ours })
    const renamed = { number: 6, title: 'chore: user edited title', headRefName: branch, baseRefName: 'staging' }
    assert.match(selectReconciliationPullRequest([renamed], { targetBase: 'staging', branch, title }).error, /unexpected base or title/)
    const wrongBase = { number: 7, title, headRefName: branch, baseRefName: 'main' }
    assert.match(selectReconciliationPullRequest([wrongBase], { targetBase: 'staging', branch, title }).error, /unexpected base or title/)
    assert.match(
      selectReconciliationPullRequest([ours, { ...ours, number: 8 }], { targetBase: 'staging', branch, title }).error,
      /Multiple open pull requests/,
    )
  })

  it('keeps exact-lease stale failure detail in diagnostics', () => {
    const { root, remote, run } = createReconcileWorkspace()
    const readRef = (ref) => {
      const result = run(['rev-parse', ref])
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    const commit = (message) => {
      const result = run(['commit', '-m', message])
      assert.equal(result.status, 0, result.stderr)
      return readRef('HEAD')
    }

    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
    run(['add', 'package.json'])
    commit('chore: initial')
    run(['branch', '-M', 'main'])

    run(['checkout', '-q', '-b', 'staging'])
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n')
    run(['add', 'CHANGELOG.md'])
    commit('feat: unreleased docs')

    run(['checkout', '-q', 'main'])
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.1"}\n')
    run(['add', 'package.json'])
    commit('chore(main): release 1.0.1')

    run(['push', '-u', 'origin', 'main'])
    run(['checkout', '-q', 'staging'])
    run(['push', '-u', 'origin', 'staging'])

    const failure = '! [remote rejected] staging -> staging (non-fast-forward)'
    let caught
    try {
      withFakeGitPushFailure(
        () => withGitHubEnv({
          GITHUB_REPOSITORY: 'owner/repo',
          GH_TOKEN: 'token',
        }, () => reconcileRelease(root, { github: true, dryRun: false, base: 'main', head: 'staging' })),
        failure,
      )
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof Error)
    assert.match(caught.message, /rejected by an exact lease/i)
    assert.match(caught.message, /Last failure detail/i)
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  })

  it('opens an idempotent reconciliation pull request when staging policy rejects the lease push', () => {
    const { root, remote, readRef } = createPolicyBlockedReconcileWorkspace()
    const branch = reconciliationPullRequestBranch('main', 'staging')
    const mainSha = readRef('main')
    const stagingBefore = remoteHeadSha(root, 'staging')
    const execute = () => withFakeStagingPolicyPushFailure(
      () => withGitHubEnv({
        GITHUB_REPOSITORY: 'owner/repo',
        GH_TOKEN: 'token',
      }, () => reconcileRelease(root, { github: true, dryRun: false, base: 'main', head: 'staging' })),
      POLICY_PUSH_FAILURE,
    )

    const { result, log, state } = withReconcileGh({}, execute)

    assert.equal(result.action, 'fast-forward')
    assert.equal(result.synchronization, 'pull-request')
    assert.equal(result.pullRequest.base, 'staging')
    assert.equal(result.pullRequest.head, branch)
    assert.equal(result.pullRequest.branch, branch)
    assert.equal(result.pullRequest.number, 42)
    assert.equal(result.pullRequest.title, 'chore(staging): reconcile release metadata from main')
    assert.match(result.pullRequest.body, /## Automated release reconciliation/)
    assert.match(result.pullRequest.body, /GH007/)
    assert.match(result.pullRequest.body, new RegExp(`Target tip in this branch: \`${mainSha}\``))
    // The PR targets the protected head branch while the body names the
    // release source (main) explicitly.
    assert.match(result.pullRequest.body, /- Base `staging`: `/)
    assert.match(result.pullRequest.body, /- `main` tip: `/)
    assert.doesNotMatch(result.pullRequest.body, /- Base `main`: /)
    // Staging is untouched while the head branch carries the exact main tip.
    assert.equal(remoteHeadSha(root, 'staging'), stagingBefore)
    assert.equal(remoteHeadSha(root, branch), mainSha)
    // Exactly one create with the generated metadata; no edit or duplicate.
    assert.match(log, new RegExp(`pr create --repo owner/repo --base staging --head ${branch} --title chore\\(staging\\): reconcile release metadata from main --body`))
    assert.doesNotMatch(log, /pr edit/)
    assert.equal(state.prs.length, 1)
    assert.equal(state.prs[0].baseRefName, 'staging')
    assert.equal(state.prs[0].headRefName, branch)
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  })

  it('does not convert generic remote errors into reconciliation pull requests', () => {
    const { root, remote } = createPolicyBlockedReconcileWorkspace()
    const execute = () => withFakeStagingPolicyPushFailure(
      () => withGitHubEnv({
        GITHUB_REPOSITORY: 'owner/repo',
        GH_TOKEN: 'token',
      }, () => reconcileRelease(root, { github: true, dryRun: false, base: 'main', head: 'staging' })),
      'remote: error: temporary GitHub server failure',
    )

    assert.throws(execute, /rejected by an exact lease/i)
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  })

  it('reuses the open reconciliation pull request on reruns without duplicating it', () => {
    const { root, remote, run, readRef } = createPolicyBlockedReconcileWorkspace()
    const branch = reconciliationPullRequestBranch('main', 'staging')
    const mainSha = readRef('main')
    // A previous run already delivered the exact main tip and left the PR open.
    run(['push', 'origin', `main:refs/heads/${branch}`])
    const execute = () => withFakeStagingPolicyPushFailure(
      () => withGitHubEnv({
        GITHUB_REPOSITORY: 'owner/repo',
        GH_TOKEN: 'token',
      }, () => reconcileRelease(root, { github: true, dryRun: false, base: 'main', head: 'staging' })),
      POLICY_PUSH_FAILURE,
    )

    const { result, log, state } = withReconcileGh({
      prs: [{
        number: 17,
        title: reconciliationPullRequestTitle({ targetHead: 'staging', sourceBase: 'main' }),
        headRefName: branch,
        baseRefName: 'staging',
        url: 'https://github.com/owner/repo/pull/17',
      }],
    }, execute)

    assert.equal(result.synchronization, 'pull-request')
    assert.equal(result.pullRequest.base, 'staging')
    assert.equal(result.pullRequest.head, branch)
    assert.equal(result.pullRequest.number, 17)
    assert.equal(remoteHeadSha(root, branch), mainSha)
    assert.doesNotMatch(log, /pr create/)
    assert.doesNotMatch(log, /pr edit/)
    assert.equal(state.prs.length, 1)
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  })

  it('refreshes a stale reconciliation pull request head and body to the exact target tip', () => {
    const { root, remote, run, readRef } = createPolicyBlockedReconcileWorkspace()
    const branch = reconciliationPullRequestBranch('main', 'staging')
    const mainSha = readRef('main')
    const staleSha = readRef('staging')
    // The previous run predates the latest release: branch and PR head are stale.
    run(['push', 'origin', `staging:refs/heads/${branch}`])
    const execute = () => withFakeStagingPolicyPushFailure(
      () => withGitHubEnv({
        GITHUB_REPOSITORY: 'owner/repo',
        GH_TOKEN: 'token',
      }, () => reconcileRelease(root, { github: true, dryRun: false, base: 'main', head: 'staging' })),
      POLICY_PUSH_FAILURE,
    )

    const { result, log, state } = withReconcileGh({
      prs: [{
        number: 23,
        title: reconciliationPullRequestTitle({ targetHead: 'staging', sourceBase: 'main' }),
        headRefName: branch,
        baseRefName: 'staging',
        url: 'https://github.com/owner/repo/pull/23',
      }],
    }, execute)

    assert.equal(result.synchronization, 'pull-request')
    assert.equal(result.pullRequest.base, 'staging')
    assert.equal(result.pullRequest.head, branch)
    assert.equal(result.pullRequest.number, 23)
    assert.notEqual(staleSha, mainSha)
    // The branch is refreshed under the exact lease and the body is updated.
    assert.equal(remoteHeadSha(root, branch), mainSha)
    assert.doesNotMatch(log, /pr create/)
    assert.match(log, /pr edit 23/)
    assert.equal(state.prs.length, 1)
    assert.match(state.prs[0].body, new RegExp(`Target tip in this branch: \`${mainSha}\``))
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  })

  it('replays staging-only commits into the reconciliation pull request head', () => {
    const { root, remote, run, readRef } = createPolicyBlockedReconcileWorkspace({ withStagingCommit: true })
    const branch = reconciliationPullRequestBranch('main', 'staging')
    const mainSha = readRef('main')
    const stagingBefore = remoteHeadSha(root, 'staging')
    const execute = () => withFakeStagingPolicyPushFailure(
      () => withGitHubEnv({
        GITHUB_REPOSITORY: 'owner/repo',
        GH_TOKEN: 'token',
      }, () => reconcileRelease(root, { github: true, dryRun: false, base: 'main', head: 'staging' })),
      POLICY_PUSH_FAILURE,
    )

    const { result, log, state } = withReconcileGh({}, execute)

    assert.equal(result.action, 'rebase-staging')
    assert.equal(result.synchronization, 'pull-request')
    assert.ok(result.replaySha)
    const headTip = remoteHeadSha(root, branch)
    assert.equal(headTip, result.replaySha)
    assert.notEqual(headTip, mainSha)
    assert.equal(remoteHeadSha(root, 'staging'), stagingBefore)
    // The replay tip is based on the current main tip and keeps the pending work.
    assert.equal(run(['merge-base', '--is-ancestor', 'origin/main', `origin/${branch}`]).status, 0)
    assert.equal(run(['show', `${headTip}:src/feature-pending.ts`]).status, 0)
    assert.match(state.prs[0].body, /rebase-staging/)
    assert.match(log, /pr create/)
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  })

  it('fails closed when reconciliation pull request state is ambiguous or gh fails', () => {
    const { root, remote } = createPolicyBlockedReconcileWorkspace()
    const branch = reconciliationPullRequestBranch('main', 'staging')
    const title = reconciliationPullRequestTitle({ targetHead: 'staging', sourceBase: 'main' })
    const execute = () => withFakeStagingPolicyPushFailure(
      () => withGitHubEnv({
        GITHUB_REPOSITORY: 'owner/repo',
        GH_TOKEN: 'token',
      }, () => reconcileRelease(root, { github: true, dryRun: false, base: 'main', head: 'staging' })),
      POLICY_PUSH_FAILURE,
    )
    const seeded = (number, overrides = {}) => ({
      number,
      title,
      headRefName: branch,
      baseRefName: 'staging',
      url: `https://github.com/owner/repo/pull/${number}`,
      ...overrides,
    })

    // Two open PRs claim the deterministic branch: ambiguous, fail closed.
    assert.throws(() => withReconcileGh({ prs: [seeded(1), seeded(2)] }, execute), /Multiple open pull requests/)
    // A foreign title on the deterministic branch: fail closed before pushing.
    assert.throws(() => withReconcileGh({ prs: [seeded(3, { title: 'chore: user edited title' })] }, execute), /unexpected base or title/)
    // A pull request from the branch into another base: fail closed.
    assert.throws(() => withReconcileGh({ prs: [seeded(4, { baseRefName: 'main' })] }, execute), /unexpected base or title/)
    // gh pr list failure: fail closed.
    assert.throws(() => withReconcileGh({ failList: true }, execute), /Failed to list open pull requests/)
    // gh pr create failure with no reusable PR: fail closed.
    assert.throws(() => withReconcileGh({ failCreate: true }, execute), /gh pr create failed/)
    assert.throws(
      () => withReconcileGh({
        failCreate: true,
        failCreateMessage: 'GraphQL: GitHub Actions is not permitted to create or approve pull requests.\\n',
      }, execute),
      /Settings > Actions > General > Workflow permissions/,
    )
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  })

  it('is idempotent when patch-equivalent branches are already synchronized', () => {
    const { root, remote, run } = createReconcileWorkspace()
    const readRef = (ref) => {
      const result = run(['rev-parse', ref])
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    const commit = (message) => {
      const result = run(['commit', '-m', message])
      assert.equal(result.status, 0, result.stderr)
      return readRef('HEAD')
    }

    writeFileSync(join(root, 'src.txt'), 'base\n')
    run(['add', 'src.txt'])
    commit('chore: initial')
    run(['branch', '-M', 'main'])

    run(['checkout', '-q', '-b', 'staging'])
    run(['checkout', '-q', 'main'])
    writeFileSync(join(root, 'src.txt'), 'main\n')
    run(['add', 'src.txt'])
    const mainCommit = commit('chore(main): release patch')

    run(['checkout', '-q', 'staging'])
    run(['cherry-pick', mainCommit])
    run(['push', '-u', 'origin', 'main'])
    run(['push', '-u', 'origin', 'staging'])

    const firstPlan = withGitHubEnv({
      GITHUB_REPOSITORY: 'owner/repo',
      GH_TOKEN: 'token',
    }, () => reconcileRelease(root, { github: true, dryRun: false, base: 'main', head: 'staging' }))
    assert.equal(firstPlan.action, 'aligned')
    assertRemoteMainAncestor({ run, base: 'main', head: 'staging' })

    const secondPlan = withGitHubEnv({
      GITHUB_REPOSITORY: 'owner/repo',
      GH_TOKEN: 'token',
    }, () => reconcileRelease(root, { github: true, dryRun: false, base: 'main', head: 'staging' }))
    assert.equal(secondPlan.action, 'aligned')
    assertRemoteMainAncestor({ run, base: 'main', head: 'staging' })
    assert.equal(remoteHeadSha(root, 'staging'), remoteHeadSha(root, 'main'))
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  })

  it('does not open a misleading pull request when policy blocks history-only alignment', () => {
    const { root, remote, run } = createReconcileWorkspace()
    const commit = (message) => {
      const result = run(['commit', '-m', message])
      assert.equal(result.status, 0, result.stderr)
      return run(['rev-parse', 'HEAD']).stdout.trim()
    }

    writeFileSync(join(root, 'src.txt'), 'base\n')
    run(['add', 'src.txt'])
    commit('chore: initial')
    run(['branch', '-M', 'main'])
    run(['checkout', '-q', '-b', 'staging'])
    run(['checkout', '-q', 'main'])
    writeFileSync(join(root, 'src.txt'), 'released\n')
    run(['add', 'src.txt'])
    const mainCommit = commit('chore(main): release patch')
    run(['checkout', '-q', 'staging'])
    writeFileSync(join(root, 'src.txt'), 'released\n')
    run(['add', 'src.txt'])
    commit(`chore(staging): apply ${mainCommit.slice(0, 8)}`)
    run(['push', '-u', 'origin', 'main'])
    run(['push', '-u', 'origin', 'staging'])

    const stagingBefore = remoteHeadSha(root, 'staging')
    assert.notEqual(remoteHeadSha(root, 'main'), stagingBefore)
    const execute = () => withFakeStagingPolicyPushFailure(
      () => withGitHubEnv({
        GITHUB_REPOSITORY: 'owner/repo',
        GH_TOKEN: 'token',
      }, () => reconcileRelease(root, { github: true, dryRun: false, base: 'main', head: 'staging' })),
      POLICY_PUSH_FAILURE,
    )
    const { result, log, state } = withReconcileGh({}, execute)

    assert.equal(result.action, 'aligned')
    assert.equal(result.synchronization, 'content-aligned')
    assert.equal(remoteHeadSha(root, 'staging'), stagingBefore)
    assert.equal(state.prs.length, 0)
    assert.doesNotMatch(log, /pr create/)
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  })

  it('suppresses only release-only divergence from a rebased promotion', () => {
    const allowed = approvedReleaseFiles({
      packages: { web: { 'extra-files': ['src/version.ts'] } },
    })
    assert.deepEqual(
      classifyPromotion({
        mainIsAncestor: false,
        directChangedPaths: ['CHANGELOG.md', 'package.json', 'web/src/version.ts'],
        allowed,
      }),
      { releaseOnly: true, unexpected: [] },
    )
    assert.equal(
      classifyPromotion({
        mainIsAncestor: true,
        directChangedPaths: ['CHANGELOG.md'],
        allowed,
      }).releaseOnly,
      false,
    )
    assert.deepEqual(
      classifyPromotion({
        mainIsAncestor: false,
        directChangedPaths: ['CHANGELOG.md', 'src/index.ts'],
        allowed,
      }),
      { releaseOnly: false, unexpected: ['src/index.ts'] },
    )
  })

  it('guards the promotion workflow against release-only divergence', () => {
    const workflow = readFileSync('.github/workflows/release-pr.yml', 'utf8')

    assert.match(workflow, /fetch-depth: 0/)
    assert.match(workflow, /persist-credentials: false/)
    assert.match(workflow, /git merge-base --is-ancestor origin\/main origin\/staging/)
    assert.match(workflow, /git diff --name-only origin\/staging origin\/main/)
    assert.match(workflow, /release_only=\$RELEASE_ONLY/)
    assert.match(workflow, /steps\.check-pr\.outputs\.release_only == 'true'/)
    assert.match(workflow, /steps\.check-pr\.outputs\.release_only != 'true'/)
    assert.match(workflow, /merge_strategy.*rebase/)
    assert.match(workflow, /never merge a promotion PR with a merge commit/)

    // The existing-promotion-PR lookup must use authenticated REST, not
    // `gh pr list` (GraphQL): NiftyLeague's long-lived fine-grained token
    // policy rejects the GraphQL query. The REST query keeps the exact
    // base/head/state filter and the per_page=1 cap (existing is 0 or 1),
    // and the step stays fail-closed via set -euo pipefail.
    const checkStart = workflow.indexOf('- name: Check\n')
    const checkEnd = workflow.indexOf('- name: ', checkStart + 1)
    assert.ok(checkStart !== -1 && checkEnd !== -1, 'workflow has a Check step')
    const checkStep = workflow.slice(checkStart, checkEnd)
    assert.match(checkStep, /gh api \\\n\s+"repos\/\$\{GITHUB_REPOSITORY\}\/pulls\?base=main&head=staging&state=open&per_page=1"/)
    assert.match(checkStep, /--jq 'length'/)
    assert.match(checkStep, /set -euo pipefail/)
    // Comment lines may explain why gh pr list is not used; the invocation
    // itself must not appear in any shell command line of the Check step.
    const checkCommands = checkStep
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    assert.doesNotMatch(checkCommands, /gh pr list/)

    // The create-race fallback after a failed creation POST must use the
    // same authenticated REST query as the Check step, extracting the first
    // open PR's number and failing closed when none exists.
    const createStart = workflow.indexOf('- name: Create\n')
    const nextStep = workflow.indexOf('- name: ', createStart + 1)
    assert.ok(createStart !== -1, 'workflow has a Create step')
    const createStep = nextStep === -1 ? workflow.slice(createStart) : workflow.slice(createStart, nextStep)
    assert.match(createStep, /gh api \\\n\s+"repos\/\$\{GITHUB_REPOSITORY\}\/pulls\?base=main&head=staging&state=open&per_page=1"/)
    assert.match(createStep, /--jq '\.\[0\]\.number \/\/ empty'/)
    assert.match(createStep, /Pull request creation failed and no existing promotion PR was found\./)
    const createCommands = createStep
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    assert.doesNotMatch(createCommands, /gh pr list/)

    // Creation must use authenticated REST (gh api POST) rather than
    // `gh pr create`, which issues a GraphQL mutation that NiftyLeague's
    // long-lived fine-grained token policy rejects. The REST payload must
    // carry the exact base/head/title/body fields, add draft=true only when
    // no automation token is configured, and fail closed on API errors.
    assert.match(createStep, /CREATE_ARGS=\(\n/)
    assert.match(createStep, /"repos\/\$\{GITHUB_REPOSITORY\}\/pulls"/)
    assert.match(createStep, /--method POST/)
    assert.match(createStep, /--field base=main/)
    assert.match(createStep, /--field head=staging/)
    assert.match(createStep, /--field title="Promote staging -> main \(\$DATE\)"/)
    assert.match(createStep, /--field body=@"\$BODY_FILE"/)
    assert.match(createStep, /if gh api "\$\{CREATE_ARGS\[\@\]\}"; then/)
    assert.match(createStep, /--field draft=true/)
    const draftCondition = createStep.indexOf('HAS_AUTOMATION_TOKEN" != true')
    const draftField = createStep.indexOf('--field draft=true')
    assert.ok(draftCondition !== -1 && draftField !== -1)
    assert.ok(draftCondition < draftField, 'draft=true must be added only when no automation token is configured')
    assert.doesNotMatch(createCommands, /gh pr create/)

    // No `gh pr list` or `gh pr create` invocation may remain anywhere in
    // the reusable workflow; comment lines may explain why they are not
    // used, but the invocations themselves must not appear in any shell
    // command line.
    const commands = workflow
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    assert.doesNotMatch(commands, /gh pr list/)
    assert.doesNotMatch(commands, /gh pr create/)

    // The partial clone defers blob downloads, so the merge-base/diff
    // comparison can trigger a promisor fetch that needs git auth. Read-only
    // auth must be configured before that comparison runs.
    const authSetup = workflow.indexOf('gh auth setup-git')
    const mergeBase = workflow.indexOf('git merge-base --is-ancestor origin/main origin/staging')
    assert.ok(authSetup !== -1, 'workflow configures git auth for the promisor fetch')
    assert.ok(mergeBase !== -1)
    assert.ok(authSetup < mergeBase, 'git auth setup must precede the merge-base comparison')
  })

  it('uses github.token for read-only promotion lookups and falls back to it for writes', () => {
    const workflow = readFileSync('.github/workflows/release-pr.yml', 'utf8')
    const stepSlice = (name) => {
      const start = workflow.indexOf(`- name: ${name}\n`)
      assert.ok(start !== -1, `workflow has a ${name} step`)
      const next = workflow.indexOf('- name: ', start + 1)
      return next === -1 ? workflow.slice(start) : workflow.slice(start, next)
    }

    // Read-only operations (partial-clone git auth, existing-PR lookup,
    // commit-tree and compare lookups) must use the short-lived workflow
    // token: NiftyLeague rejects long-lived fine-grained automation tokens
    // with HTTP 403 even on REST, so the automation secrets must not appear
    // in the Configure git auth or Check step environments.
    const authStep = stepSlice('Configure git auth for blob fetch')
    assert.match(authStep, /GH_TOKEN: \$\{\{ github\.token \}\}/)
    assert.doesNotMatch(authStep, /CODE_FOUNDRY_TOKEN|RELEASE_PLEASE_TOKEN/)

    const checkStep = stepSlice('Check')
    assert.match(checkStep, /GH_TOKEN: \$\{\{ github\.token \}\}/)
    assert.doesNotMatch(checkStep, /CODE_FOUNDRY_TOKEN|RELEASE_PLEASE_TOKEN/)

    // Writes keep the configured automation token when present and fall back
    // to github.token only when no automation token is configured.
    const createStep = stepSlice('Create')
    assert.match(createStep, /GH_TOKEN: \$\{\{ secrets\.CODE_FOUNDRY_TOKEN \|\| secrets\.RELEASE_PLEASE_TOKEN \|\| github\.token \}\}/)

    // A failed REST POST is retried once with the short-lived workflow token,
    // and only when an automation token was actually configured (otherwise the
    // first attempt already ran as github.token). The retry must be the same
    // REST payload, not a gh pr create.
    const retry = 'GH_TOKEN="${{ github.token }}" gh api "${CREATE_ARGS[@]}"'
    const retryIndex = createStep.indexOf(retry)
    assert.ok(retryIndex !== -1, 'Create step retries the POST with github.token')
    const tokenGuard = createStep.indexOf('[ "$HAS_AUTOMATION_TOKEN" = true ]')
    assert.ok(tokenGuard !== -1 && tokenGuard < retryIndex, 'the github.token retry is guarded by HAS_AUTOMATION_TOKEN')

    // The create-race fallback lookup runs only after creation failed: with
    // a configured automation token present but rejected (and its github.token
    // retry failed), or with no automation token configured, where the first
    // attempt already ran as github.token. The lookup always uses the
    // short-lived workflow token so it cannot be rejected by the automation
    // token policy, and it must come after the retry so a successful retry
    // skips the lookup.
    const fallback = 'GH_TOKEN="${{ github.token }}" gh api \\'
    const fallbackIndex = createStep.indexOf(fallback)
    assert.ok(fallbackIndex !== -1 && fallbackIndex > retryIndex, 'the create-race lookup uses github.token after the retry')

    const createCommands = createStep
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    assert.doesNotMatch(createCommands, /gh pr list/)
    assert.doesNotMatch(createCommands, /gh pr create/)
  })

  it('keys runtime concurrency by event so promotion PRs do not cancel push checks', () => {
    for (const workflow of ['ci', 'codeql', 'security', 'test']) {
      const runtime = readFileSync(`.github/workflows/${workflow}.yml`, 'utf8')
      assert.match(runtime, /code-foundry-\w+-\$\{\{ github\.event_name \}\}-\$\{\{ github\.event\.pull_request\.head\.repo\.full_name \|\| github\.repository \}\}/)
    }
  })

  it('attaches validation and opencode-security triggers to staging and main pull requests', () => {
    for (const workflow of ['validation_self-ci', 'opencode-security_self-ci']) {
      const caller = readFileSync(`.github/workflows/${workflow}.yml`, 'utf8')
      assert.match(caller, /pull_request:\n\s+branches: \[main, staging\]/)
    }

    const scanner = readFileSync('.github/workflows/opencode-security_self-ci.yml', 'utf8')
    assert.match(scanner, /source_ref: b3dce823322672b285fbe99b870ea984c01826cb/)
    assert.doesNotMatch(scanner, /source_ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.ref/)
  })

  it('keeps generated Rust CodeQL configuration inside the workspace', () => {
    const workflow = readFileSync('.github/workflows/codeql.yml', 'utf8')

    assert.match(workflow, /config_file="\$GITHUB_WORKSPACE\/\.github\/codeql-rust-\$scope_id\.yml"/)
    assert.doesNotMatch(workflow, /config_file="\$RUNNER_TEMP\/codeql-rust-/)
  })

  it('does not duplicate canonical checks in the release PR caller', () => {
    const caller = readFileSync('.github/workflows/release-pr_self-ci.yml', 'utf8')

    assert.match(caller, /^\s{2}release-pr:/m)
    for (const duplicate of ['ci', 'test', 'security', 'codeql']) {
      assert.doesNotMatch(caller, new RegExp(`^  ${duplicate}:`, 'm'))
    }
  })

  it('bootstraps a Release Please manifest from current package versions', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-manifest-seed-'))
    mkdirSync(join(root, 'web/src'), { recursive: true })
    mkdirSync(join(root, 'service'), { recursive: true })
    writeFileSync(join(root, 'web/package.json'), '{"name":"fixture-web","version":"1.2.3"}\n')
    writeFileSync(join(root, 'web/src/version.ts'), 'export const version = "1.2.3"\n')
    writeFileSync(join(root, 'service/Cargo.toml'), '[package]\nname = "fixture-service"\nversion = "0.4.0"\n')

    assert.deepEqual(buildReleaseManifest(root, { packages: { '.': {}, web: {}, service: {} } }), {
      '.': '0.0.0',
      web: '1.2.3',
      service: '0.4.0',
    })
    assert.deepEqual(buildReleaseManifest(root, { 'release-type': 'node' }), { '.': '0.0.0' })
    assert.equal(buildReleaseManifest(root, {}), null)
    assert.equal(buildReleaseManifest(root, { packages: {} }), null)
  })

  it('bootstraps the release manifest during sync without regressing owned versions', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-sync-manifest-'))
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"2.1.0"}\n')
    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\nrelease_type: node\n')

    syncRepository({ target: root, source: process.cwd(), init: true })
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.release-please-manifest.json'), 'utf8')), { '.': '2.1.0' })

    // A later sync must not regress a manifest that release-please owns.
    writeFileSync(join(root, '.release-please-manifest.json'), '{\n  ".": "3.0.0"\n}\n')
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"2.1.0"}\n')
    syncRepository({ target: root, source: process.cwd() })
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.release-please-manifest.json'), 'utf8')), { '.': '3.0.0' })
  })

  it('reports a missing release manifest during doctor', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-doctor-manifest-'))
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(join(root, 'release-please-config.json'), '{"release-type": "node"}\n')
    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\nrelease_type: node\n')

    const result = run('doctor', '--target', root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /\.release-please-manifest\.json.*code-foundry sync/)
  })

  it('generates a mixed-language Release Please manifest without losing custom fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-release-manifest-'))
    mkdirSync(join(root, 'web/src'), { recursive: true })
    mkdirSync(join(root, 'service'), { recursive: true })
    writeFileSync(join(root, 'web/package.json'), '{"name":"fixture-web","version":"1.0.0"}\n')
    writeFileSync(join(root, 'web/src/version.ts'), 'export const version = "1.0.0"\n')
    writeFileSync(join(root, 'service/Cargo.toml'), '[package]\nname = "fixture-service"\nversion = "1.0.0"\n')
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "fixture-python"\nversion = "1.0.0"\n')

    const packages = detectReleasePackages(root)
    assert.deepEqual(packages.map(({ directory, releaseType }) => [directory, releaseType]), [
      ['.', 'python'],
      ['service', 'rust'],
      ['web', 'node'],
    ])
    const config = buildReleaseConfig(root, { 'changelog-sections': [{ type: 'feat', section: 'Features' }] })
    assert.deepEqual(config['changelog-sections'], [{ type: 'feat', section: 'Features' }])
    assert.equal(config.packages['web']['release-type'], 'node')
    assert.deepEqual(config.packages['web']['extra-files'], ['src/version.ts'])
    assert.deepEqual(validateReleaseConfig(root, config), [])
  })

  it('preserves an explicit Release Please packages policy', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-release-policy-'))
    mkdirSync(join(root, 'apps/web'), { recursive: true })
    mkdirSync(join(root, 'third_party/vendor'), { recursive: true })
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "1.0.0"\n')
    writeFileSync(join(root, 'apps/web/package.json'), '{"name":"fixture-web","version":"1.0.0"}\n')
    writeFileSync(join(root, 'third_party/vendor/Cargo.toml'), '[package]\nname = "vendor"\nversion = "1.0.0"\n')

    const explicit = {
      packages: { '.': { 'release-type': 'rust', 'package-name': 'fixture' } },
      'extra-files': ['apps/web/package.json'],
    }
    assert.deepEqual(buildReleaseConfig(root, explicit), explicit)
  })

  it('selects one token-aware post-release delivery and prevents duplicate tags', () => {
    assert.equal(selectHookDelivery({ mode: 'auto', tokenPresent: true }).delivery, 'workflow-dispatch')
    assert.equal(selectHookDelivery({ mode: 'auto', tokenPresent: false }).delivery, 'release-event')
    assert.equal(selectHookDelivery({ mode: 'disabled', tokenPresent: true }).delivery, 'disabled')
    const key = releaseDeliveryKey('owner/repo', 'v1.2.3')
    assert.match(key, /^[a-f0-9]{24}$/)
    assert.equal(hasDeliveredHook([{ headBranch: 'v1.2.3', status: 'completed' }], 'v1.2.3'), true)
    assert.equal(hasDeliveredHook([{ headBranch: 'v1.2.4', status: 'completed' }], 'v1.2.3'), false)
  })

  it('keeps release policy decisions executable and deterministic', () => {
    assert.equal(selectReleaseCredential({ releasePleaseToken: 'secret', githubToken: 'fallback' }).source, 'release-please-token')
    assert.equal(selectReleaseCredential({ githubToken: 'fallback' }).autoMerge, false)
    assert.equal(selectReleaseCredential({}).source, 'missing')
    const allowed = new Set(['CHANGELOG.md', 'package.json'])
    const generated = [{ number: 42, title: 'chore(main): release 1.2.3', headRefName: 'release-please--branches--main' }]
    const valid = validateReleasePullRequests(generated, new Map([[42, ['CHANGELOG.md', 'package.json']]]), allowed)
    assert.equal(valid.valid, true)
    assert.equal(validateReleasePullRequests(generated, new Map([[42, ['src/index.ts']]]), allowed).valid, false)
    assert.equal(validateReleasePullRequests(generated, new Map([[42, []]]), allowed).valid, false)
    assert.equal(validateReleasePullRequests([], new Map(), allowed).valid, false)
    assert.equal(validateReleasePullRequests([{ number: 7, title: 'chore(main): release 1.2.3' }], new Map([[7, ['CHANGELOG.md']]]), allowed).valid, false)
  })

  it('recommends full runners for native-toolchain repositories', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-runner-'))
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "runner-fixture"\n')
    assert.equal(recommendRunners(root).unit_runner, 'ubuntu-latest')
    assert.equal(recommendRunners(root).security_runner, 'ubuntu-slim')
    const browser = mkdtempSync(join(tmpdir(), 'code-foundry-browser-'))
    writeFileSync(join(browser, 'playwright.config.ts'), 'export default {}\n')
    assert.equal(recommendRunners(browser).test_runner, 'ubuntu-latest')
  })

  it('packages the Python formatter baseline for Python consumers', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-python-init-'))
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "python-fixture"\nversion = "1.0.0"\n')
    syncRepository({ target: root, source: process.cwd(), init: true })
    assert.match(readFileSync(join(root, 'ruff.toml'), 'utf8'), /line-length = 100/)
  })

  it('classifies pull requests to staging as fast regardless of head shape', () => {
    for (const head of ['feature/foo', 'staging', 'main', RELEASE_PLEASE_PREFIX, `${RELEASE_PLEASE_PREFIX}--v1.2.3`]) {
      assert.equal(classifyValidationMode({ eventName: 'pull_request', baseRef: 'staging', headRef: head }), 'fast')
    }
  })

  it('classifies main pull requests from the exact Release Please prefix as release', () => {
    assert.equal(classifyValidationMode({ eventName: 'pull_request', baseRef: 'main', headRef: RELEASE_PLEASE_PREFIX }), 'release')
    assert.equal(classifyValidationMode({ eventName: 'pull_request', baseRef: 'main', headRef: `${RELEASE_PLEASE_PREFIX}--v1.2.3` }), 'release')
    assert.equal(classifyValidationMode({ eventName: 'pull_request', baseRef: 'main', headRef: `${RELEASE_PLEASE_PREFIX}--v1.2.3--rc.1` }), 'release')
    assert.equal(classifyValidationMode({ eventName: 'pull_request', baseRef: 'main', headRef: `${RELEASE_PLEASE_PREFIX}--` }), 'release')
  })

  it('rejects malicious lookalikes that miss the exact Release Please prefix boundary', () => {
    const lookalikes = [
      `${RELEASE_PLEASE_PREFIX}x`,
      `${RELEASE_PLEASE_PREFIX}s`,
      `${RELEASE_PLEASE_PREFIX}-v1.2.3`,
      `${RELEASE_PLEASE_PREFIX}_v1.2.3`,
      `${RELEASE_PLEASE_PREFIX}/v1.2.3`,
      `${RELEASE_PLEASE_PREFIX} `,
      ` ${RELEASE_PLEASE_PREFIX}`,
      'Release-please--branches--main--v1.2.3',
      'release-please--branches--MAIN--v1.2.3',
      'release-please--branches--staging--v1.2.3',
      'release-please--branches--mains--v1.2.3',
      'release-please--branches--mainx/v1.2.3',
    ]
    for (const head of lookalikes) {
      assert.equal(isReleasePleaseHead(head), false, head)
      assert.equal(classifyValidationMode({ eventName: 'pull_request', baseRef: 'main', headRef: head }), 'audit', head)
    }
  })

  it('classifies every other main pull request as audit, including promotion PRs', () => {
    for (const head of ['feature/foo', 'staging', 'main', 'release-please--branches--staging--v1.2.3', 'chore(main): release 1.2.3']) {
      assert.equal(classifyValidationMode({ eventName: 'pull_request', baseRef: 'main', headRef: head }), 'audit', head)
    }
  })

  it('classifies schedule and workflow_dispatch as audit', () => {
    assert.equal(classifyValidationMode({ eventName: 'schedule' }), 'audit')
    assert.equal(classifyValidationMode({ eventName: 'workflow_dispatch' }), 'audit')
  })

  it('rejects unsupported events so canonical validation never runs off-trigger', () => {
    for (const eventName of ['push', 'pull_request_target', 'merge_group', 'release', '']) {
      assert.throws(() => classifyValidationMode({ eventName, baseRef: 'main', headRef: 'staging' }), /Unsupported validation event/, eventName)
    }
    assert.throws(() => classifyValidationMode({}), /Unsupported validation event/)
    assert.throws(() => classifyValidationMode({ eventName: 'push' }), /Unsupported validation event/)
  })

  it('rejects pull_request classification without base or head refs', () => {
    assert.throws(() => classifyValidationMode({ eventName: 'pull_request', headRef: 'feature/x' }), /requires base_ref/)
    assert.throws(() => classifyValidationMode({ eventName: 'pull_request', baseRef: 'main' }), /requires head_ref/)
    assert.throws(() => classifyValidationMode({ eventName: 'pull_request', baseRef: '', headRef: 'feature/x' }), /requires base_ref/)
    assert.throws(() => classifyValidationMode({ eventName: 'pull_request', baseRef: 'main', headRef: '' }), /requires head_ref/)
  })

  it('rejects unsupported base branches instead of guessing a mode', () => {
    for (const baseRef of ['release', 'dev', 'feature/x', 'refs/heads/staging', 'refs/heads/main']) {
      assert.throws(() => classifyValidationMode({ eventName: 'pull_request', baseRef, headRef: 'feature/x' }), /Unsupported pull_request base branch/, baseRef)
    }
  })

  it('matches only the exact Release Please prefix boundary', () => {
    assert.equal(isReleasePleaseHead(RELEASE_PLEASE_PREFIX), true)
    assert.equal(isReleasePleaseHead(`${RELEASE_PLEASE_PREFIX}--v1.2.3`), true)
    assert.equal(isReleasePleaseHead(`${RELEASE_PLEASE_PREFIX}--v1.2.3--rc.1`), true)
    assert.equal(isReleasePleaseHead(`${RELEASE_PLEASE_PREFIX}--`), true)
    for (const head of [
      `${RELEASE_PLEASE_PREFIX}x`, `${RELEASE_PLEASE_PREFIX}s`, `${RELEASE_PLEASE_PREFIX}-v1.2.3`,
      `${RELEASE_PLEASE_PREFIX}_v1.2.3`, `${RELEASE_PLEASE_PREFIX}/v1.2.3`, `${RELEASE_PLEASE_PREFIX} `,
      ' release-please--branches--main', 'Release-please--branches--main', 'release-please--branches--MAIN',
      'release-please--branches--staging--v1.0.0', 'release-please--branches--mainx', 'main', 'staging', '',
    ]) {
      assert.equal(isReleasePleaseHead(head), false, head)
    }
    assert.equal(isReleasePleaseHead(undefined), false)
    assert.equal(isReleasePleaseHead(null), false)
    assert.equal(isReleasePleaseHead(42), false)
  })

  it('keeps one required-job truth table per mode', () => {
    assert.deepEqual(requiredValidationJobs('fast'), ['ci', 'test'])
    assert.deepEqual(requiredValidationJobs('audit'), ['ci', 'test', 'security', 'codeql'])
    assert.deepEqual(requiredValidationJobs('release'), ['release-policy'])
    assert.deepEqual(VALIDATION_MODES, ['fast', 'audit', 'release'])
    assert.deepEqual(VALIDATION_EVENTS, ['pull_request', 'schedule', 'workflow_dispatch'])
    assert.deepEqual(VALIDATION_JOBS, ['ci', 'test', 'security', 'codeql', 'release-policy'])
    assert.equal(AGGREGATE_CHECK_NAME, 'Validation / Gate')
    assert.throws(() => requiredValidationJobs('unknown'), /Unknown validation mode/)
    assert.throws(() => requiredValidationJobs(), /Unknown validation mode/)
    assert.deepEqual(requiredValidationJobs('fast'), ['ci', 'test'])
  })

  it('passes the gate only when every job required for the mode succeeded', () => {
    assert.deepEqual(evaluateValidationGate({ mode: 'fast', results: { ci: 'success', test: 'success' } }), {
      valid: true,
      required: ['ci', 'test'],
      failures: [],
    })
    assert.deepEqual(evaluateValidationGate({ mode: 'audit', results: { ci: 'success', test: 'success', security: 'success', codeql: 'success' } }), {
      valid: true,
      required: ['ci', 'test', 'security', 'codeql'],
      failures: [],
    })
    assert.deepEqual(evaluateValidationGate({ mode: 'release', results: { 'release-policy': 'success' } }), {
      valid: true,
      required: ['release-policy'],
      failures: [],
    })
  })

  it('lets expected skips of non-required jobs pass the gate', () => {
    assert.equal(evaluateValidationGate({ mode: 'fast', results: { ci: 'success', test: 'success', security: 'skipped', codeql: 'skipped', 'release-policy': 'skipped' } }).valid, true)
    assert.equal(evaluateValidationGate({ mode: 'audit', results: { ci: 'success', test: 'success', security: 'success', codeql: 'success', 'release-policy': 'skipped' } }).valid, true)
    assert.equal(evaluateValidationGate({ mode: 'release', results: { 'release-policy': 'success', ci: 'skipped', test: 'skipped', security: 'skipped', codeql: 'skipped' } }).valid, true)
    // Non-required jobs never influence the gate, even when they fail.
    assert.equal(evaluateValidationGate({ mode: 'fast', results: { ci: 'success', test: 'success', codeql: 'failure' } }).valid, true)
    assert.equal(evaluateValidationGate({ mode: 'fast', results: {} }).valid, false)
  })

  it('fails closed on failure, cancellation, unexpected skip, and unknown results', () => {
    assert.deepEqual(evaluateValidationGate({ mode: 'fast', results: { ci: 'failure', test: 'success' } }), {
      valid: false,
      required: ['ci', 'test'],
      failures: [{ job: 'ci', result: 'failure' }],
    })
    assert.deepEqual(evaluateValidationGate({ mode: 'audit', results: { ci: 'success', test: 'success', security: 'success', codeql: 'cancelled' } }).failures, [
      { job: 'codeql', result: 'cancelled' },
    ])
    assert.deepEqual(evaluateValidationGate({ mode: 'release', results: { 'release-policy': 'skipped' } }).failures, [
      { job: 'release-policy', result: 'skipped' },
    ])
    assert.deepEqual(evaluateValidationGate({ mode: 'fast', results: { ci: 'success', test: 'weird' } }).failures, [
      { job: 'test', result: 'weird' },
    ])
  })

  it('fails closed on missing results and unknown modes', () => {
    assert.deepEqual(evaluateValidationGate({ mode: 'fast', results: { ci: 'success' } }).failures, [{ job: 'test', result: 'missing' }])
    assert.deepEqual(evaluateValidationGate({ mode: 'audit', results: {} }).failures, [
      { job: 'ci', result: 'missing' },
      { job: 'test', result: 'missing' },
      { job: 'security', result: 'missing' },
      { job: 'codeql', result: 'missing' },
    ])
    assert.deepEqual(evaluateValidationGate({ mode: 'fast', results: { ci: 'success', test: null } }).failures, [{ job: 'test', result: 'missing' }])
    assert.deepEqual(evaluateValidationGate({ mode: 'fast', results: { ci: 'success', test: undefined } }).failures, [{ job: 'test', result: 'missing' }])
    const unknown = evaluateValidationGate({ mode: 'unknown', results: {} })
    assert.equal(unknown.valid, false)
    assert.deepEqual(unknown.required, [])
    assert.equal(unknown.failures.length, 1)
    assert.equal(unknown.failures[0].job, 'mode')
    assert.match(unknown.failures[0].result, /Unknown validation mode/)
  })

  it('generates one validation caller with PR, schedule, and dispatch triggers only', () => {
    const caller = readFileSync('.github/workflows/validation_self-ci.yml', 'utf8')
    assert.doesNotMatch(caller, /^  push:/m)
    assert.match(caller, /pull_request:\n\s+branches: \[main, staging\]/)
    assert.match(caller, /schedule:/)
    assert.match(caller, /workflow_dispatch:/)
    assert.match(caller, /code-foundry-validation-\$\{\{ github\.event_name \}\}/)
    assert.match(caller, /cancel-in-progress: true/)
  })

  it('classifies the validation mode through the pinned runtime in the caller', () => {
    const caller = readFileSync('.github/workflows/validation_self-ci.yml', 'utf8')
    assert.match(caller, /FOUNDRY_EVENT_NAME: \$\{\{ github\.event_name \}\}/)
    assert.match(caller, /FOUNDRY_BASE_REF: \$\{\{ github\.event\.pull_request\.base\.ref \}\}/)
    assert.match(caller, /FOUNDRY_HEAD_REF: \$\{\{ github\.event\.pull_request\.head\.ref \}\}/)
    assert.match(caller, /validation mode/)
    assert.match(caller, /mode: \$\{\{ needs\.mode\.outputs\.mode \}\}/)
    assert.match(caller, /uses: \.\/\.github\/workflows\/validation\.yml/)
    assert.match(caller, /secrets:\n\s+TURBO_TOKEN: \$\{\{ secrets\.TURBO_TOKEN \}\}\n\s+NEXTAUTH_SECRET: \$\{\{ secrets\.NEXTAUTH_SECRET \}\}/)
    assert.doesNotMatch(caller, /secrets:\s*inherit/)
    // Least-permission union needed for the CodeQL chain; no extra write scopes.
    assert.match(caller, /security-events: write/)
    assert.doesNotMatch(caller, /pull-requests: write/)
    assert.doesNotMatch(caller, /contents: write/)
  })

  it('passes only consumed secrets through validation workflow-call boundaries', () => {
    const caller = readFileSync('.github/workflows/validation_self-ci.yml', 'utf8')
    const orchestrator = readFileSync('.github/workflows/validation.yml', 'utf8')
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
    const test = readFileSync('.github/workflows/test.yml', 'utf8')
    const security = readFileSync('.github/workflows/security.yml', 'utf8')
    const codeql = readFileSync('.github/workflows/codeql.yml', 'utf8')

    assert.match(caller, /uses: \.\/\.github\/workflows\/validation\.yml/)
    assert.match(caller, /secrets:\n\s+TURBO_TOKEN: \$\{\{ secrets\.TURBO_TOKEN \}\}\n\s+NEXTAUTH_SECRET: \$\{\{ secrets\.NEXTAUTH_SECRET \}\}/)
    assert.doesNotMatch(caller, /secrets:\s*inherit/)

    assert.match(orchestrator, /secrets:\n\s+TURBO_TOKEN:\n\s+required: false\n\s+NEXTAUTH_SECRET:\n\s+required: false/)
    assert.match(ci, /secrets:\n\s+TURBO_TOKEN:\n\s+required: false\n\s+NEXTAUTH_SECRET:\n\s+required: false/)
    assert.match(test, /secrets:\n\s+TURBO_TOKEN:\n\s+required: false/)
    assert.doesNotMatch(test, /NEXTAUTH_SECRET/)
    assert.doesNotMatch(security, /^    secrets:/m)
    assert.doesNotMatch(codeql, /^    secrets:/m)

    assert.match(orchestrator, /ci:\n[\s\S]*?secrets:\n\s+TURBO_TOKEN: \$\{\{ secrets\.TURBO_TOKEN \}\}\n\s+NEXTAUTH_SECRET: \$\{\{ secrets\.NEXTAUTH_SECRET \}\}/)
    assert.match(orchestrator, /test:\n[\s\S]*?secrets:\n\s+TURBO_TOKEN: \$\{\{ secrets\.TURBO_TOKEN \}\}/)
    assert.doesNotMatch(orchestrator, /security:\n[\s\S]*?runner: \$\{\{ inputs\.security-runner \}\}\n\s+secrets:/)
    assert.doesNotMatch(orchestrator, /codeql:\n[\s\S]*?rust-max-parallel: \$\{\{ inputs\.rust-max-parallel \}\}\n\s+secrets:/)
    assert.doesNotMatch(orchestrator, /secrets:\s*inherit/)
  })

  it('requires persist-credentials: false for every external checkout action in workflow YAML', () => {
    const workflowFiles = readdirSync('.github/workflows').filter((file) => file.endsWith('.yml')).sort()

    const violations = workflowFiles.flatMap((workflow) => {
      const path = `.github/workflows/${workflow}`
      return listCheckoutStepsWithoutPersistCredentialsFalse(path)
    })

    assert.equal(violations.length, 0, `checkout actions missing persist-credentials: false:\n${violations.map((entry) => `${entry.file}:${entry.line}`).join('\n')}`)
  })

  it('prepares reconcile transport for staging with optional deploy-key path and fallback auth', () => {
    const release = readFileSync('.github/workflows/release.yml', 'utf8')
    assert.match(release, /STAGING_DEPLOY_KEY:\n\s+required: false/)

    const releaseLines = release.split(/\r?\n/)
    const prepareIndex = releaseLines.findIndex((line) => line.includes('name: Configure staging reconcile transport'))
    const authIndex = releaseLines.findIndex((line) => line.includes('name: Configure git for trusted reconcile'))
    const reconcileIndex = releaseLines.findIndex((line) => line.includes('name: Reconcile release metadata'))
    const clearIndex = releaseLines.findIndex((line) => line.includes('name: Clear reconcile SSH material'))
    const skipIndex = releaseLines.findIndex((line) => line.includes('name: Skip without staging'))

    assert.notEqual(prepareIndex, -1)
    assert.notEqual(authIndex, -1)
    assert.notEqual(reconcileIndex, -1)
    assert.notEqual(clearIndex, -1)
    assert.notEqual(skipIndex, -1)

    const segment = releaseLines.slice(prepareIndex, reconcileIndex + 1).join('\n')
    assert.match(segment, /name: Configure staging reconcile transport[\s\S]*?if: steps\.staging\.outputs\.exists == 'true' && env\.STAGING_DEPLOY_KEY_PRESENT == 'true'/)
    assert.match(segment, /env:\n\s+STAGING_DEPLOY_KEY:\s+\$\{\{ secrets\.STAGING_DEPLOY_KEY \}\}/)
    assert.match(segment, /gh api \/meta/)
    assert.match(segment, /printf '%s\\n' "\$STAGING_DEPLOY_KEY" >/)
    assert.match(segment, /git remote set-url --push origin "git@github.com:\$\{GITHUB_REPOSITORY\}\.git"/)
    assert.match(segment, /name: Configure git for trusted reconcile[\s\S]*?if: steps\.staging\.outputs\.exists == 'true' && env\.STAGING_DEPLOY_KEY_PRESENT != 'true'/)
    assert.match(segment, /run: gh auth setup-git/)

    assert.equal(clearIndex > reconcileIndex, true)
    assert.equal(skipIndex > clearIndex, true)

    assert.equal(prepareIndex < authIndex, true)
    assert.equal(authIndex < reconcileIndex, true)

    const nextStepAfterAuth = releaseLines.findIndex((line, index) => index > authIndex && /^\s{6}- name: /.test(line))
    assert.equal(nextStepAfterAuth, reconcileIndex)

    const reconcileSection = releaseLines.slice(reconcileIndex, clearIndex + 1).join('\n')
    assert.match(reconcileSection, /name: Reconcile release metadata[\s\S]*?GIT_SSH_COMMAND: \$\{\{ steps\.staging-reconcile-ssh\.outputs\.ssh_command \|\| '' \}\}/)
    const prepareSection = releaseLines.slice(prepareIndex, authIndex).join('\n')
    assert.match(prepareSection, /ssh_command=ssh -F \/dev\/null -i \$STAGING_KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=\$STAGING_HOSTS -o StrictHostKeyChecking=yes/)
    assert.match(reconcileSection, /run: node \"\$RUNNER_TEMP\/code-foundry\/src\/cli\.mjs\" release reconcile --github --base main --head staging/)
  })

  it('exposes exactly one stable Validation / Gate aggregate check that always runs', () => {
    const caller = readFileSync('.github/workflows/validation_self-ci.yml', 'utf8')
    const orchestrator = readFileSync('.github/workflows/validation.yml', 'utf8')
    assert.match(caller, /^  validation:\n    name: Validation/m)
    assert.match(orchestrator, /^  gate:\n    name: Gate/m)
    assert.match(orchestrator, /needs: \[ci, test, security, codeql, release-policy\]/)
    assert.match(orchestrator, /if: vars\.CI_BILLING_PAUSED != 'true' && always\(\)/)
    assert.match(orchestrator, /validation gate/)
    assert.match(orchestrator, /FOUNDRY_CI: \$\{\{ needs\.ci\.result \}\}/)
    assert.match(orchestrator, /FOUNDRY_RELEASE_POLICY: \$\{\{ needs\.release-policy\.result \}\}/)
    assert.doesNotMatch(orchestrator, /^on:\n  push:/m)
  })

  it('runs only the mode-required tier jobs in the orchestrator', () => {
    const orchestrator = readFileSync('.github/workflows/validation.yml', 'utf8')
    for (const job of ['ci', 'test', 'security', 'codeql', 'release-policy']) {
      assert.match(orchestrator, new RegExp(`^  ${job}:`, 'm'))
    }
    assert.match(orchestrator, /if: vars\.CI_BILLING_PAUSED != 'true' && \(inputs.mode == 'fast' \|\| inputs.mode == 'audit'\)/)
    assert.match(orchestrator, /if: vars\.CI_BILLING_PAUSED != 'true' && inputs.mode == 'audit'/)
    assert.match(orchestrator, /if: vars\.CI_BILLING_PAUSED != 'true' && inputs.mode == 'release'/)
    assert.match(orchestrator, /unit-only: \$\{\{ inputs.mode == 'fast' \}\}/)
    assert.match(orchestrator, /validation release_diff/)
    assert.match(orchestrator, /ci:\n[\s\S]*?secrets:\n\s+TURBO_TOKEN: \$\{\{ secrets\.TURBO_TOKEN \}\}\n\s+NEXTAUTH_SECRET: \$\{\{ secrets\.NEXTAUTH_SECRET \}\}/)
    assert.match(orchestrator, /test:\n[\s\S]*?secrets:\n\s+TURBO_TOKEN: \$\{\{ secrets\.TURBO_TOKEN \}\}/)
    assert.doesNotMatch(orchestrator, /secrets:\s*inherit/)
    assert.match(orchestrator, /FOUNDRY_HEAD_REPO: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}/)
    assert.match(orchestrator, /FOUNDRY_REPOSITORY: \$\{\{ github\.repository \}\}/)
  })

  it('pins all external workflow/action refs to approved immutable SHAs', () => {
    const workflows = [
      '.github/workflows/validation_self-ci.yml',
      '.github/workflows/validation.yml',
      '.github/workflows/ci.yml',
      '.github/workflows/test.yml',
      '.github/workflows/security.yml',
      '.github/workflows/codeql.yml',
      '.github/workflows/release.yml',
      '.github/workflows/release-pr.yml',
      '.github/workflows/opencode-security_self-ci.yml',
    ].reduce((acc, file) => acc + readFileSync(file), '')

    const approvedRefs = new Set([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      'github/codeql-action/init@5595ccaf912efad79be6eef63a5619ff05969be3',
      'github/codeql-action/analyze@5595ccaf912efad79be6eef63a5619ff05969be3',
      'googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7',
      'taiki-e/install-action@cb33e69fad06166ca28a42b2575e4dadabf62ee8',
      'actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294',
      '0xPlayerOne/opencode-security/.github/workflows/opencode-security.yml@b3dce823322672b285fbe99b870ea984c01826cb',
    ])

    const externalPins = workflows.match(/^\s*uses:\s+(?!\.\/)(\S+@\S+)(?:\s+#\s+\S+)?\s*$/gm) ?? []
    assert.ok(externalPins.length > 0, 'expected at least one external workflow/action pin')
    for (const line of externalPins) {
      const pin = line.trim().replace(/^uses:\s+/, '')
      assert.match(pin, /@[0-9a-f]{40}\s+#\s+\S+$/, `external ref is not an immutable SHA: ${pin}`)
      const reference = pin.split(/\s+#/, 1)[0]
      assert.ok(approvedRefs.has(reference), `external ref is not approved: ${pin}`)
    }

    assert.doesNotMatch(workflows, /uses: actions\/checkout@v[0-9]+/)
    assert.doesNotMatch(workflows, /uses: actions\/setup-node@v[0-9]+/)
    assert.doesNotMatch(workflows, /uses: actions\/upload-artifact@v[0-9]+/)
    assert.doesNotMatch(workflows, /uses: github\/codeql-action\/(init|analyze)@v[0-9]+/)
    assert.doesNotMatch(workflows, /uses: googleapis\/release-please-action@v[0-9]+/)
    assert.doesNotMatch(workflows, /uses: taiki-e\/install-action@v[0-9]+/)
    assert.doesNotMatch(workflows, /uses: actions\/dependency-review-action@v[0-9]+/)
    assert.doesNotMatch(workflows, /uses: 0xPlayerOne\/opencode-security\/\.github\/workflows\/opencode-security\.yml@main/)
  })

  it('keeps the reusable test interface backward compatible with an additive unit-only input', () => {
    const test = readFileSync('.github/workflows/test.yml', 'utf8')
    assert.match(test, /unit-only:\n\s+description:/)
    assert.match(test, /type: boolean/)
    assert.match(test, /default: false/)
    for (const job of ['integration', 'e2e', 'smoke']) {
      assert.match(test, new RegExp(`^  ${job}:\n    name: [A-Za-z0-9]+\n    if: vars\\.CI_BILLING_PAUSED != 'true' && inputs\\.unit-only != true`, 'm'))
    }
    for (const input of ['runtime-repository', 'runtime-ref', 'runner', 'unit-runner']) {
      assert.match(test, new RegExp(`^      ${input}:`, 'm'))
    }
  })

  it('classifies real event metadata through the runtime mode task', () => {
    const run = (env) => spawnSync(process.execPath, [runtime, 'validation', 'mode'], {
      encoding: 'utf8',
      env: { ...testEnv, ...env },
    })
    assert.match(run({ FOUNDRY_EVENT_NAME: 'pull_request', FOUNDRY_BASE_REF: 'staging', FOUNDRY_HEAD_REF: 'feature/x' }).stdout, /^mode=fast$/m)
    assert.match(run({ FOUNDRY_EVENT_NAME: 'pull_request', FOUNDRY_BASE_REF: 'main', FOUNDRY_HEAD_REF: 'release-please--branches--main--v1.2.3' }).stdout, /^mode=release$/m)
    assert.match(run({ FOUNDRY_EVENT_NAME: 'pull_request', FOUNDRY_BASE_REF: 'main', FOUNDRY_HEAD_REF: 'staging' }).stdout, /^mode=audit$/m)
    assert.match(run({ FOUNDRY_EVENT_NAME: 'pull_request', FOUNDRY_BASE_REF: 'main', FOUNDRY_HEAD_REF: 'feature/x' }).stdout, /^mode=audit$/m)
    assert.match(run({ FOUNDRY_EVENT_NAME: 'workflow_dispatch' }).stdout, /^mode=audit$/m)
    assert.match(run({ FOUNDRY_EVENT_NAME: 'schedule' }).stdout, /^mode=audit$/m)
    const push = run({ FOUNDRY_EVENT_NAME: 'push', FOUNDRY_BASE_REF: 'main', FOUNDRY_HEAD_REF: 'staging' })
    assert.notEqual(push.status, 0)
    assert.match(push.stderr, /Unsupported validation event/)
  })

  it('evaluates the aggregate gate through the runtime gate task', () => {
    const run = (env) => spawnSync(process.execPath, [runtime, 'validation', 'gate'], {
      encoding: 'utf8',
      env: { ...testEnv, ...env },
    })
    const audit = run({ FOUNDRY_MODE: 'audit', FOUNDRY_CI: 'success', FOUNDRY_TEST: 'success', FOUNDRY_SECURITY: 'success', FOUNDRY_CODEQL: 'success', FOUNDRY_RELEASE_POLICY: 'skipped' })
    assert.equal(audit.status, 0)
    assert.match(audit.stdout, /gate passed/)
    const fast = run({ FOUNDRY_MODE: 'fast', FOUNDRY_CI: 'success', FOUNDRY_TEST: 'success', FOUNDRY_SECURITY: 'skipped', FOUNDRY_CODEQL: 'skipped', FOUNDRY_RELEASE_POLICY: 'skipped' })
    assert.equal(fast.status, 0)
    const release = run({ FOUNDRY_MODE: 'release', FOUNDRY_CI: 'skipped', FOUNDRY_TEST: 'skipped', FOUNDRY_SECURITY: 'skipped', FOUNDRY_CODEQL: 'skipped', FOUNDRY_RELEASE_POLICY: 'success' })
    assert.equal(release.status, 0)
    const failed = run({ FOUNDRY_MODE: 'fast', FOUNDRY_CI: 'failure', FOUNDRY_TEST: 'success', FOUNDRY_SECURITY: 'skipped', FOUNDRY_CODEQL: 'skipped', FOUNDRY_RELEASE_POLICY: 'skipped' })
    assert.notEqual(failed.status, 0)
    assert.match(failed.stderr, /::error::ci: failure/)
    const cancelled = run({ FOUNDRY_MODE: 'audit', FOUNDRY_CI: 'success', FOUNDRY_TEST: 'success', FOUNDRY_SECURITY: 'success', FOUNDRY_CODEQL: 'cancelled', FOUNDRY_RELEASE_POLICY: 'skipped' })
    assert.notEqual(cancelled.status, 0)
    assert.match(cancelled.stderr, /::error::codeql: cancelled/)
    const unknown = run({ FOUNDRY_MODE: 'bogus', FOUNDRY_CI: 'success', FOUNDRY_TEST: 'success', FOUNDRY_SECURITY: 'success', FOUNDRY_CODEQL: 'success', FOUNDRY_RELEASE_POLICY: 'success' })
    assert.notEqual(unknown.status, 0)
    assert.match(unknown.stderr, /Unknown validation mode/)
  })

  it('enforces the strict generated-release diff and version policy', () => {
    const base = { headRef: 'release-please--branches--main--v1.0.0', headRepo: 'owner/repo', repository: 'owner/repo' }
    assert.equal(validateGeneratedReleaseDiff({ ...base, changedPaths: ['package.json', 'CHANGELOG.md'] }).valid, true)
    const unexpected = validateGeneratedReleaseDiff({ ...base, changedPaths: ['package.json', 'src/index.ts'] })
    assert.equal(unexpected.valid, false)
    assert.match(unexpected.errors.join(' '), /unexpected paths: src\/index\.ts/)
    assert.equal(validateGeneratedReleaseDiff({ ...base, headRef: 'release-please--branches--mainx--v1.0.0', changedPaths: ['package.json'] }).valid, false)
    assert.equal(validateGeneratedReleaseDiff({ ...base, headRepo: 'evil/fork', changedPaths: ['package.json'] }).valid, false)
    // Missing repository identity fails closed, not just mismatched identity.
    assert.equal(validateGeneratedReleaseDiff({ ...base, headRepo: '', changedPaths: ['package.json'] }).valid, false)
    assert.equal(validateGeneratedReleaseDiff({ ...base, repository: '', changedPaths: ['package.json'] }).valid, false)
    assert.equal(validateGeneratedReleaseDiff({ ...base, headRepo: undefined, repository: undefined, changedPaths: ['package.json'] }).valid, false)
    assert.equal(validateGeneratedReleaseDiff({ ...base, changedPaths: [] }).valid, false)
    const noBump = validateGeneratedReleaseDiff({ ...base, changedPaths: ['CHANGELOG.md'] })
    assert.equal(noBump.valid, false)
    assert.match(noBump.errors.join(' '), /no version metadata/)
    const extraFile = validateGeneratedReleaseDiff({
      ...base,
      changedPaths: ['src/version.ts', 'CHANGELOG.md'],
      config: { 'extra-files': ['src/version.ts'] },
    })
    assert.equal(extraFile.valid, true)
    assert.deepEqual(extraFile.changedPaths, ['src/version.ts', 'CHANGELOG.md'])
  })

  it('rejects generated release diffs with a stale configured Cargo.lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-cargo-release-'))
    const desktopRoot = join(root, 'apps', 'desktop', 'src-tauri')
    mkdirSync(desktopRoot, { recursive: true })
    writeFileSync(join(desktopRoot, 'Cargo.toml'), '[package]\nname = "agent-hq-desktop"\nversion = "0.3.2"\n')
    writeFileSync(join(desktopRoot, 'Cargo.lock'), '# generated\n\n[[package]]\nname = "agent-hq-desktop"\nversion = "0.3.1"\n')
    const config = { 'extra-files': [{ type: 'generic', path: 'apps/desktop/src-tauri/Cargo.lock' }] }
    const errors = validateCargoLockVersions(root, config)
    assert.match(errors.join(' '), /Cargo\.lock version 0\.3\.1 does not match .*Cargo\.toml version 0\.3\.2/)
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
    const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    git(['init', '-q'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'base'])
    const baseSha = git(['rev-parse', 'HEAD']).stdout.trim()
    git(['checkout', '-q', '-b', 'release-please--branches--main--v1.0.0'])
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.1.0"}\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'chore(main): release 1.1.0'])
    const run = (env) => spawnSync(process.execPath, [runtime, 'validation', 'release_diff'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...testEnv, ...env },
    })
    const valid = run({ FOUNDRY_BASE_SHA: baseSha, FOUNDRY_HEAD_REF: 'release-please--branches--main--v1.0.0', FOUNDRY_HEAD_REPO: 'owner/repo', FOUNDRY_REPOSITORY: 'owner/repo' })
    assert.equal(valid.status, 0, valid.stderr)
    assert.match(valid.stdout, /Release policy passed/)
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src/index.ts'), 'export const value = 1\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'sneak'])
    const sneaky = run({ FOUNDRY_BASE_SHA: baseSha, FOUNDRY_HEAD_REF: 'release-please--branches--main--v1.0.0', FOUNDRY_HEAD_REPO: 'owner/repo', FOUNDRY_REPOSITORY: 'owner/repo' })
    assert.notEqual(sneaky.status, 0)
    assert.match(sneaky.stderr, /unexpected paths: src\/index\.ts/)
    const fork = run({ FOUNDRY_BASE_SHA: baseSha, FOUNDRY_HEAD_REF: 'release-please--branches--main--v1.0.0', FOUNDRY_HEAD_REPO: 'evil/fork', FOUNDRY_REPOSITORY: 'owner/repo' })
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
    assert.deepEqual(plan.pendingReleasePullRequests, [{ number: 9, title: 'chore(main): release 1.1.0' }])
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
