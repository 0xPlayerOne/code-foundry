import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  resolveChangedPaths,
  globToRegExp,
  readTaskFilters,
  taskAffected,
} from '../src/lib/task-filters.mjs'

test('readTaskFilters parses only configured filter_<task> keys', () => {
  const filters = readTaskFilters({
    filter_unit: 'src/**, crates/**',
    filter_eval: '',
    filter_e2e: 'apps/**',
    unrelated: 'x',
  })
  assert.deepEqual(filters.get('unit'), ['src/**', 'crates/**'])
  assert.deepEqual(filters.get('e2e'), ['apps/**'])
  assert.equal(filters.get('eval'), undefined)
  assert.equal(filters.get('security'), undefined)
})

test('glob matching stays inside path segments unless ** is used', () => {
  const cases = [
    ['src/**', 'src/a/b/c.rs', true],
    ['src/**', 'srcx/a.rs', false],
    ['crates/**', 'crates/core/src/store.rs', true],
    ['**/Cargo.toml', 'crates/core/Cargo.toml', true],
    ['**/Cargo.toml', 'Cargo.toml', true],
    ['Cargo.toml', 'Cargo.toml', true],
    ['Cargo.toml', 'crates/Cargo.toml', false],
    ['*.rs', 'main.rs', true],
    ['*.rs', 'src/main.rs', false],
    ['src/**/*.rs', 'src/a/b.rs', true],
    ['src/**/*.rs', 'src/a/b.txt', false],
    ['apps/', 'apps/web/src/x.ts', true],
    ['apps/', 'apps', false],
  ]
  for (const [glob, path, expected] of cases) {
    assert.equal(globToRegExp(glob).test(path), expected, `${glob} vs ${path}`)
  }
})

test('taskAffected fails open without a filter or a resolvable diff', () => {
  const filters = readTaskFilters({ filter_unit: 'src/**' })
  assert.equal(taskAffected('unit', filters, null), true)
  assert.equal(taskAffected('unit', filters, []), true)
  assert.equal(taskAffected('lint', filters, ['docs/x.md']), true)
  assert.equal(taskAffected('unit', filters, ['docs/x.md']), false)
  assert.equal(taskAffected('unit', filters, ['src/main.rs']), true)
})

/** @param {import('node:test').TestContext} t @param {Record<string, string>} files */
function gitFixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'foundry-task-filters-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (/** @type {string[]} */ args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'test'])
  git(['remote', 'add', 'origin', root])
  writeFileSync(join(root, 'README.md'), '# fixture\n')
  git(['add', '.'])
  git(['commit', '-qm', 'base'])
  git(['checkout', '-qb', 'feature'])
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  git(['add', '.'])
  git(['commit', '-qm', 'change'])
  return root
}

test('resolveChangedPaths resolves the pull request change set', (t) => {
  const root = gitFixture(t, { 'src/main.rs': 'fn main() {}\n' })
  const paths = resolveChangedPaths(root, {
    EVENT_NAME: 'pull_request',
    BASE_REF: 'main',
    BASE_SHA: 'main',
    HEAD_SHA: 'HEAD',
  })
  assert.deepEqual(paths, ['src/main.rs'])
})

test('resolveChangedPaths resolves the push change set and rejects unborn bases', (t) => {
  const root = gitFixture(t, { 'docs/guide.md': 'guide\n' })
  const before = execFileSync('git', ['rev-parse', 'main'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  const paths = resolveChangedPaths(root, {
    EVENT_NAME: 'push',
    BEFORE_SHA: before,
    HEAD_SHA: 'HEAD',
  })
  assert.deepEqual(paths, ['docs/guide.md'])
  assert.equal(
    resolveChangedPaths(root, {
      EVENT_NAME: 'push',
      BEFORE_SHA: '0'.repeat(40),
      HEAD_SHA: 'HEAD',
    }),
    null
  )
})

test('changedPaths fails open for unresolvable events and diffs', (t) => {
  const root = gitFixture(t, { 'src/x.rs': '' })
  assert.equal(resolveChangedPaths(root, { EVENT_NAME: 'schedule' }), null)
  assert.equal(
    resolveChangedPaths(root, { EVENT_NAME: 'pull_request', BASE_REF: 'main', HEAD_SHA: 'HEAD' }),
    null
  )
  assert.equal(
    resolveChangedPaths(root, {
      EVENT_NAME: 'pull_request',
      BASE_REF: 'nonexistent-branch',
      BASE_SHA: 'x',
      HEAD_SHA: 'HEAD',
    }),
    null
  )
})
