import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { discoverRepositories } from '../src/commands/fleet-core.mjs'
import { upgradeFleet } from '../src/commands/fleet.mjs'
import { syncRepository } from '../src/commands/sync.mjs'
import {
  configDrift,
  discoverManifestRepositories,
  executeFleetCommand,
  fleetPath,
  githubRemote,
  readFleetManifest,
  rolloutIdentity,
  upgradeManifestFleet,
  verifiedPullRequest,
} from '../src/lib/fleet-manifest.mjs'

const version = 'v1.1.0'
const gate = { name: 'Validation / Gate', status: 'COMPLETED', conclusion: 'SUCCESS' }
const entry = (name, cohort = 'canary') => ({
  repository: `test/${name}`,
  path: name,
  cohort,
  validation: [[process.execPath, '-e', 'process.exit(0)']],
  requiredChecks: ['Validation / Gate'],
})

function fixture(t, entries = [entry('a')]) {
  const root = mkdtempSync(join(tmpdir(), 'foundry-fleet-test-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    process.exitCode = 0
  })
  const manifest = {
    schemaVersion: 1,
    cohorts: [...new Set(entries.map((item) => item.cohort))],
    repositories: entries,
  }
  writeFileSync(join(root, 'code-foundry-fleet.json'), JSON.stringify(manifest))
  return {
    root,
    manifest,
    save: () => writeFileSync(join(root, 'code-foundry-fleet.json'), JSON.stringify(manifest)),
  }
}

