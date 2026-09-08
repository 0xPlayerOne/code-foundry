import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const runtime = new URL('../src/runtime.mjs', import.meta.url)

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-runtime-'))
  mkdirSync(join(root, '.github'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'tests', 'smoke'), { recursive: true })
  writeFileSync(
    join(root, '.github', 'code-foundry.yml'),
    'languages: typescript\npackage_manager: bun\n'
  )
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","private":true}\n')
  writeFileSync(join(root, 'src', 'value.test.ts'), '')
  writeFileSync(join(root, 'tests', 'smoke', 'health.test.ts'), '')
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  return root
}

test('task profile skips categories without discoverable tests', () => {
  const root = fixture()
  const output = execFileSync(
    process.execPath,
    [runtime.pathname, 'ci', 'task_profile', 'integration'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: '' },
    }
  )
  assert.match(output, /applicable=false/)
})

test('smoke execution passes only smoke files to Bun', () => {
  const root = fixture()
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const log = join(root, 'bun-args.log')
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$BUN_ARGS_LOG"\n')
  execFileSync('chmod', ['+x', join(bin, 'bun')])
  execFileSync(process.execPath, [runtime.pathname, 'ci', 'smoke'], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BUN_ARGS_LOG: log },
  })
  const args = readFileSync(log, 'utf8')
  assert.match(args, /test\n/)
  assert.match(args, /tests\/smoke\/health\.test\.ts/)
  assert.doesNotMatch(args, /src\/value\.test\.ts/)
})

test('performance task discovers and runs the repository check script', () => {
  const root = fixture()
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const log = join(root, 'bun-args.log')
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$BUN_ARGS_LOG"\n')
  chmodSync(join(bin, 'bun'), 0o755)
  writeFileSync(
    join(root, 'package.json'),
    '{"name":"fixture","private":true,"scripts":{"performance:check":"node perf.mjs"}}\n'
  )
  execFileSync('git', ['add', '.'], { cwd: root })

  const profile = execFileSync(
    process.execPath,
    [runtime.pathname, 'ci', 'task_profile', 'performance'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } }
  )
  assert.match(profile, /applicable=true/)

  execFileSync(process.execPath, [runtime.pathname, 'ci', 'performance'], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BUN_ARGS_LOG: log },
  })
  assert.equal(readFileSync(log, 'utf8'), 'run\nperformance:check\n')
  const summary = JSON.parse(
    readFileSync(join(root, 'performance-results', 'summary.json'), 'utf8')
  )
  assert.equal(summary.status, 'passed')
  assert.equal(summary.commands[0].source, 'package-script:performance:check')
})

test('performance task runs configured argv without shell interpolation', () => {
  const root = fixture()
  const probe = join(root, 'performance-probe')
  const log = join(root, 'performance-command.log')
  writeFileSync(probe, '#!/bin/sh\nprintf "%s\\n" "$@" > "$PERFORMANCE_ARGS_LOG"\n')
  chmodSync(probe, 0o755)
  writeFileSync(
    join(root, '.github', 'code-foundry.yml'),
    `languages: typescript\npackage_manager: bun\nperformance_command: '${JSON.stringify([probe, '--check', 'two words'])}'\n`
  )
  execFileSync('git', ['add', '.'], { cwd: root })

  execFileSync(process.execPath, [runtime.pathname, 'ci', 'performance'], {
    cwd: root,
    env: { ...process.env, PERFORMANCE_ARGS_LOG: log },
  })
  assert.equal(readFileSync(log, 'utf8'), '--check\ntwo words\n')
})

