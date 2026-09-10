import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const lib = fileURLToPath(new URL('../src/lib/docs-only.mjs', import.meta.url))

/** @param {import('node:test').TestContext} t @param {Record<string, string>} files */
function gitFixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'foundry-docs-only-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (/** @type {string[]} */ args, options = {}) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe', ...options })
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

test('docs-only changes are markdown, docs, and license roots', (t) => {
  const root = gitFixture(t, {
    'README.md': '# updated\n',
    'docs/guide.md': 'guide\n',
    LICENSE: 'license\n',
  })
  assert.equal(runDocsOnly(root), true)
})

test('code, lockfile, workflow, and config changes keep the audit tier', (t) => {
  for (const files of [
    { 'src/index.ts': 'export const x = 1\n' },
    { 'package-lock.json': '{"lockfileVersion": 3}\n' },
    { 'package.json': '{"name":"x"}\n' },
    { '.github/workflows/ci.yml': 'name: x\n' },
    { '.gitignore': 'dist/\n' },
    { 'README.md': '# updated\n', 'src/index.ts': 'export const x = 1\n' },
  ]) {
    const root = gitFixture(t, files)
    assert.equal(runDocsOnly(root), false, JSON.stringify(Object.keys(files)))
  }
})

test('unresolvable repositories keep the audit tier', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'foundry-docs-only-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(runDocsOnly(root), false)
})

function runDocsOnly(root) {
  const output = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(lib)}).then((m) => console.log(m.docsOnlyPullRequest(${JSON.stringify(root)}, 'main')))`,
    ],
    { encoding: 'utf8' }
  )
  assert.equal(output.status, 0, output.stderr)
  return output.stdout.trim() === 'true'
}

test('validation mode downgrades docs-only pull requests to fast', (t) => {
  const docs = gitFixture(t, { 'README.md': '# updated\n' })
  const code = gitFixture(t, { 'src/index.ts': 'export const x = 1\n' })
  const run = (cwd, env) =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../src/runtime.mjs', import.meta.url)), 'validation', 'mode'],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          FOUNDRY_EVENT_NAME: 'pull_request',
          FOUNDRY_BASE_REF: 'main',
          FOUNDRY_HEAD_REF: 'feature/x',
          ...env,
        },
      }
    )
  assert.match(run(docs, {}).stdout, /^mode=fast$/m)
  assert.match(run(code, {}).stdout, /^mode=audit$/m)
  assert.match(run(docs, { FOUNDRY_EVENT_NAME: 'schedule' }).stdout, /^mode=audit$/m)
})
