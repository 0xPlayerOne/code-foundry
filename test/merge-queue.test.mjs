import assert from 'node:assert/strict'
import test from 'node:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPackageVersion, syncRepository } from '../src/commands/sync.mjs'
import {
  inspectQueueCaller,
  mergeQueueEnabled,
  QUEUE_CALLER,
  queueRuntimeRef,
  renderMergeQueueCaller,
  syncQueueCaller,
  validateMergeGroup,
} from '../src/lib/merge-queue.mjs'

const config = { runtime_repository: 'owner/foundry', git_workflow: 'direct', features: 'all' }
const sourceSha = 'a'.repeat(40)
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'merge-queue-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
function event(branch = 'main') {
  const payload = {
    action: 'checks_requested',
    repository: { full_name: 'owner/app' },
    merge_group: {
      head_sha: sourceSha,
      base_sha: 'b'.repeat(40),
      base_ref: `refs/heads/${branch}`,
      head_ref: `refs/heads/gh-readonly-queue/${branch}/pr-12-abcd`,
    },
  }
  const environment = {
    GITHUB_EVENT_NAME: 'merge_group',
    GITHUB_SHA: sourceSha,
    GITHUB_REF: payload.merge_group.head_ref,
    GITHUB_REPOSITORY: 'owner/app',
  }
  return { payload, environment }
}

test('merge queues are strictly opt-in', () => {
  for (const value of [undefined, '', false, 'false']) assert.equal(mergeQueueEnabled(value), false)
  for (const value of [true, 'true']) assert.equal(mergeQueueEnabled(value), true)
  for (const value of ['auto', 'yes', 'TRUE', 1]) assert.throws(() => mergeQueueEnabled(value))
})

test('released pins follow sync while intentional exact pins and fleet overrides persist', () => {
  assert.equal(queueRuntimeRef('v1.2.3', '1.3.0'), 'v1.3.0')
  assert.equal(queueRuntimeRef(undefined, '1.3.0'), 'v1.3.0')
  assert.equal(queueRuntimeRef(sourceSha, '1.3.0'), sourceSha)
  assert.equal(queueRuntimeRef(sourceSha, '1.3.0', 'v1.4.0'), 'v1.4.0')
})

test('generated caller runs a pinned full audit with the canonical aggregate name', () => {
  const yaml = renderMergeQueueCaller(config, 'v1.3.0')
  assert.match(yaml, /merge_group:\n    types: \[checks_requested\]/)
  assert.match(yaml, /branches: \[main\]/)
  assert.match(yaml, /name: Validation\n    needs: identity/)
  assert.match(yaml, /mode: audit/)
  assert.match(yaml, /owner\/foundry\/\.github\/workflows\/validation.yml@v1.3.0/)
  assert.match(yaml, /runtime-ref: "v1.3.0"/)
  assert.match(yaml, /ref: "v1.3.0"/)
  assert.doesNotMatch(
    yaml,
    /pull_request:|push:|secrets:|id-token:|environment:|release_diff|mode: fast|mode: release/
  )
  assert.match(yaml, /code-foundry-merge-queue-.*head_ref/)
})

test('staging is supported but still receives the full audit and respects CodeQL policy', () => {
  const yaml = renderMergeQueueCaller(
    { ...config, git_workflow: 'staging-release', codeql: 'false', ci_runner: 'custom-ci' },
    sourceSha
  )
  assert.match(yaml, /branches: \[main, staging\]/)
  assert.match(yaml, /validation-no-codeql.yml/)
  assert.match(yaml, /ci-runner: "custom-ci"/)
  assert.match(yaml, /mode: audit/)
})

test('unsafe or incomplete queue configuration fails before generation', () => {
  assert.throws(() => renderMergeQueueCaller(config, 'main'), /moving branch/)
  assert.throws(() =>
    renderMergeQueueCaller({ ...config, runtime_repository: '../repo' }, 'v1.0.0')
  )
  assert.throws(() =>
    renderMergeQueueCaller({ ...config, runner: '${{ secrets.TOKEN }}' }, 'v1.0.0')
  )
  assert.throws(
    () => renderMergeQueueCaller({ ...config, features: 'release' }, 'v1.0.0'),
    /canonical PR/
  )
  assert.throws(() => renderMergeQueueCaller({ ...config, codeql_rust_shards: '[]' }, 'v1.0.0'))
  assert.throws(() =>
    renderMergeQueueCaller({ ...config, codeql_rust_max_parallel: '0' }, 'v1.0.0')
  )
  assert.throws(() => renderMergeQueueCaller({ ...config, codeql_rust_threads: '65' }, 'v1.0.0'))
  assert.throws(() =>
    renderMergeQueueCaller({ ...config, codeql_rust_max_parallel: '9' }, 'v1.0.0')
  )
  assert.throws(() =>
    renderMergeQueueCaller({ ...config, codeql_rust_shards: '["src", "src"]' }, 'v1.0.0')
  )
})

test('queue rendering accepts mixed broad and scoped Rust shards', () => {
  const yaml = renderMergeQueueCaller(
    { ...config, codeql_rust_shards: '["all", "src"]' },
    'v1.0.0'
  )
  assert.match(yaml, /rust-shards: '\["all","src"\]'/)
})

