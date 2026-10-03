import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEFAULT_RELEASES,
  FULL_CHANGELOG_URL,
  trimChangelog,
} from '../scripts/package-changelog.mjs'

/** @param {number} count */
function changelog(count) {
  const sections = []
  for (let index = count; index >= 1; index -= 1) {
    sections.push(
      `## [1.${index}.0](https://example.test/compare/v1.${index - 1}.0...v1.${index}.0) (2026-01-01)\n\n\n### Features\n\n* change ${index}\n`
    )
  }
  return `# Changelog\n\n${sections.join('\n')}\n## Changelog\n\nAll notable changes to this project are documented here.\n`
}

test('keeps the header and the newest releases, then links to the full history', () => {
  const result = trimChangelog(changelog(5), { releases: 2 })
  assert.equal(result.kept, 2)
  assert.equal(result.omitted, 3)
  assert.match(result.text, /^# Changelog\n\n## \[1\.5\.0\]/)
  assert.match(result.text, /\* change 4\n/)
  assert.doesNotMatch(result.text, /\[1\.3\.0\]|change 3|All notable changes/)
  assert.ok(result.text.includes(`(${FULL_CHANGELOG_URL})`))
  assert.match(result.text, /2 most recent releases; 3 older releases are omitted/)
  assert.ok(result.text.endsWith('\n'))
})

test('leaves a short changelog unchanged', () => {
  const text = changelog(3)
  assert.deepEqual(trimChangelog(text, { releases: 3 }), { text, kept: 3, omitted: 0 })
})

test('refuses invalid limits and already-trimmed input', () => {
  assert.throws(() => trimChangelog(changelog(3), { releases: 0 }), /positive integer/)
  const trimmed = trimChangelog(changelog(3), { releases: 1 }).text
  assert.throws(() => trimChangelog(trimmed, { releases: 1 }), /already trimmed/)
})

test('the repository changelog trims to the default window', () => {
  const text = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  const result = trimChangelog(text)
  assert.equal(result.kept, Math.min(DEFAULT_RELEASES, result.kept + result.omitted))
  assert.ok(Buffer.byteLength(result.text) < 32_000, 'packaged changelog should stay small')
})

test('the CLI rewrites the given file in place', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-foundry-changelog-'))
  const file = join(directory, 'CHANGELOG.md')
  writeFileSync(file, changelog(4))
  const result = spawnSync(
    process.execPath,
    [
      new URL('../scripts/package-changelog.mjs', import.meta.url).pathname,
      '--releases',
      '1',
      file,
    ],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /kept 1 releases, omitted 3/)
  assert.match(readFileSync(file, 'utf8'), /^# Changelog\n\n## \[1\.4\.0\][^]*full changelog/)
})