function git(path, ...args) {
  return execFileSync('git', args, {
    cwd: path,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function repository(root, name) {
  const path = join(root, name)
  const remote = join(root, `${name}.git`)
  mkdirSync(path)
  git(root, 'init', '--bare', '--initial-branch=main', remote)
  git(path, 'init', '--initial-branch=main')
  git(path, 'config', 'user.name', 'Fixture')
  git(path, 'config', 'user.email', 'fixture@example.invalid')
  mkdirSync(join(path, '.github'))
  writeFileSync(
    join(path, '.github/code-foundry.yml'),
    'runtime_ref: v1.0.0\ngit_workflow: direct\n'
  )
  git(path, 'add', '.')
  git(path, 'commit', '-m', 'fixture')
  git(path, 'remote', 'add', 'origin', remote)
  git(path, 'push', '-u', 'origin', 'main')
  return path
}

function synchronize({ target, runtimeRef }) {
  writeFileSync(
    join(target, '.github/code-foundry.yml'),
    `runtime_ref: ${runtimeRef}\ngit_workflow: direct\n`
  )
  return { changed: ['.github/code-foundry.yml'] }
}

/** @param {string} [stdout] */
function okResult(stdout = '') {
  return { status: 0, stdout, stderr: '' }
}

function runner(prs = new Map()) {
  const calls = []
  let failCreate = false
  const invoke = (cwd, argv) => {
    calls.push({ cwd, argv })
    if (argv[0] === 'git' && argv[1] === 'remote' && argv[2] === 'get-url')
      return okResult(`https://github.com/test/${cwd.split('/').at(-1)}.git`)
    if (argv[0] !== 'gh') return executeFleetCommand(cwd, argv)
    const repo = argv[argv.indexOf('--repo') + 1]
    if (argv[1] === 'pr' && argv[2] === 'list') return okResult(JSON.stringify(prs.get(repo) ?? []))
    if (argv[1] === 'pr' && argv[2] === 'view') {
      const pullRequest = (prs.get(repo) ?? []).find((item) => item.url === argv[3])
      return okResult(JSON.stringify(pullRequest ?? {}))
    }
    if (argv[1] === 'pr' && argv[2] === 'create') {
      if (failCreate) return { status: 1, stdout: '', stderr: 'simulated PR outage' }
      assert.ok(argv.includes('--draft'))
      const branch = argv[argv.indexOf('--head') + 1]
      const pr = {
        url: `https://github.com/${repo}/pull/1`,
        body: argv[argv.indexOf('--body') + 1],
        headRefName: branch,
        baseRefName: 'main',
        headRefOid: git(cwd, 'rev-parse', branch),
        isCrossRepository: false,
        isDraft: true,
        state: 'OPEN',
        statusCheckRollup: [],
      }
      prs.set(repo, [pr])
      return okResult(pr.url)
    }
    if (argv[1] === 'api')
      return okResult(
        JSON.stringify({
          encoding: 'base64',
          content: Buffer.from(`runtime_ref: ${version}\ngit_workflow: direct\n`).toString(
            'base64'
          ),
        })
      )
    throw new Error(`Unexpected fixture command ${argv}`)
  }
  return {
    run: invoke,
    calls,
    prs,
    failCreate: (value) => {
      failCreate = value
    },
  }
}

for (const [label, mutate] of [
  [
    'schema',
    (m) => {
      m.schemaVersion = 2
    },
  ],
  [
    'cohort',
    (m) => {
      m.repositories[0].cohort = 'unknown'
    },
  ],
  [
    'duplicate',
    (m) => {
      m.repositories.push(m.repositories[0])
    },
  ],
  [
    'validation',
    (m) => {
      m.repositories[0].validation = []
    },
  ],
  [
    'shell string',
    (m) => {
      m.repositories[0].validation = ['node test.mjs']
    },
  ],
  [
    'expired exception',
    (m) => {
      m.repositories[0].exception = { reason: 'delay', expires: '2001-01-01' }
    },
  ],
  [
    'invalid expected',
    (m) => {
      m.repositories[0].expected = { coverage_minimum: 80 }
    },
  ],
]) {
  test(`invalid manifest is rejected: ${label}`, (t) => {
    const f = fixture(t)
    mutate(f.manifest)
    f.save()
    assert.throws(() => readFleetManifest(f.root))
  })
}

test('paths reject traversal, absolute paths, root, and symlinks', (t) => {
  const { root } = fixture(t)
  for (const path of ['..', '/', '.']) assert.throws(() => fleetPath(root, path))
  symlinkSync('/tmp', join(root, 'outside'))
  assert.throws(() => fleetPath(root, 'outside/repo'))
})

test('GitHub remote matching does not accept unrelated hosts', () => {
  assert.equal(githubRemote('git@github.com:test/repo.git'), 'test/repo')
  assert.equal(githubRemote('https://github.com/test/repo.git'), 'test/repo')
  assert.equal(githubRemote('https://evil.example/test/repo.git'), '')
})

test('config audit exposes expected values and missing requirements', () => {
  assert.deepEqual(
    configDrift(
      { runtime_ref: 'v1.0.0' },
      { ...entry('a'), expected: { runtime_ref: version }, requiredCapabilities: ['unit'] }
    ),
    [
      { key: 'runtime_ref', expected: version, observed: 'v1.0.0' },
      { key: 'required_capabilities:unit', expected: 'declared', observed: 'missing' },
    ]
  )
})

test('discovery keeps missing inventory entries visible as blocked', (t) => {
  const { root } = fixture(t)
  assert.equal(discoverManifestRepositories(root)[0].status, 'blocked')
})

test('only merged PRs with actual successful required checks unlock rollout', () => {
  const good = {
    state: 'MERGED',
    isCrossRepository: false,
    headRefOid: 'a'.repeat(40),
    statusCheckRollup: [gate],
  }
  assert.equal(verifiedPullRequest(good, ['Validation / Gate']), true)
  for (const change of [
    { state: 'OPEN' },
    { isCrossRepository: true },
    { headRefOid: '' },
    { statusCheckRollup: [] },
    { statusCheckRollup: [{ ...gate, conclusion: 'SKIPPED' }] },
    { statusCheckRollup: [gate, { name: 'other', status: 'IN_PROGRESS' }] },
  ]) {
    assert.equal(verifiedPullRequest({ ...good, ...change }, ['Validation / Gate']), false)
  }
})

test('policy changes produce different resumable identities', () => {
  assert.notEqual(
    rolloutIdentity(entry('a'), version, 'main').id,
    rolloutIdentity({ ...entry('a'), validation: [['node', 'different.mjs']] }, version, 'main').id
  )
})

test('creates a draft canary PR, leaves original clean, and blocks later cohorts', (t) => {
  const a = entry('a')
  a.validation.push([
    process.execPath,
    '-e',
    "require('fs').writeFileSync('untracked-result.txt','evidence')",
  ])
  const { root } = fixture(t, [a, entry('b', 'apps')])
  const original = repository(root, 'a')
  repository(root, 'b')
  const fake = runner()
  const report = upgradeManifestFleet(
    root,
    root,
    { version, createPr: true },
    synchronize,
    fake.run
  )
  assert.deepEqual(
    report.map((item) => item.status),
    ['pr-created', 'blocked']
  )
  assert.match(readFileSync(join(original, '.github/code-foundry.yml'), 'utf8'), /v1.0.0/)
  assert.equal(git(original, 'status', '--porcelain'), '')
  const branch = report[0].branch
  assert.doesNotMatch(git(original, 'ls-tree', '-r', '--name-only', branch), /untracked-result/)
  assert.equal(fake.calls.filter((call) => call.argv.includes('create')).length, 1)
})

test('isolated sync does not alter the original checkout Git config', (t) => {
  const { root } = fixture(t)
  const original = repository(root, 'a')
  const fake = runner()
  const report = upgradeManifestFleet(
    root,
    process.cwd(),
    { version, createPr: true },
    syncRepository,
    fake.run
  )
  assert.equal(report[0].status, 'pr-created')
  let hooksPath = ''
  try {
    hooksPath = git(original, 'config', '--local', '--get', 'core.hooksPath')
  } catch {}
  assert.equal(hooksPath, '')
})

test('failed validation stops the entire rollout before pushing', (t) => {
  const a = entry('a')
  a.validation = [[process.execPath, '-e', 'process.exit(7)']]
  const { root } = fixture(t, [a, entry('b', 'apps')])
  repository(root, 'a')
  repository(root, 'b')
  const fake = runner()
  const report = upgradeManifestFleet(
    root,
    root,
    { version, createPr: true },
    synchronize,
    fake.run
  )
  assert.deepEqual(
    report.map((item) => item.status),
    ['failed', 'blocked']
  )
  assert.equal(
    fake.calls.some((call) => call.argv.includes('push') || call.argv.includes('create')),
    false
  )
})

test('repeated rollout reuses an open PR without recreating worktrees or PRs', (t) => {
  const { root } = fixture(t)
  repository(root, 'a')
  const fake = runner()
  upgradeManifestFleet(root, root, { version, createPr: true }, synchronize, fake.run)
  const before = fake.calls.length
  const report = upgradeManifestFleet(
    root,
    root,
    { version, createPr: true },
    synchronize,
    fake.run
  )
  assert.equal(report[0].status, 'pr-existing')
  assert.equal(
    fake.calls
      .slice(before)
      .some((call) => call.argv.includes('worktree') || call.argv.includes('create')),
    false
  )
})

test('orphan pushed managed branch resumes after PR creation failure without force', (t) => {
  const { root } = fixture(t)
  repository(root, 'a')
  const fake = runner()
  fake.failCreate(true)
  assert.equal(
    upgradeManifestFleet(root, root, { version, createPr: true }, synchronize, fake.run)[0].status,
    'failed'
  )
  fake.failCreate(false)
  const report = upgradeManifestFleet(
    root,
    root,
    { version, createPr: true },
    synchronize,
    fake.run
  )
  assert.equal(report[0].status, 'pr-resumed')
  assert.equal(
    fake.calls.some((call) => call.argv.includes('push') && call.argv.includes('--force')),
    false
  )
})

test('legacy discovery does not inspect organization-specific nested directories', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'foundry-fleet-legacy-discovery-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const nested = join(root, 'NiftyLeague', 'consumer')
  mkdirSync(join(nested, '.git'), { recursive: true })
  writeFileSync(join(nested, '.github-placeholder'), '')

  assert.deepEqual(discoverRepositories(root), [])
})

test('legacy fleet resumes a pushed branch after pull request creation failure', (t) => {
  const { root } = fixture(t)
  rmSync(join(root, 'code-foundry-fleet.json'))
  repository(root, 'a')
  const toolDir = mkdtempSync(join(tmpdir(), 'code-foundry-fake-gh-'))
  const gh = join(toolDir, 'gh')
  writeFileSync(
    gh,
    `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '[]\\n'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  if [ "\${FAIL_CREATE:-0}" = "1" ]; then
    printf 'simulated PR outage\\n' >&2
    exit 1
  fi
  printf 'https://github.com/test/a/pull/1\\n'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  sha=$(git -C "\${FLEET_REPO}" rev-parse "\${FLEET_BRANCH}")
  printf '{"headRefOid":"%s","headRefName":"%s","baseRefName":"main","isCrossRepository":false,"isDraft":true}\\n' "$sha" "\${FLEET_BRANCH}"
  exit 0
fi
printf 'unexpected gh command: %s\\n' "$*" >&2
exit 1
`
  )
  chmodSync(gh, 0o755)
  const originalPath = process.env.PATH
  const runtimeVersion = `v${JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version}`
  const branch = `codex/code-foundry-upgrade-${runtimeVersion.replace(/^v/, '')}`
  const repositoryPath = join(root, 'a')
  process.env.PATH = `${toolDir}:${originalPath}`
  process.env.FAIL_CREATE = '1'
  process.env.FLEET_REPO = repositoryPath
  process.env.FLEET_BRANCH = branch
  try {
    const first = upgradeFleet(root, process.cwd(), { version: runtimeVersion, createPr: true })
    assert.equal(first[0].status, 'failed')
    const pushed = git(repositoryPath, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`)
    assert.match(pushed, /\b[0-9a-f]{40}\b/)

    process.env.FAIL_CREATE = '0'
    const second = upgradeFleet(root, process.cwd(), { version: runtimeVersion, createPr: true })
    assert.equal(second[0].status, 'pr-resumed')
  } finally {
    process.env.PATH = originalPath
    delete process.env.FAIL_CREATE
    delete process.env.FLEET_REPO
    delete process.env.FLEET_BRANCH
    rmSync(toolDir, { recursive: true, force: true })
  }
})

test('verified merged canary and current matching config unlock next cohort', (t) => {
  const { root } = fixture(t, [entry('a'), entry('b', 'apps')])
  repository(root, 'a')
  repository(root, 'b')
  const fake = runner()
  upgradeManifestFleet(root, root, { version, createPr: true }, synchronize, fake.run)
  Object.assign(fake.prs.get('test/a')[0], {
    state: 'MERGED',
    isDraft: false,
    statusCheckRollup: [gate],
  })
  const report = upgradeManifestFleet(
    root,
    root,
    { version, createPr: true },
    synchronize,
    fake.run
  )
  assert.deepEqual(
    report.map((item) => item.status),
    ['verified-merged', 'pr-created']
  )
})

test('dirty original is blocked even when force is requested', (t) => {
  const { root } = fixture(t)
  const path = repository(root, 'a')
  writeFileSync(join(path, 'user-work.txt'), 'keep')
  const fake = runner()
  const report = upgradeManifestFleet(
    root,
    root,
    { version, createPr: true, force: true },
    synchronize,
    fake.run
  )
  assert.equal(report[0].status, 'failed')
  assert.equal(readFileSync(join(path, 'user-work.txt'), 'utf8'), 'keep')
})

test('validation cannot silently rewrite the candidate', (t) => {
  const a = entry('a')
  a.validation = [
    [
      process.execPath,
      '-e',
      "require('fs').appendFileSync('.github/code-foundry.yml','changed: true\\n')",
    ],
  ]
  const { root } = fixture(t, [a])
  repository(root, 'a')
  const fake = runner()
  const report = upgradeManifestFleet(
    root,
    root,
    { version, createPr: true },
    synchronize,
    fake.run
  )
  assert.equal(report[0].status, 'failed')
  assert.match(report[0].reason, /modified the candidate/)
})

test('excluding every canary does not bypass its gate', (t) => {
  const { root } = fixture(t, [entry('a'), entry('b', 'apps')])
  repository(root, 'a')
  repository(root, 'b')
  const fake = runner()
  const report = upgradeManifestFleet(
    root,
    root,
    { version, createPr: true, exclude: ['test/a'] },
    synchronize,
    fake.run
  )
  assert.deepEqual(
    report.map((item) => item.status),
    ['excepted', 'blocked']
  )
})

test('absolute exclusions do not count toward a partially completed cohort', (t) => {
  const { root } = fixture(t, [entry('a'), entry('c'), entry('b', 'apps')])
  repository(root, 'a')
  repository(root, 'c')
  repository(root, 'b')
  const fake = runner()
  const absolutePath = join(root, 'a')
  let report = upgradeManifestFleet(
    root,
    root,
    { version, createPr: true, exclude: [absolutePath] },
    synchronize,
    fake.run
  )
  assert.deepEqual(
    report.map((item) => item.status),
    ['excepted', 'pr-created', 'blocked']
  )
  Object.assign(fake.prs.get('test/c')[0], {
    state: 'MERGED',
    isDraft: false,
    statusCheckRollup: [gate],
  })
  report = upgradeManifestFleet(
    root,
    root,
    { version, createPr: true, exclude: [absolutePath] },
    synchronize,
    fake.run
  )
  assert.deepEqual(
    report.map((item) => item.status),
    ['excepted', 'verified-merged', 'pr-created']
  )
})

test('dry-run performs no network or source mutation', (t) => {
  const { root } = fixture(t)
  const path = repository(root, 'a')
  const fake = runner()
  const report = upgradeManifestFleet(
    root,
    root,
    { version, dryRun: true },
    () => {
      throw new Error('must not sync')
    },
    fake.run
  )
  assert.equal(report[0].status, 'preview')
  assert.equal(
    fake.calls.some(
      (call) => call.argv[0] === 'gh' || call.argv.includes('fetch') || call.argv.includes('push')
    ),
    false
  )
  assert.equal(git(path, 'status', '--porcelain'), '')
})

test('manifest mode refuses implicit in-place updates', (t) => {
  const { root } = fixture(t)
  assert.throws(() => upgradeManifestFleet(root, root, { version }, synchronize), /in-place/)
})
