import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bunLockVersionDrift,
  lockedWorkspaces,
  syncBunLockWorkspaceVersions,
  validateBunLockVersions,
} from '../src/lib/bun-lock.mjs'
import { validateGeneratedReleaseDiff } from '../src/lib/release-policy.mjs'

const cli = new URL('../src/cli.mjs', import.meta.url).pathname
const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')

// The shape bun writes: the root has no version, workspaces carry the version
// from their manifest, and the packages section after them is never touched.
const lock = (version) => `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "agent-sim",
      "devDependencies": {
        "code-foundry": "1.48.6",
      },
    },
    "packages/architecture": {
      "name": "@agent-sim/architecture",
      "version": "${version}",
    },
    "packages/characters": {
      "name": "@agent-sim/characters",
      "version": "${version}",
      "dependencies": {
        "@agent-sim/scene-fields": "workspace:*",
        "three": "^0.186.1",
      },
    },
    "scenes/sim": {
      "name": "@agent-sim/sim",
      "version": "${version}",
    },
  },
  "packages": {
    "@agent-sim/architecture": ["@agent-sim/architecture@workspace:packages/architecture"],
    "three": ["three@0.186.1", "", {}, "sha512-aaaa"],
  },
}
`

const workspaces = ['packages/architecture', 'packages/characters', 'scenes/sim']

function project(t, { lockVersion, manifestVersion, lockText = lock(lockVersion) }) {
  const root = mkdtempSync(join(tmpdir(), 'foundry-bun-lock-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'bun.lock'), lockText)
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'agent-sim', version: manifestVersion })
  )
  for (const path of workspaces) {
    mkdirSync(join(root, path), { recursive: true })
    writeFileSync(
      join(root, path, 'package.json'),
      JSON.stringify({ name: `@agent-sim/${path.split('/').pop()}`, version: manifestVersion })
    )
  }
  return root
}

test('reads the workspace versions a bun.lock records', () => {
  assert.deepEqual(
    lockedWorkspaces(lock('0.15.10')).map(({ path, name, version }) => ({ path, name, version })),
    workspaces.map((path, index) => ({
      path,
      name: ['@agent-sim/architecture', '@agent-sim/characters', '@agent-sim/sim'][index],
      version: '0.15.10',
    }))
  )
})

test('does not read versions outside the workspaces section', () => {
  const text = lock('0.15.10').replace(
    '"three": ["three@0.186.1"',
    '"version": "9.9.9", "x": ["three@0.186.1"'
  )
  assert.equal(lockedWorkspaces(text).length, 3)
})

test('reports a lock left at the previous release version', (t) => {
  // Release PR #147 in agent-sim: every manifest says 0.15.14, bun.lock says 0.15.10.
  const root = project(t, { lockVersion: '0.15.10', manifestVersion: '0.15.14' })
  assert.equal(bunLockVersionDrift(root).length, 3)
  const [message] = validateBunLockVersions(root)
  assert.match(message, /3 workspace version\(s\) that differ from package\.json/)
  assert.match(
    message,
    /packages\/architecture \(@agent-sim\/architecture\) is 0\.15\.10 in bun\.lock but 0\.15\.14 in package\.json/
  )
  assert.match(message, /release sync-lock/)
})

test('accepts a lock that matches its manifests', (t) => {
  const root = project(t, { lockVersion: '0.15.14', manifestVersion: '0.15.14' })
  assert.deepEqual(validateBunLockVersions(root), [])
})

test('ignores a missing lock, a missing manifest and a manifest without a version', (t) => {
  const root = project(t, { lockVersion: '0.15.10', manifestVersion: '0.15.14' })
  rmSync(join(root, 'packages/architecture/package.json'))
  writeFileSync(join(root, 'packages/characters/package.json'), JSON.stringify({ name: 'x' }))
  assert.deepEqual(
    bunLockVersionDrift(root).map((entry) => entry.path),
    ['scenes/sim']
  )
  rmSync(join(root, 'bun.lock'))
  assert.deepEqual(validateBunLockVersions(root), [])
})

