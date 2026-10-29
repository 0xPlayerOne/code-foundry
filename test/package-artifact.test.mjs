import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
    'src/templates/gitignore',
    'src/templates/workflows/validation-audit.yml',
  ]) {
    assert.ok(files.has(path), `${path} remains in the npm archive`)
  }

  for (const path of [
    'src/commands/qualification-receipt.mjs',
    'src/lib/qualification-receipt.mjs',
    'src/lib/release-package-contract.mjs',
  ]) {
    assert.equal(
      files.has(path),
      false,
      `${path} is loaded from the GitHub repository by workflows, not the CLI package`
    )
  }
})
