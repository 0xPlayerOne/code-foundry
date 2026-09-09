import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const runtime = fileURLToPath(new URL('../src/runtime.mjs', import.meta.url))

function fixture(t, files = [], mixed = false) {
  const root = mkdtempSync(join(tmpdir(), 'foundry-rust-batch-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, content = '') => {
    const destination = join(root, path)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, content)
  }
  write('Cargo.toml', '[package]\nname = "fixture-app"\nversion = "0.1.0"\nedition = "2021"\n')
  write(
    '.github/code-foundry.yml',
    `languages: ${mixed ? 'typescript,python,rust' : 'rust'}\npackage_manager: ${mixed ? 'bun' : 'none'}\n`
  )
  for (const file of files) write(file)
  const log = join(root, 'commands.jsonl')
  for (const command of ['cargo', 'bun', 'python']) {
    write(
      `bin/${command}`,
      `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.BATCH_LOG, JSON.stringify({command: ${JSON.stringify(command)}, args, jobs: process.env.CARGO_BUILD_JOBS, flags: process.env.RUSTFLAGS}) + '\\n');\nif (${JSON.stringify(command)} === 'cargo' && process.env.FAIL_TARGET && args.includes(process.env.FAIL_TARGET)) process.exit(17);\n`
    )
    chmodSync(join(root, 'bin', command), 0o755)
  }
  if (mixed) {
    write(
      'package.json',
      JSON.stringify({ name: 'fixture', scripts: { 'test:unit': 'owned-unit' } })
    )
    write('pyproject.toml', '[project]\nname = "fixture"\nversion = "0.1.0"\n')
    write('tests/test_value.py')
  }
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  const run = (task, env = {}) => {
    const result = spawnSync(process.execPath, [runtime, 'ci', task], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        GITHUB_OUTPUT: '',
        GITHUB_STEP_SUMMARY: '',
        PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        BATCH_LOG: log,
        FAIL_TARGET: '',
        ...env,
      },
    })
    const calls = existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : []
    const receipt = JSON.parse(
      readFileSync(join(root, `.code-foundry/results/${task}.json`), 'utf8')
    )
    return { ...result, calls, receipt }
  }
  return { root, write, run }
}

for (const [name, files, args] of [
  ['library and binary', ['src/lib.rs', 'src/main.rs'], ['test', '--lib', '--bin', 'fixture-app']],
  ['library only', ['src/lib.rs'], ['test', '--lib']],
  ['binary only', ['src/main.rs'], ['test', '--bin', 'fixture-app']],
  ['default-target fallback', [], ['test']],
]) {
  test(`unit batches the same ${name} targets`, (t) => {
    const { run } = fixture(t, files)
    const result = run('unit')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(
      result.calls.map((call) => call.args),
      [args]
    )
    assert.equal(result.receipt.status, 'passed')
  })
}

const files = [
  'src/lib.rs',
  'src/main.rs',
  'tests/alpha.rs',
  'tests/beta_integration.rs',
  'tests/cache_smoke.rs',
  'tests/io_smoke.rs',
  'tests/login_e2e.rs',
  'tests/logout_e2e.rs',
  'tests/support/mod.rs',
]
for (const [task, targets] of [
  ['integration', ['alpha', 'beta_integration']],
  ['smoke', ['cache_smoke', 'io_smoke']],
  ['e2e', ['login_e2e', 'logout_e2e']],
]) {
  test(`${task} compiles every selected target in one Cargo invocation`, (t) => {
    const { run, write } = fixture(t, files)
    write('tests/untracked.rs')
    const result = run(task)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(
      result.calls.map((call) => call.args),
      [['test', ...targets.flatMap((target) => ['--test', target])]]
    )
    assert.equal(result.receipt.status, 'passed')
  })
}

test('one integration target keeps the existing command', (t) => {
  const result = fixture(t, ['tests/one.rs']).run('integration')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(
    result.calls.map((call) => call.args),
    [['test', '--test', 'one']]
  )
})

test('a missing optional category does not broaden to cargo test', (t) => {
  const result = fixture(t, ['src/lib.rs', 'tests/alpha.rs']).run('smoke')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.calls, [])
  assert.equal(result.receipt.status, 'skipped')
})

test('unit failure retains a failed public receipt and the Cargo exit status', (t) => {
  const result = fixture(t, ['src/lib.rs', 'src/main.rs']).run('unit', { FAIL_TARGET: '--lib' })
  assert.equal(result.status, 17, result.stderr)
  assert.equal(result.calls.length, 1)
  assert.deepEqual(result.calls[0].args, ['test', '--lib', '--bin', 'fixture-app'])
  assert.equal(result.receipt.status, 'failed')
})

test('failure in a later integration target fails the entire category', (t) => {
  const result = fixture(t, ['tests/alpha.rs', 'tests/zeta.rs']).run('integration', {
    FAIL_TARGET: 'zeta',
  })
  assert.equal(result.status, 17, result.stderr)
  assert.deepEqual(
    result.calls.map((call) => call.args),
    [['test', '--test', 'alpha', '--test', 'zeta']]
  )
  assert.equal(result.receipt.status, 'failed')
})

test('consumer Cargo job limits and compiler flags are preserved', (t) => {
  const result = fixture(t, ['src/lib.rs', 'src/main.rs']).run('unit', {
    CARGO_BUILD_JOBS: '2',
    RUSTFLAGS: '-C debuginfo=0',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.calls.length, 1)
  assert.equal(result.calls[0].jobs, '2')
  assert.equal(result.calls[0].flags, '-C debuginfo=0')
  assert.ok(!result.calls[0].args.includes('--jobs'))
})

test('mixed repositories retain their script and Python checks before native Rust', (t) => {
  const result = fixture(t, ['src/lib.rs', 'src/main.rs'], true).run('unit')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(
    result.calls.map(({ command, args }) => ({ command, args })),
    [
      { command: 'bun', args: ['run', 'test:unit'] },
      { command: 'python', args: ['-m', 'pytest', 'tests/test_value.py'] },
      { command: 'cargo', args: ['test', '--lib', '--bin', 'fixture-app'] },
    ]
  )
})