test('the generated-release gate fails on the stale lock a release leaves behind', (t) => {
  const input = {
    headRef: 'release-please--branches--main',
    headRepo: 'owner/repo',
    repository: 'owner/repo',
    changedPaths: ['package.json', '.release-please-manifest.json', 'CHANGELOG.md'],
  }
  const stale = project(t, { lockVersion: '0.15.10', manifestVersion: '0.15.14' })
  const result = validateGeneratedReleaseDiff({ ...input, root: stale })
  assert.equal(result.valid, false)
  assert.match(result.errors.join(' '), /bun\.lock records 3 workspace version/)

  const synced = project(t, { lockVersion: '0.15.14', manifestVersion: '0.15.14' })
  assert.equal(validateGeneratedReleaseDiff({ ...input, root: synced }).valid, true)
})

test('syncing rewrites only the drifted version values', (t) => {
  const root = project(t, { lockVersion: '0.15.10', manifestVersion: '0.15.14' })
  const changes = syncBunLockWorkspaceVersions(root)
  assert.deepEqual(
    changes.map(({ path, from, to }) => ({ path, from, to })),
    workspaces.map((path) => ({ path, from: '0.15.10', to: '0.15.14' }))
  )
  assert.equal(readFileSync(join(root, 'bun.lock'), 'utf8'), lock('0.15.14'))
  assert.deepEqual(validateBunLockVersions(root), [])
  assert.deepEqual(syncBunLockWorkspaceVersions(root), [])
})

test('a dry run reports the changes and writes nothing', (t) => {
  const root = project(t, { lockVersion: '0.15.10', manifestVersion: '0.15.14' })
  assert.equal(syncBunLockWorkspaceVersions(root, { dryRun: true }).length, 3)
  assert.equal(readFileSync(join(root, 'bun.lock'), 'utf8'), lock('0.15.10'))
})

test('syncing keeps CRLF line endings', (t) => {
  const crlf = lock('0.15.10').replace(/\n/g, '\r\n')
  const root = project(t, { lockVersion: '0.15.10', manifestVersion: '0.15.14', lockText: crlf })
  syncBunLockWorkspaceVersions(root)
  assert.equal(readFileSync(join(root, 'bun.lock'), 'utf8'), lock('0.15.14').replace(/\n/g, '\r\n'))
})

test('release sync-lock fixes a stale lock from the command line', (t) => {
  const root = project(t, { lockVersion: '0.15.10', manifestVersion: '0.15.14' })
  const sync = (...extra) =>
    spawnSync(process.execPath, [cli, 'release', 'sync-lock', '--target', root, ...extra], {
      encoding: 'utf8',
    })

  const dry = sync('--dry-run')
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(
    dry.stdout,
    /Would update bun\.lock packages\/architecture \(@agent-sim\/architecture\): 0\.15\.10 -> 0\.15\.14/
  )
  assert.equal(readFileSync(join(root, 'bun.lock'), 'utf8'), lock('0.15.10'))

  const run = sync()
  assert.equal(run.status, 0, run.stderr)
  assert.match(
    run.stdout,
    /Updated bun\.lock scenes\/sim \(@agent-sim\/sim\): 0\.15\.10 -> 0\.15\.14/
  )
  assert.equal(readFileSync(join(root, 'bun.lock'), 'utf8'), lock('0.15.14'))

  const again = sync()
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /nothing to sync/)
})

test('the release workflow syncs the lock before it reads the release PR head', () => {
  const start = workflow.indexOf(
    '- name: Sync lockfile workspace versions on generated release PRs'
  )
  const draft = workflow.indexOf('- name: Normalize generated release PR draft state')
  assert.ok(start > 0 && start < draft, 'the sync step must precede the draft-state step')
  const step = workflow.slice(start, draft)
  assert.match(step, /steps\.credentials\.outputs\.token_source == 'configured'/)
  assert.match(step, /GH_TOKEN: \$\{\{ secrets\.CODE_FOUNDRY_TOKEN \}\}/)
  assert.match(step, /release sync-lock --target "\$worktree"/)
  assert.match(
    step,
    /commit --quiet -m 'chore\(release\): sync bun\.lock workspace versions' -- bun\.lock/
  )
  assert.match(step, /git -C "\$worktree" push origin "HEAD:refs\/heads\/\$branch"/)
  assert.doesNotMatch(step, /--force|-f\b/)
  assert.match(step, /continue-on-error: true/)
})
