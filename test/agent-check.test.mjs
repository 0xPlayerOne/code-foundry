import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import test from 'node:test'
import {
  checkRepository,
  parseAgentArgs,
  planChecks,
  sourceContext,
} from '../src/commands/agent-check.mjs'

function fixture(t, { failure = '', applicable = ['build', 'unit'], config = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'foundry-agent-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.github'))
  writeFileSync(join(root, '.github/code-foundry.yml'), config)
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { build: 'fake', 'test:unit': 'fake' } })
  )
  writeFileSync(join(root, '.gitignore'), '.code-foundry/\n')
  const core = join(root, 'core.mjs')
  const runtime = join(root, 'runtime.mjs')
  writeFileSync(
    core,
    `if (process.argv[3] === 'task_profile') console.log('applicable=' + ${JSON.stringify(applicable)}.includes(process.argv[4])); else { console.log('PROJECT_STDOUT'); console.error('PROJECT_STDERR'); process.exit(process.argv[3] === ${JSON.stringify(failure)} ? 7 : 0) }`
  )
  const wrapper = new URL('../src/runtime.mjs', import.meta.url).href
  writeFileSync(
    runtime,
    `import { runRuntime } from ${JSON.stringify(wrapper)}; process.exitCode = runRuntime(process.argv.slice(2), process.cwd(), ${JSON.stringify(core)})`
  )
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  git('init', '--initial-branch=main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  git('add', '.')
  git('commit', '-m', 'fixture')
  return {
    root,
    paths: { core, runtime },
    git,
    options: parseAgentArgs(['check', '--target', root, '--json']),
  }
}

for (const args of [
  [],
  ['other'],
  ['plan', '--tier', 'release'],
  ['check', '--timeout', '0'],
  ['check', '--timeout', '1.5'],
  ['plan', '--base', 'main'],
  ['plan', '--timeout', '10'],
  ['check', '--json', '--json'],
  ['check', '--target'],
  ['plan', '--unknown'],
]) {
  test(`invalid agent CLI input fails: ${JSON.stringify(args)}`, () =>
    assert.throws(() => parseAgentArgs(args)))
}

test('plan is read-only and discovers all requirements even for a fast subset', (t) => {
  const { root, paths, options } = fixture(t)
  const plan = planChecks(options, paths)
  assert.equal(plan.tasks.length, 10)
  assert.equal(plan.tasks.find((entry) => entry.task === 'e2e').selected, false)
  assert.equal(plan.tasks.find((entry) => entry.task === 'performance').selected, true)
  assert.equal(plan.remoteValidationRequired, true)
  assert.equal(existsSync(join(root, '.code-foundry')), false)
})

test('changed plan ignores unrelated commits on an advanced base branch', (t) => {
  const { root, paths, options, git } = fixture(t)
  git('checkout', '-b', 'feature')
  writeFileSync(join(root, 'feature.txt'), 'feature')
  git('add', 'feature.txt')
  git('commit', '-m', 'feature change')
  git('checkout', 'main')
  writeFileSync(join(root, 'main-only.txt'), 'main')
  git('add', 'main-only.txt')
  git('commit', '-m', 'main change')
  git('checkout', 'feature')
  options.changed = true
  options.base = 'main'
  assert.deepEqual(planChecks(options, paths).changedFiles, ['feature.txt'])
})

test('missing required deferred task fails planning instead of misleading fast success', (t) => {
  const { paths, options } = fixture(t, { config: 'required_capabilities: e2e' })
  assert.throws(() => planChecks(options, paths), /Required capability e2e/)
})

test('changed plan includes staged, unstaged, and untracked paths without pruning tasks', (t) => {
  const { root, paths, options, git } = fixture(t)
  writeFileSync(join(root, 'staged.txt'), 'staged')
  git('add', 'staged.txt')
  writeFileSync(join(root, 'package.json'), '{"scripts":{"build":"fake","test:unit":"new"}}')
  writeFileSync(join(root, 'untracked name.txt'), 'new')
  options.changed = true
  const plan = planChecks(options, paths)
  assert.deepEqual(plan.changedFiles, ['package.json', 'staged.txt', 'untracked name.txt'])
  assert.equal(plan.tasks.length, 10)
  assert.equal(plan.dirty, true)
})

