import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { FORMATTERS, formatterChoice, formatterCommand } from '../src/lib/formatter.mjs'
import { syncRepository } from '../src/commands/sync.mjs'

const source = new URL('..', import.meta.url).pathname
const cli = join(source, 'src/cli.mjs')
const core = join(source, 'src/runtime-core.mjs')

function fixture(t, formatter = '') {
  const root = mkdtempSync(join(tmpdir(), 'foundry-formatter-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.github'))
  writeFileSync(
    join(root, '.github/code-foundry.yml'),
    `languages: typescript\npackage_manager: bun\n${formatter ? `formatter: ${formatter}\n` : ''}`
  )
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      scripts: { 'format:check': 'exit 91', lint: 'exit 92' },
      'lint-staged': { '*.ts': ['oxlint', 'oxfmt --write'] },
      devDependencies: { 'lint-staged': '17.6.0' },
    })
  )
  git(root, 'init', '-q')
  git(
    root,
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'initial'
  )
  return root
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

function tools(root) {
  const bin = join(root, '.bin')
  mkdirSync(bin)
  for (const name of ['bun', 'bunx', 'npx']) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' '${name}' "$@" >> "$FORMAT_LOG"\n`)
    chmodSync(join(bin, name), 0o755)
  }
  return { ...process.env, PATH: `${bin}:${process.env.PATH}`, FORMAT_LOG: join(root, 'calls') }
}

test('formatter enum and schema agree, default remains Oxfmt', () => {
  assert.equal(formatterChoice(undefined), 'oxfmt')
  assert.deepEqual(
    JSON.parse(readFileSync(join(source, '.github/code-foundry.schema.json'), 'utf8')).properties
      .formatter.enum,
    FORMATTERS
  )
  assert.throws(() => formatterChoice('unknown'), /Unsupported formatter/)
  assert.deepEqual(formatterCommand('prettier'), ['prettier', '--check', '.'])
  assert.deepEqual(formatterCommand('oxfmt', { check: false }), ['oxfmt', '--write', '.'])
  assert.deepEqual(formatterCommand('bun'), ['bun', 'fmt', '--no-script', '--check', '.'])
})

test('Bun scopes are explicit, mutually exclusive and passed without a shell', () => {
  assert.deepEqual(formatterCommand('bun', { staged: true, check: false }), [
    'bun',
    'fmt',
    '--no-script',
    '--staged',
  ])
  assert.deepEqual(formatterCommand('bun', { changed: 'topic;echo injected' }), [
    'bun',
    'fmt',
    '--no-script',
    '--check',
    '--changed=topic;echo injected',
  ])
  assert.throws(() => formatterCommand('bun', { staged: true, changed: 'main' }), /exclusive/)
  for (const choice of ['prettier', 'oxfmt']) {
    assert.throws(() => formatterCommand(choice, { staged: true }), /require formatter: bun/)
    assert.throws(() => formatterCommand(choice, { changed: 'main' }), /require formatter: bun/)
  }
  for (const changed of ['', '-bad'])
    assert.throws(() => formatterCommand('bun', { changed }), /requires a Git/)
})

