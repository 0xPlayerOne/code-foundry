import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const runtime = new URL('../src/runtime.mjs', import.meta.url)

/** @param {string} shardsConfig @returns {string} */
function rustFixture(shardsConfig) {
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-codeql-'))
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
  mkdirSync(join(root, 'crates'), { recursive: true })
  mkdirSync(join(root, 'apps', 'desktop', 'src-tauri'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, '.github', 'code-foundry.yml'),
    `languages: typescript,rust\npackage_manager: bun\n${shardsConfig}`
  )
  writeFileSync(join(root, 'Cargo.toml'), '[workspace]\n')
  writeFileSync(join(root, 'crates', 'lib.rs'), '')
  writeFileSync(join(root, 'apps', 'desktop', 'src-tauri', 'main.rs'), '')
  writeFileSync(join(root, 'src', 'index.ts'), '')
  writeFileSync(join(root, '.github', 'workflows', 'validation.yml'), 'name: caller\n')
  return root
}

/** @param {string} root @param {Record<string, string>} env */
function runCodeql(root, env) {
  const output = join(root, 'github-output.env')
  execFileSync(process.execPath, [runtime.pathname, 'codeql'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env, GITHUB_OUTPUT: output },
  })
  const lines = Object.fromEntries(output ? readLines(output) : [])
  return { lines, languages: JSON.parse(lines.languages ?? '[]') }
}

/** @param {string} file */
function readLines(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf('=')
      return [line.slice(0, index), line.slice(index + 1)]
    })
}

/** @param {string} root @param {string[]} paths @returns {string} */
function changedFiles(root, paths) {
  const file = join(root, 'changed-files.txt')
  writeFileSync(file, `${paths.join('\n')}\n`)
  return file
}

test('rust shards skip individually by scope on pull requests', () => {
  const root = rustFixture('codeql_rust_shards: \'["crates","apps/desktop/src-tauri"]\'\n')
  const file = changedFiles(root, ['crates/lib.rs', 'README.md'])
  const { languages, lines } = runCodeql(root, {
    REPO_FOUNDRY_VISIBILITY: 'public',
    FOUNDRY_EVENT_NAME: 'pull_request',
    FOUNDRY_CODEQL_CHANGED_FILES_FILE: file,
  })
  const rust = languages.find((entry) => entry.language === 'rust')
  assert.deepEqual(rust.shards, [
    { shard: 'crates', changed: true },
    { shard: 'apps/desktop/src-tauri', changed: false },
  ])
  assert.equal(lines.rust_changed, 'true')
  // The pull request touches no JavaScript source, so TypeScript analysis skips.
  assert.equal(lines.javascript_changed, 'false')
  // Workflow-file changes keep Actions analysis armed.
  assert.equal(lines.actions_changed, 'false')
})

test('workspace manifests re-arm every rust shard', () => {
  const root = rustFixture('codeql_rust_shards: \'["crates","apps/desktop/src-tauri"]\'\n')
  const file = changedFiles(root, ['Cargo.lock'])
  const { languages } = runCodeql(root, {
    REPO_FOUNDRY_VISIBILITY: 'public',
    FOUNDRY_EVENT_NAME: 'pull_request',
    FOUNDRY_CODEQL_CHANGED_FILES_FILE: file,
  })
  const rust = languages.find((entry) => entry.language === 'rust')
  assert.ok(rust.shards.every((entry) => entry.changed))
})

test('non-pull-request events analyze everything', () => {
  const root = rustFixture('codeql_rust_shards: \'["crates","apps/desktop/src-tauri"]\'\n')
  const { lines } = runCodeql(root, {
    REPO_FOUNDRY_VISIBILITY: 'public',
    FOUNDRY_EVENT_NAME: 'push',
  })
  assert.equal(lines.rust_changed, 'true')
  assert.equal(lines.javascript_changed, 'true')
})

test('a missing changed-file list fails open toward analyzing everything', () => {
  const root = rustFixture('codeql_rust_shards: \'["crates","apps/desktop/src-tauri"]\'\n')
  const { languages } = runCodeql(root, {
    REPO_FOUNDRY_VISIBILITY: 'public',
    FOUNDRY_EVENT_NAME: 'pull_request',
  })
  const rust = languages.find((entry) => entry.language === 'rust')
  assert.equal(rust.shards, undefined)
  assert.equal(rust.changed, true)
  const javascript = languages.find((entry) => entry.language === 'javascript-typescript')
  assert.equal(javascript.changed, true)
})

test('the code-scanning merge gate disables change detection', () => {
  const root = rustFixture('codeql_rust_shards: \'["crates","apps/desktop/src-tauri"]\'\n')
  const file = changedFiles(root, ['crates/lib.rs'])
  const { languages } = runCodeql(root, {
    REPO_FOUNDRY_VISIBILITY: 'public',
    FOUNDRY_EVENT_NAME: 'pull_request',
    FOUNDRY_CODEQL_CHANGED_FILES_FILE: file,
    FOUNDRY_CODEQL_MERGE_GATE: 'true',
  })
  // The merge gate waits for results in every tracked category, so a gated
  // repository must analyze every shard regardless of the diff.
  const rust = languages.find((entry) => entry.language === 'rust')
  assert.equal(rust.shards, undefined)
  assert.equal(rust.changed, true)
})

test('the all shard never skips while it is the configured scope', () => {
  const root = rustFixture('codeql_rust_shards: \'["all"]\'\n')
  const file = changedFiles(root, ['README.md'])
  const { languages } = runCodeql(root, {
    REPO_FOUNDRY_VISIBILITY: 'public',
    FOUNDRY_EVENT_NAME: 'pull_request',
    FOUNDRY_CODEQL_CHANGED_FILES_FILE: file,
  })
  const rust = languages.find((entry) => entry.language === 'rust')
  assert.deepEqual(rust.shards, [{ shard: 'all', changed: true }])
})
