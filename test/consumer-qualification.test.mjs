import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { digest, FIXTURES, localizeCalls, qualifyCandidate, seedFixture, snapshot } from '../src/lib/consumer-qualification.mjs'

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'qualification-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('the release matrix covers managers, both topologies, mise and nested languages', () => {
  assert.deepEqual(FIXTURES.filter((f) => f.manager).map((f) => f.manager), ['npm', 'pnpm', 'yarn', 'bun'])
  assert.ok(FIXTURES.some((f) => f.topology === 'staging-release'))
  assert.ok(FIXTURES.some((f) => f.name === 'nested-rust'))
  assert.ok(FIXTURES.some((f) => f.name === 'nested-python'))
})

for (const fixture of FIXTURES) test(`seed ${fixture.name} is deterministic and preserves authored input`, (t) => {
  const root = temporary(t)
  seedFixture(root, fixture)
  const first = snapshot(root)
  seedFixture(root, fixture)
  assert.deepEqual(snapshot(root), first)
  assert.ok(first['AGENTS.md'])
  assert.ok(first['.github/workflows/custom.yml'])
  if (fixture.lock) assert.ok(first[fixture.lock])
})

test('snapshot detects changed bytes and rejects symlinks', (t) => {
  const root = temporary(t)
  writeFileSync(join(root, 'a'), 'one')
  const before = snapshot(root)
  writeFileSync(join(root, 'a'), 'two')
  assert.notDeepEqual(snapshot(root), before)
  symlinkSync('a', join(root, 'link'))
  assert.throws(() => snapshot(root), /symlink/)
  assert.throws(() => digest(join(root, 'link')), /regular file/)
})

test('contract localization is exact and does not rewrite unrelated refs', () => {
  const source = 'uses: owner/repo/.github/workflows/ci.yml@v1.2.3\nuses: owner/repo/.github/workflows/ci.yml@v1.2.30\nuses: other/repo/.github/workflows/ci.yml@v1.2.3\n'
  assert.equal(localizeCalls(source, 'owner/repo', 'v1.2.3'), 'uses: ./.github/workflows/ci.yml\nuses: owner/repo/.github/workflows/ci.yml@v1.2.30\nuses: other/repo/.github/workflows/ci.yml@v1.2.3\n')
})

test('candidate source identity is mandatory before any install', () => {
  assert.throws(() => qualifyCandidate({ packageFile: '/missing', sourceSha: 'main', reportPath: '/missing' }), /exact.*SHA/)
})