test('queue rendering accepts the canonical Rust shard path grammar', () => {
  const yaml = renderMergeQueueCaller(
    { ...config, codeql_rust_shards: '["src/foo bar,crates/foo+bar"]' },
    'v1.0.0'
  )
  assert.match(yaml, /rust-shards: '\["src\/foo bar,crates\/foo\+bar"\]'/)
})

for (const branch of ['main', 'staging'])
  test(`valid ${branch} merge groups validate their exact combined commit`, () => {
    const { payload, environment } = event(branch)
    assert.deepEqual(validateMergeGroup(payload, environment, ['main', 'staging']), {
      mode: 'audit',
      head_sha: sourceSha,
      base_sha: 'b'.repeat(40),
      base_ref: `refs/heads/${branch}`,
    })
  })

for (const [name, mutate] of [
  [
    'ordinary push',
    (p, e) => {
      e.GITHUB_EVENT_NAME = 'push'
    },
  ],
  [
    'destroyed group',
    (p) => {
      p.action = 'destroyed'
    },
  ],
  [
    'wrong head commit',
    (p, e) => {
      e.GITHUB_SHA = 'c'.repeat(40)
    },
  ],
  [
    'wrong ref',
    (p, e) => {
      e.GITHUB_REF = 'refs/heads/main'
    },
  ],
  [
    'missing base SHA',
    (p) => {
      delete p.merge_group.base_sha
    },
  ],
  [
    'different repository',
    (p) => {
      p.repository.full_name = 'other/app'
    },
  ],
  [
    'forged queue prefix',
    (p, e) => {
      p.merge_group.head_ref = e.GITHUB_REF = 'refs/heads/gh-readonly-queue/main-evil/pr-12'
    },
  ],
])
  test(`reject ${name}`, () => {
    const { payload, environment } = event()
    mutate(payload, environment)
    assert.throws(() => validateMergeGroup(payload, environment, ['main']))
  })

test('disabled base branches cannot opt themselves into queue validation', () => {
  const { payload, environment } = event('staging')
  assert.throws(() => validateMergeGroup(payload, environment, ['main']), /not enabled/)
  assert.throws(() => validateMergeGroup(payload, environment, ['arbitrary']), /allowed/)
})

test('public sync emits an opt-in queue caller and remains idempotent', (t) => {
  const root = fixture(t)
  const runtimeRef = `v${readPackageVersion(process.cwd())}`
  mkdirSync(join(root, '.github'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
  writeFileSync(
    join(root, '.github/code-foundry.yml'),
    `languages: typescript\npackage_manager: bun\nfeatures: validation\ncodeql: auto\nruntime_ref: ${runtimeRef}\ngit_workflow: direct\nmerge_strategy: squash\nrelease_merge_strategy: squash\nmerge_queue: true\n`
  )

  const first = syncRepository({ target: root, source: process.cwd() })
  assert.ok(first.changed.includes(QUEUE_CALLER))
  const caller = readFileSync(join(root, QUEUE_CALLER), 'utf8')
  assert.match(caller, /merge_group:/)
  assert.match(caller, new RegExp(`runtime-ref: "${runtimeRef}"`))

  const second = syncRepository({ target: root, source: process.cwd() })
  assert.deepEqual(second.changed, [])
})

test('sync is idempotent, updates runtime pins, and removes only generated callers', (t) => {
  const root = fixture(t)
  const one = renderMergeQueueCaller(config, 'v1.0.0')
  const two = renderMergeQueueCaller(config, 'v1.1.0')
  assert.deepEqual(syncQueueCaller(root, one), [QUEUE_CALLER])
  assert.deepEqual(syncQueueCaller(root, one), [])
  assert.deepEqual(syncQueueCaller(root, two), [QUEUE_CALLER])
  assert.equal(readFileSync(join(root, QUEUE_CALLER), 'utf8'), two)
  assert.deepEqual(syncQueueCaller(root, null), [QUEUE_CALLER])
  assert.equal(existsSync(join(root, QUEUE_CALLER)), false)
  assert.deepEqual(syncQueueCaller(root, null), [])
})

test('dry runs do not create, update or remove files', (t) => {
  const root = fixture(t)
  const yaml = renderMergeQueueCaller(config, 'v1.0.0')
  assert.deepEqual(syncQueueCaller(root, yaml, true), [QUEUE_CALLER])
  assert.equal(existsSync(join(root, QUEUE_CALLER)), false)
  syncQueueCaller(root, yaml)
  syncQueueCaller(root, null, true)
  assert.equal(readFileSync(join(root, QUEUE_CALLER), 'utf8'), yaml)
})

test('user-owned callers and symlinks are never overwritten', (t) => {
  const root = fixture(t)
  mkdirSync(join(root, '.github/workflows'), { recursive: true })
  writeFileSync(join(root, QUEUE_CALLER), 'name: User owned\n')
  assert.deepEqual(syncQueueCaller(root, null), [])
  assert.throws(
    () => inspectQueueCaller(root, renderMergeQueueCaller(config, 'v1.0.0')),
    /repository-owned/
  )
  rmSync(join(root, QUEUE_CALLER))
  symlinkSync('missing', join(root, QUEUE_CALLER))
  assert.throws(() => inspectQueueCaller(root, null), /symlinks/)
})
