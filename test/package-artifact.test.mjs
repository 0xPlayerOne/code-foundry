import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { singleNpmPackReport } from '../src/lib/node-package-performance.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

test('the npm package keeps runtime templates and excludes repository-local actions', () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: packageRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  assert.equal(result.status, 0, result.stderr)

  const archive = singleNpmPackReport(JSON.parse(result.stdout))
  const files = new Set(archive.files.map(({ path }) => path))
  assert.equal(
    [...files].some((path) => path.startsWith('.github/actions/')),
    false,
    'GitHub Actions run from the Code Foundry repository, not the npm archive'
  )

  for (const path of [
    '.github/workflows/validation.yml',
    '.github/workflows/qualification-receipt.yml',
    '.github/workflows/release.yml',
    '.github/workflows/release-integrity.yml',
    '.github/ISSUE_TEMPLATE/bug_report.yml',
    '.github/licenses/AGPL-3.0-or-later.txt',
    'src/commands/sync.mjs',
    'src/runtime.mjs',
    '.githooks/pre-commit',
    'src/runtime.d.ts',
    'src/templates/gitignore',
    'src/templates/workflows/validation-audit.yml',
  ]) {
    assert.ok(files.has(path), `${path} remains in the npm archive`)
  }

  for (const path of [
    'src/commands/qualification-receipt.mjs',
    'src/lib/qualification-receipt.mjs',
    'src/lib/release-package-contract.mjs',
    '.githooks/post-checkout',
    '.githooks/post-commit',
    '.githooks/post-merge',
    '.githooks/pre-push',
  ]) {
    assert.equal(
      files.has(path),
      false,
      `${path} is repository- or machine-local, not part of the CLI package`
    )
  }
})

test('npm hook allowlist excludes machine-generated hook delegates', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(manifest.files.includes('.githooks/pre-commit'))
  assert.ok(!manifest.files.includes('.githooks'))
})
