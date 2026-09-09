import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assetDigest, assetManifest, integrityCommand, verifyImmutableSetting, verifyRelease } from '../src/commands/release-integrity.mjs'

const sha = 'a'.repeat(40)
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'foundry-integrity-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'dist'))
  writeFileSync(join(root, 'dist/app.tgz'), 'artifact')
  return root
}
function runner(overrides = {}) {
  const calls = []
  const run = (argv) => {
    calls.push(argv)
    let value = { verified: true }
    const endpoint = argv.at(-1)
    if (argv[0] === 'api') {
      if (endpoint.endsWith('immutable-releases')) value = { enabled: true }
      else if (endpoint.includes('/releases/tags/')) value = { immutable: true, draft: false, tag_name: 'v1.0.0' }
      else if (endpoint.includes('/git/ref/')) value = { object: { type: 'commit', sha } }
      else throw new Error('unexpected endpoint')
    }
    if (overrides.value) value = overrides.value(argv, value)
    return { status: Object.hasOwn(overrides, 'status') ? overrides.status : 0, stdout: overrides.invalidJson ? 'bad' : JSON.stringify(value) }
  }
  return { run, calls }
}

test('settings verifies enabled without changing repository settings', () => {
  const fake = runner()
  assert.equal(verifyImmutableSetting('owner/repo', fake.run).status, 'passed')
  assert.deepEqual(fake.calls, [['api', '--hostname', 'github.com', 'repos/owner/repo/immutable-releases']])
})
for (const status of [1, null]) {
  test(`inaccessible setting remains unverified (${status})`, () => {
    assert.throws(() => verifyImmutableSetting('owner/repo', runner({ status }).run), /unverified/)
  })
}

test('disabled and malformed settings cannot pass', () => {
  assert.throws(() => verifyImmutableSetting('owner/repo', runner({ value: () => ({ enabled: false }) }).run))
  assert.throws(() => verifyImmutableSetting('owner/repo', runner({ invalidJson: true }).run))
})

test('metadata alone is insufficient; signed release verification is invoked', () => {
  const fake = runner()
  const report = verifyRelease({ repository: 'owner/repo', tag: 'v1.0.0', expectedSha: sha }, fake.run)
  assert.equal(report.sourceSha, sha)
  assert.deepEqual(fake.calls[1], ['release', 'verify', 'v1.0.0', '--repo', 'owner/repo', '--format', 'json'])
})

for (const metadata of [{ immutable: false }, { draft: true }, { tag_name: 'other' }]) {
  test(`incorrect release metadata fails: ${JSON.stringify(metadata)}`, () => {
    const fake = runner({ value: (argv, value) => argv.at(-1).includes('/releases/tags/') ? { ...value, ...metadata } : value })
    assert.throws(() => verifyRelease({ repository: 'owner/repo', tag: 'v1.0.0' }, fake.run))
    assert.equal(fake.calls.length, 1)
  })
}

test('tag source mismatch fails', () => {
  assert.throws(() => verifyRelease({ repository: 'owner/repo', tag: 'v1.0.0', expectedSha: 'b'.repeat(40) }, runner().run), /source SHA/)
})

test('annotated tags resolve to their commit with bounded recursion', () => {
  const fake = runner()
  const run = (argv) => argv.at(-1).includes('/git/ref/')
    ? { status: 0, stdout: JSON.stringify({ object: { type: 'tag', sha } }) }
    : argv.at(-1).includes('/git/tags/') ? { status: 0, stdout: JSON.stringify({ object: { type: 'commit', sha } }) } : fake.run(argv)
  assert.equal(verifyRelease({ repository: 'owner/repo', tag: 'v1.0.0' }, run).sourceSha, sha)
})

test('local asset digest is checked by the signed release verifier', (t) => {
  const root = fixture(t); const fake = runner()
  const report = verifyRelease({ repository: 'owner/repo', tag: 'v1.0.0', root, assets: ['dist/app.tgz'] }, fake.run)
  assert.equal(report.assets[0].status, 'verified')
  assert.ok(fake.calls.some((argv) => argv[1] === 'verify-asset' && argv[3] === join(root, 'dist/app.tgz')))
})

test('artifact replacement during verification is rejected', (t) => {
  const root = fixture(t); const fake = runner()
  const run = (argv) => {
    if (argv[1] === 'verify-asset') writeFileSync(join(root, 'dist/app.tgz'), 'changed')
    return fake.run(argv)
  }
  assert.throws(() => verifyRelease({ repository: 'owner/repo', tag: 'v1.0.0', root, assets: ['dist/app.tgz'] }, run), /changed/)
})

test('manifest hashes selected assets without absolute path disclosure', (t) => {
  const root = fixture(t)
  const manifest = assetManifest(root, ['dist/app.tgz'])
  assert.match(manifest.assets[0].digest, /^sha256:[0-9a-f]{64}$/)
  assert.doesNotMatch(JSON.stringify(manifest), new RegExp(root))
  assert.match(manifest.checksums, /^[0-9a-f]{64}  dist\/app.tgz\n$/)
})

test('unsafe, empty, or duplicate assets fail', (t) => {
  const root = fixture(t)
  symlinkSync('/etc/hosts', join(root, 'dist/escape'))
  writeFileSync(join(root, 'dist/empty'), '')
  for (const file of ['../outside', '/etc/hosts', 'dist/escape', 'dist/empty', 'dist']) assert.throws(() => assetDigest(root, file))
  assert.throws(() => assetManifest(root, []))
  assert.throws(() => assetManifest(root, ['dist/app.tgz', 'dist/app.tgz']))
})

test('CLI rejects ambiguous or ignored flags and option injection', () => {
  for (const args of [[], ['settings', '--repo'], ['settings', '--repo', 'owner/repo', '--tag', 'ignored'],
    ['release', '--repo', 'owner/repo', '--tag', '--help'], ['settings', '--repo', 'owner/repo', '--repo', 'other/repo']])
    assert.throws(() => integrityCommand(args, runner().run))
})

test('workflow and action do not grant write access to release verification', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release-integrity.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(workflow, /contents: write|administration: write|pull_request_target:/)
  const action = readFileSync(new URL('../.github/actions/attest-artifact/action.yml', import.meta.url), 'utf8')
  assert.match(action, /attest-build-provenance@[0-9a-f]{40}/)
  assert.match(action, /sha256sum --check/)
})
