import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  downloadVerifiedArchive,
  publishQualifiedArchive,
  qualifyArchive,
  REQUIRED_FIXTURES,
  REQUIRED_NODES,
  sha256,
  stageQualifiedRelease,
  validateCandidate,
  validateQualificationReports,
} from '../src/commands/qualified-publication.mjs'

const sourceSha = 'a'.repeat(40)
const hash = 'b'.repeat(64)
function reports(digest = hash) {
  return REQUIRED_NODES.map((node) => ({
    schema_version: 1,
    source_sha: sourceSha,
    artifact_sha256: digest,
    complete: true,
    actionlint: true,
    node: `v${node}.1.0`,
    fixtures: REQUIRED_FIXTURES.map((name) => ({ name, status: 'passed' })),
  }))
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'qualified-publish-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return {
    repository: 'owner/repo',
    tag: 'v1.2.3',
    sourceSha,
    asset: 'code-foundry-1.2.3.tgz',
    directory,
  }
}
function seeded(t) {
  const candidate = fixture(t)
  const file = join(candidate.directory, candidate.asset)
  writeFileSync(file, 'opaque test tarball')
  const digest = sha256(file)
  const reportPaths = reports(digest).map((report, index) => {
    const path = join(candidate.directory, `${index}.json`)
    writeFileSync(path, JSON.stringify(report))
    return path
  })
  const verify = async () => ({
    status: 'passed',
    immutable: true,
    sourceSha,
    assets: [{ digest: `sha256:${digest}` }],
  })
  return { candidate, reportPaths, verify, file }
}

test('qualified publication can read release attestations before publishing', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/qualified-foundry-publish.yml', import.meta.url),
    'utf8'
  )
  assert.match(workflow, /^  attestations: read$/m)
  assert.match(workflow, /^      attestations: read$/m)
})

test('only the complete required matrix qualifies the exact archive and source', () => {
  assert.deepEqual(validateQualificationReports(reports(), sourceSha, hash).nodes, REQUIRED_NODES)
  assert.throws(
    () => validateQualificationReports(reports().slice(1), sourceSha, hash),
    /Every required/
  )
  assert.throws(
    () => validateQualificationReports(reports(), sourceSha, 'c'.repeat(64)),
    /identity mismatch/
  )
  assert.throws(
    () => validateQualificationReports(reports(), 'c'.repeat(40), hash),
    /identity mismatch/
  )
})
for (const [name, change] of [
  [
    'skipped fixture',
    (r) => {
      r[0].fixtures[0].status = 'skipped'
    },
  ],
  [
    'missing fixture',
    (r) => {
      r[0].fixtures.pop()
    },
  ],
  [
    'duplicate node',
    (r) => {
      r[1].node = r[0].node
    },
  ],
  [
    'missing Actionlint',
    (r) => {
      r[0].actionlint = false
    },
  ],
  [
    'incomplete report',
    (r) => {
      r[0].complete = false
    },
  ],
])
  test(`qualification rejects ${name}`, () => {
    const value = reports()
    change(value)
    assert.throws(() => validateQualificationReports(value, sourceSha, hash))
  })