test('performance task runs configured commands in order and records the contract', () => {
  const root = fixture()
  const probe = join(root, 'performance-probe')
  const log = join(root, 'performance-command.log')
  writeFileSync(probe, '#!/bin/sh\nprintf "%s\\n" "$@" >> "$PERFORMANCE_ARGS_LOG"\n')
  chmodSync(probe, 0o755)
  const commands = [
    [probe, 'first'],
    [probe, 'second', 'two words'],
  ]
  writeFileSync(
    join(root, '.github', 'code-foundry.yml'),
    `languages: typescript\npackage_manager: bun\nperformance_command: '${JSON.stringify(commands)}'\n`
  )
  execFileSync('git', ['add', '.'], { cwd: root })

  execFileSync(process.execPath, [runtime.pathname, 'ci', 'performance'], {
    cwd: root,
    env: { ...process.env, PERFORMANCE_ARGS_LOG: log },
  })
  assert.equal(readFileSync(log, 'utf8'), 'first\nsecond\ntwo words\n')
  const summary = JSON.parse(
    readFileSync(join(root, 'performance-results', 'summary.json'), 'utf8')
  )
  assert.equal(summary.kind, 'code-foundry-performance-summary')
  assert.equal(summary.status, 'passed')
  assert.deepEqual(
    summary.commands.map((command) => command.status),
    [0, 0]
  )
})

test('performance false disables script and command discovery', () => {
  const root = fixture()
  writeFileSync(
    join(root, 'package.json'),
    '{"name":"fixture","private":true,"scripts":{"performance:check":"node perf.mjs"}}\n'
  )
  writeFileSync(
    join(root, '.github', 'code-foundry.yml'),
    'languages: typescript\npackage_manager: bun\nperformance: false\n'
  )
  execFileSync('git', ['add', '.'], { cwd: root })

  const profile = execFileSync(
    process.execPath,
    [runtime.pathname, 'ci', 'task_profile', 'performance'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } }
  )
  assert.match(profile, /applicable=false/)
})

test('performance command validation fails closed', () => {
  const root = fixture()
  writeFileSync(
    join(root, '.github', 'code-foundry.yml'),
    'languages: typescript\npackage_manager: bun\nperformance_command: not-json\n'
  )
  execFileSync('git', ['add', '.'], { cwd: root })

  assert.throws(
    () =>
      execFileSync(process.execPath, [runtime.pathname, 'ci', 'task_profile', 'performance'], {
        cwd: root,
        encoding: 'utf8',
      }),
    /performance_command must be a JSON argv array/
  )
})

test('lint skips the eslint fallback without repository-owned setup', () => {
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-lint-skip-'))
  writeFileSync(join(root, '.github-code-foundry-stub'), '')
  mkdirSync(join(root, '.github'), { recursive: true })
  writeFileSync(
    join(root, '.github', 'code-foundry.yml'),
    'languages: typescript\npackage_manager: npm\n'
  )
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","private":true}\n')
  writeFileSync(
    join(root, 'package-lock.json'),
    '{"name":"fixture","lockfileVersion":3,"packages":{}}\n'
  )
  writeFileSync(join(root, 'index.ts'), 'export const value = 1\n')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const log = join(root, 'npx-calls.log')
  writeFileSync(join(bin, 'npx'), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$NPX_ARGS_LOG"\nexit 0\n')
  execFileSync('chmod', ['+x', join(bin, 'npx')])
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  const result = execFileSync(process.execPath, [runtime.pathname, 'ci', 'lint'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NPX_ARGS_LOG: log },
  })
  assert.equal(result.status ?? 0, 0)
  assert.equal(existsSync(log), false, 'fallback must not invoke npx without eslint setup')
})

/**
 * Fixture with an npm lockfile plus an npx shim that records every call.
 * @param {string} prefix
 */
function npmFixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(root, '.github'), { recursive: true })
  writeFileSync(
    join(root, '.github', 'code-foundry.yml'),
    'languages: typescript\npackage_manager: npm\n'
  )
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","private":true}\n')
  writeFileSync(
    join(root, 'package-lock.json'),
    '{"name":"fixture","lockfileVersion":3,"packages":{}}\n'
  )
  writeFileSync(join(root, 'index.ts'), 'export const value = 1\n')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const log = join(root, 'npx-calls.log')
  writeFileSync(join(bin, 'npx'), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$NPX_ARGS_LOG"\nexit 0\n')
  execFileSync('chmod', ['+x', join(bin, 'npx')])
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  return { root, log }
}