for (const formatter of FORMATTERS) {
  test(`pre-commit checks ${formatter} and retains the staged lint command`, (t) => {
    const root = fixture(t, formatter)
    writeFileSync(join(root, 'a.ts'), 'const value = 1;\n')
    git(root, 'add', 'a.ts')
    const env = tools(root)
    const result = spawnSync(process.execPath, [core, 'pre-commit'], {
      cwd: root,
      env,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const calls = readFileSync(env.FORMAT_LOG, 'utf8')
    assert.match(calls, /bun\nrun\nlint/)
    assert.match(
      calls,
      formatter === 'bun'
        ? /fmt\n--no-script\n--check\n--staged/
        : new RegExp(`${formatter}\\n--check\\na.ts`)
    )
  })

  test(`sync preserves ${formatter} and unrelated staged commands and dependencies`, (t) => {
    const root = fixture(t, formatter)
    const manifest = readFileSync(join(root, 'package.json'), 'utf8')
    writeFileSync(join(root, '.prettierrc'), '{"semi":false}\n')
    syncRepository({ source, target: root, configureHooks: false })
    assert.match(
      readFileSync(join(root, '.github/code-foundry.yml'), 'utf8'),
      new RegExp(`formatter: ${formatter}`)
    )
    assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), manifest)
    assert.equal(existsSync(join(root, '.oxfmtrc.json')), formatter === 'oxfmt')
    assert.equal(existsSync(join(root, '.prettierrc')), formatter !== 'oxfmt')
  })

  test(`CI explicitly selects ${formatter} and leaves lint commands independent`, (t) => {
    const root = fixture(t, formatter)
    const env = tools(root)
    const result = spawnSync(process.execPath, [core, 'ci', 'format'], {
      cwd: root,
      env,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const calls = readFileSync(env.FORMAT_LOG, 'utf8')
    assert.match(
      calls,
      new RegExp(
        formatter === 'bun'
          ? 'bun\\nfmt\\n--no-script\\n--check\\n\\.'
          : `${formatter}\\n--check\\n\\.`
      )
    )
    assert.doesNotMatch(calls, /run\nformat:check|exit 91|exit 92/)
  })
}

test('sync and CLI fail closed on invalid formatter configuration', (t) => {
  const root = fixture(t, 'unknown')
  assert.throws(() => syncRepository({ source, target: root }), /Unsupported formatter/)
  const result = spawnSync(process.execPath, [cli, 'format', '--target', root, '--check'], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Unsupported formatter/)
})

test('staged writes refuse partial staging before invoking Bun', (t) => {
  const root = fixture(t, 'bun')
  writeFileSync(join(root, 'a.ts'), 'const a=1\n')
  git(root, 'add', 'a.ts')
  const before = git(root, 'show', ':a.ts')
  writeFileSync(join(root, 'a.ts'), 'const a=2\n')
  const env = tools(root)
  const result = spawnSync(process.execPath, [cli, 'format', '--target', root, '--staged'], {
    env,
    encoding: 'utf8',
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Partially staged/)
  assert.equal(existsSync(env.FORMAT_LOG), false)
  assert.equal(git(root, 'show', ':a.ts'), before)
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'const a=2\n')
})

const nativeBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).stdout?.trim() === '1.4.4'
test(
  'native checker follows unbuilt references without emitting declarations',
  { skip: !nativeBun },
  (t) => {
    const root = fixture(t)
    mkdirSync(join(root, 'child'))
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ files: [], references: [{ path: './child' }] })
    )
    writeFileSync(
      join(root, 'child/tsconfig.json'),
      JSON.stringify({
        compilerOptions: { composite: true, strict: true, declaration: true, outDir: './dist' },
        files: ['index.ts'],
      })
    )
    writeFileSync(join(root, 'child/index.ts'), 'export const value: number = "invalid";\n')
    const invoke = () =>
      spawnSync(process.execPath, [core, 'ci', 'type_check'], { cwd: root, encoding: 'utf8' })
    const failed = invoke()
    assert.equal(failed.status, 1, failed.stdout + failed.stderr)
    assert.match(failed.stdout + failed.stderr, /TS2322/)
    assert.equal(existsSync(join(root, 'child/dist')), false)
    writeFileSync(join(root, 'child/index.ts'), 'export const value: number = 1;\n')
    const passed = invoke()
    assert.equal(passed.status, 0, passed.stdout + passed.stderr)
    assert.equal(existsSync(join(root, 'child/dist')), false)
  }
)
test(
  'real Bun staged and changed formatting preserve scope and check-only index',
  { skip: !nativeBun },
  (t) => {
    const root = fixture(t, 'bun')
    writeFileSync(join(root, 'a.ts'), 'const a = 1;\n')
    writeFileSync(join(root, 'b.ts'), 'const b = 1;\n')
    git(root, 'add', 'a.ts', 'b.ts')
    git(
      root,
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'files'
    )
    writeFileSync(join(root, 'a.ts'), 'const a={x:1}\n')
    git(root, 'add', 'a.ts')
    writeFileSync(join(root, 'b.ts'), 'const b={x:2}\n')
    const before = git(root, 'show', ':a.ts')
    const invoke = (...args) =>
      spawnSync(process.execPath, [cli, 'format', '--target', root, ...args], { encoding: 'utf8' })
    assert.equal(invoke('--check', '--staged').status, 1)
    assert.equal(git(root, 'show', ':a.ts'), before)
    assert.equal(invoke('--staged').status, 0)
    assert.equal(git(root, 'show', ':a.ts'), readFileSync(join(root, 'a.ts'), 'utf8'))
    assert.equal(readFileSync(join(root, 'b.ts'), 'utf8'), 'const b={x:2}\n')
    assert.equal(invoke('--changed', 'HEAD').status, 0)
    assert.notEqual(readFileSync(join(root, 'b.ts'), 'utf8'), 'const b={x:2}\n')
    assert.equal(git(root, 'show', ':b.ts'), 'const b = 1;\n')
  }
)