test('successful checks preserve fresh shared runtime receipts', (t) => {
  const { root, paths, options } = fixture(t)
  const report = checkRepository(options, paths)
  assert.equal(report.status, 'passed')
  assert.equal(report.tasks.filter((entry) => entry.status === 'passed').length, 2)
  assert.ok(existsSync(report.report))
  for (const entry of report.tasks.filter((item) => item.receipt)) {
    const receipt = JSON.parse(readFileSync(entry.receipt, 'utf8'))
    assert.equal(receipt.task, entry.task)
    assert.equal(receipt.status, 'passed')
  }
  assert.equal(existsSync(join(root, '.code-foundry/agent-results/active.lock')), false)
})

test('failed task blocks later applicable tasks and preserves its exit status', (t) => {
  const { paths, options } = fixture(t, { failure: 'build' })
  const report = checkRepository(options, paths)
  assert.equal(report.status, 'failed')
  assert.equal(report.tasks.find((task) => task.task === 'build').exitCode, 7)
  assert.equal(report.tasks.find((task) => task.task === 'unit').status, 'blocked')
})

test('successful child exit without fresh evidence fails', (t) => {
  const { root, paths, options } = fixture(t)
  writeFileSync(paths.runtime, 'process.exit(0)')
  mkdirSync(join(root, '.code-foundry/results'), { recursive: true })
  writeFileSync(join(root, '.code-foundry/results/build.json'), '{"status":"passed"}')
  const report = checkRepository(options, paths)
  assert.equal(report.status, 'failed')
  assert.match(report.tasks.find((task) => task.task === 'build').reason, /fresh/)
})

test('all optional skips are reported as skipped, not passed', (t) => {
  const { paths, options } = fixture(t, { applicable: [] })
  assert.equal(checkRepository(options, paths).status, 'skipped')
})

test('audit selects integration, E2E, and smoke without claiming remote gates ran', (t) => {
  const { paths, options } = fixture(t)
  options.tier = 'audit'
  const plan = planChecks(options, paths)
  assert.ok(plan.tasks.every((task) => task.selected))
  assert.ok(plan.deferredRemoteChecks.includes('CodeQL'))
})

test('existing check lock is preserved rather than stolen', (t) => {
  const { root, paths, options } = fixture(t)
  const lock = join(root, '.code-foundry/agent-results/active.lock')
  mkdirSync(lock, { recursive: true })
  assert.throws(() => checkRepository(options, paths), /Another agent check/)
  assert.ok(existsSync(lock))
})

test('escaping evidence directories are rejected', (t) => {
  const { root, paths, options } = fixture(t)
  symlinkSync('/tmp', join(root, '.code-foundry'))
  assert.throws(() => checkRepository(options, paths), /real directory/)
})

test('invalid revision cannot be mistaken for an empty change set', (t) => {
  const { options } = fixture(t)
  options.changed = true
  options.base = 'nonexistent-branch'
  assert.throws(() => sourceContext(options), /inspect repository/)
})

test('execution output stays on stderr while JSON remains parseable', (t) => {
  const { root, paths, options } = fixture(t)
  const module = new URL('../src/commands/agent-check.mjs', import.meta.url).href
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { checkRepository } from ${JSON.stringify(module)}; console.log(JSON.stringify(checkRepository(${JSON.stringify(options)}, ${JSON.stringify(paths)})))`,
    ],
    { cwd: root, encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).status, 'passed')
  assert.match(result.stderr, /PROJECT_STDOUT/)
  assert.match(result.stderr, /PROJECT_STDERR/)
})

test('public CLI dispatches plan help and emits structured argument errors', () => {
  const cli = new URL('../src/cli.mjs', import.meta.url)
  const help = spawnSync(process.execPath, [cli.pathname, 'plan', '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /code-foundry plan \[--target PATH\].*--base REF.*--json/s)
  const invalid = spawnSync(process.execPath, [cli.pathname, 'check', '--json', '--tier', 'typo'], {
    encoding: 'utf8',
  })
  assert.equal(invalid.status, 1)
  assert.equal(JSON.parse(invalid.stdout).kind, 'code-foundry-validation-error')
})