/** @param {string} root @param {string} task @param {string} log */
function runCi(root, task, log) {
  return execFileSync(process.execPath, [runtime.pathname, 'ci', task], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, NPX_ARGS_LOG: log },
  })
}

test('lint prefers the oxlint fallback when an oxlint setup exists', () => {
  const { root, log } = npmFixture('code-foundry-oxlint-')
  writeFileSync(
    join(root, 'package.json'),
    '{"name":"fixture","private":true,"devDependencies":{"oxlint":"^1.81.0"}}\n'
  )
  execFileSync('git', ['add', '.'], { cwd: root })
  const result = runCi(root, 'lint', log)
  assert.equal(result.status ?? 0, 0)
  const calls = readFileSync(log, 'utf8')
  assert.match(calls, /--no-install\noxlint/)
  assert.doesNotMatch(calls, /eslint/)
})

test('lint never invokes eslint even when only an eslint setup exists', () => {
  const { root, log } = npmFixture('code-foundry-eslint-unsupported-')
  writeFileSync(
    join(root, 'package.json'),
    '{"name":"fixture","private":true,"devDependencies":{"eslint":"^9.0.0"}}\n'
  )
  execFileSync('git', ['add', '.'], { cwd: root })
  const result = runCi(root, 'lint', log)
  assert.equal(result.status ?? 0, 0)
  const calls = existsSync(log) ? readFileSync(log, 'utf8') : ''
  assert.doesNotMatch(calls, /eslint/)
  assert.doesNotMatch(calls, /oxlint/)
})

test('lint falls back to the repository lint script when oxlint is absent', () => {
  const { root, log } = npmFixture('code-foundry-script-fallback-')
  writeFileSync(
    join(root, 'package.json'),
    '{"name":"fixture","private":true,"scripts":{"lint":"touch consumer-lint-ran"}}\n'
  )
  execFileSync('git', ['add', '.'], { cwd: root })
  const result = runCi(root, 'lint', log)
  assert.equal(result.status ?? 0, 0)
  assert.equal(existsSync(join(root, 'consumer-lint-ran')), true, 'consumer lint script must run')
  const calls = existsSync(log) ? readFileSync(log, 'utf8') : ''
  assert.doesNotMatch(calls, /oxlint/)
  assert.doesNotMatch(calls, /eslint/)
})

test('format prefers the oxfmt fallback when an oxfmt setup exists', () => {
  const { root, log } = npmFixture('code-foundry-oxfmt-')
  writeFileSync(
    join(root, 'package.json'),
    '{"name":"fixture","private":true,"devDependencies":{"oxfmt":"^0.66.0"}}\n'
  )
  execFileSync('git', ['add', '.'], { cwd: root })
  const result = runCi(root, 'format', log)
  assert.equal(result.status ?? 0, 0)
  const calls = readFileSync(log, 'utf8')
  assert.match(calls, /--no-install\noxfmt\n--check\n\./)
  assert.doesNotMatch(calls, /prettier/)
})

test('format never invokes prettier even when only prettier is configured', () => {
  const { root, log } = npmFixture('code-foundry-prettier-unsupported-')
  writeFileSync(
    join(root, 'package.json'),
    '{"name":"fixture","private":true,"devDependencies":{"prettier":"^3.9.6"}}\n'
  )
  execFileSync('git', ['add', '.'], { cwd: root })
  const result = runCi(root, 'format', log)
  assert.equal(result.status ?? 0, 0)
  const calls = existsSync(log) ? readFileSync(log, 'utf8') : ''
  assert.doesNotMatch(calls, /prettier/)
  assert.doesNotMatch(calls, /oxfmt/)
})