test('candidate identity disallows globs, flags, paths and mutable refs', (t) => {
  const candidate = fixture(t)
  validateCandidate(candidate)
  for (const asset of ['*.tgz', '../x.tgz', '--foo.tgz'])
    assert.throws(() => validateCandidate({ ...candidate, asset }))
  assert.throws(() => validateCandidate({ ...candidate, sourceSha: 'main' }))
  assert.throws(() => validateCandidate({ ...candidate, repository: '../repo' }))
})
test('download verifies exactly one immutable asset before returning it', async (t) => {
  const candidate = fixture(t)
  const calls = []
  const result = await downloadVerifiedArchive(candidate, {
    run: (command, args) => {
      calls.push([command, ...args])
      writeFileSync(join(candidate.directory, candidate.asset), 'archive')
      return ''
    },
    verify: async () => ({
      status: 'passed',
      immutable: true,
      sourceSha,
      assets: [{ digest: `sha256:${sha256(join(candidate.directory, candidate.asset))}` }],
    }),
  })
  assert.equal(result.file, join(realpathSync(candidate.directory), candidate.asset))
  assert.ok(calls[0].includes('--pattern'))
  await assert.rejects(() => downloadVerifiedArchive(candidate), /fresh empty/)
})
test('failed verification prevents an archive becoming eligible', async (t) => {
  const candidate = fixture(t)
  await assert.rejects(
    () =>
      downloadVerifiedArchive(candidate, {
        run: () => {
          writeFileSync(join(candidate.directory, candidate.asset), 'archive')
          return ''
        },
        verify: async () => ({ status: 'failed' }),
      }),
    /verification/
  )
})
test('publication invokes npm on the exact archive with lifecycle scripts disabled', async (t) => {
  const { candidate, reportPaths, verify } = seeded(t)
  const calls = []
  const result = await publishQualifiedArchive(candidate, reportPaths, {
    verify,
    run: (command, args) => {
      calls.push([command, ...args])
      return command === 'tar' ? '{"name":"code-foundry","version":"1.2.3"}' : ''
    },
  })
  assert.equal(result.status, 'published')
  assert.deepEqual(calls[1], [
    'npm',
    'publish',
    join(realpathSync(candidate.directory), candidate.asset),
    '--ignore-scripts',
    '--provenance',
    '--access',
    'public',
  ])
})
test('wrong package identity or archive replacement never reaches npm', async (t) => {
  const { candidate, reportPaths, verify, file } = seeded(t)
  assert.throws(
    () => qualifyArchive(candidate, reportPaths, () => '{"name":"other","version":"1.2.3"}'),
    /package identity/
  )
  let published = false
  await assert.rejects(
    () =>
      publishQualifiedArchive(candidate, reportPaths, {
        verify: async () => {
          const result = await verify()
          writeFileSync(file, 'replacement')
          return result
        },
        run: (command) => {
          if (command === 'npm') published = true
          return '{"name":"code-foundry","version":"1.2.3"}'
        },
      }),
    /changed before/
  )
  assert.equal(published, false)
})
test('unverified release identity never reaches npm', async (t) => {
  const { candidate, reportPaths } = seeded(t)
  let published = false
  await assert.rejects(
    () =>
      publishQualifiedArchive(candidate, reportPaths, {
        verify: async () => ({ status: 'passed', immutable: false, sourceSha }),
        run: (command) => {
          if (command === 'npm') published = true
          return '{"name":"code-foundry","version":"1.2.3"}'
        },
      }),
    /verification/
  )
  assert.equal(published, false)
})

function stagingRunner(candidate, overrides = {}) {
  let reads = 0
  const uploaded = []
  const writes = []
  const apiCalls = []
  const run = (command, args) => {
    if (command === 'tar') return '{"name":"code-foundry","version":"1.2.3"}'
    if (args[0] === 'api') {
      apiCalls.push(args)
      const path = args.at(-1)
      if (path.endsWith('/immutable-releases'))
        return JSON.stringify({ enabled: overrides.enabled ?? true })
      if (path.includes('/git/ref/'))
        return JSON.stringify({ object: { type: 'commit', sha: overrides.sha ?? sourceSha } })
      reads++
      return JSON.stringify([
        [
          {
            id: 12,
            draft: overrides.draft ?? true,
            tag_name: candidate.tag,
            assets: reads === 1 ? (overrides.assets ?? []) : uploaded,
          },
        ],
      ])
    }
    writes.push(args)
    if (args[1] === 'upload')
      uploaded.push({
        name: args[3].split('/').at(-1),
        digest: `sha256:${sha256(args[3])}`,
        state: 'uploaded',
      })
    return ''
  }
  return { run, writes, apiCalls }
}

test('staging attaches both qualified assets before publishing and never clobbers', async (t) => {
  const { candidate, reportPaths, verify } = seeded(t)
  const { run, writes, apiCalls } = stagingRunner(candidate)
  const result = await stageQualifiedRelease(candidate, reportPaths, { run, verify })
  assert.equal(result.status, 'release-published-and-verified')
  const releaseListCall = apiCalls.find((args) => args.at(-1)?.includes('/releases?per_page=100'))
  assert.ok(releaseListCall?.includes('--paginate'))
  assert.ok(releaseListCall?.includes('--slurp'))
  assert.deepEqual(
    writes.map((args) => args[1]),
    ['upload', 'upload', 'edit']
  )
  assert.ok(writes.every((args) => !args.includes('--clobber')))
  assert.ok(writes[2].includes('--verify-tag'))
})
for (const [name, overrides] of [
  ['disabled immutability', { enabled: false }],
  ['wrong tag commit', { sha: 'c'.repeat(40) }],
  ['already published release', { draft: false }],
  [
    'conflicting asset',
    { assets: [{ name: 'code-foundry-1.2.3.tgz', digest: 'wrong', state: 'uploaded' }] },
  ],
])
  test(`staging rejects ${name} before remote writes`, async (t) => {
    const { candidate, reportPaths, verify } = seeded(t)
    const { run, writes } = stagingRunner(candidate, overrides)
    await assert.rejects(() => stageQualifiedRelease(candidate, reportPaths, { run, verify }))
    assert.equal(writes.length, 0)
  })
