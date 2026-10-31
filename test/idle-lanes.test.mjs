import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { syncRepository } from '../src/commands/sync.mjs'

const source = process.cwd()
const runtime = new URL('../src/runtime.mjs', import.meta.url).pathname
const PLANNED = ['integration', 'e2e', 'smoke', 'performance', 'eval']
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== 'GITHUB_OUTPUT')
)

/** @param {string} name */
const workflow = (name) => readFileSync(join(source, '.github/workflows', name), 'utf8')

/** The job-level condition block of one job. @param {string} text @param {string} job */
function condition(text, job) {
  const block = text.slice(text.indexOf(`\n  ${job}:\n`) + 1)
  return block.slice(0, block.indexOf('runs-on:'))
}

/** @param {string} lane */
const skip = (lane) => `!contains(format(',{0},', inputs.idle-lanes), ',${lane},')`

/**
 * A committed repository: lane detection reads tracked files through git.
 * @param {{ scripts?: Record<string, string>, config?: string, files?: string[] }} options
 */
function repository({ scripts = {}, config = '', files = [] }) {
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-idle-lanes-'))
  mkdirSync(join(root, '.github'), { recursive: true })
  writeFileSync(
    join(root, '.github', 'code-foundry.yml'),
    `languages: typescript\npackage_manager: bun\n${config}`
  )
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts }))
  writeFileSync(join(root, 'bun.lock'), '')
  for (const file of files) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), '')
  }
  const git = (/** @type {string[]} */ args) =>
    execFileSync('git', args, { cwd: root, env, stdio: 'ignore' })
  git(['init', '-q'])
  git(['add', '-A'])
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture'])
  return root
}

/** @param {string} root @param {string[]} args */
function runtimeOutput(root, args) {
  return execFileSync(process.execPath, [runtime, ...args], { cwd: root, env, encoding: 'utf8' })
}

/** @param {string} root @returns {string[]} */
function idleLanes(root) {
  const line = runtimeOutput(root, ['validation', 'lanes']).match(/^idle_lanes=(.*)$/m)
  assert.ok(line, 'the planner always emits idle_lanes')
  return line[1] ? line[1].split(',') : []
}

test('the planner names lanes with no script, command, or test files', () => {
  const bare = repository({ scripts: { test: 'node --test' } })
  assert.deepEqual(idleLanes(bare), PLANNED)

  const scripted = repository({
    scripts: { test: 'node --test', 'test:e2e': 'playwright test', 'perf:check': 'node perf.mjs' },
  })
  assert.deepEqual(idleLanes(scripted), ['integration', 'smoke', 'eval'])

  const configured = repository({
    config: `eval_command: '["node","eval.mjs"]'\nperformance_command: '["node","perf.mjs"]'\n`,
    files: ['tests/integration/api.test.ts'],
  })
  assert.deepEqual(idleLanes(configured), ['e2e', 'smoke'])
})

test('a lane the repository opts out of is idle, a broken one is kept', () => {
  const optedOut = repository({ scripts: { eval: 'node eval.mjs' }, config: 'eval: false\n' })
  assert.ok(idleLanes(optedOut).includes('eval'))
  // Invalid configuration must surface in the lane's own job, not vanish.
  const broken = repository({ config: "eval_command: 'not json'\n" })
  assert.ok(!idleLanes(broken).includes('eval'))
})

test('the planner agrees with every lane its own Detect step would run', () => {
  for (const root of [
    repository({ scripts: { test: 'x' } }),
    repository({ scripts: { 'test:integration': 'x', smoke: 'x', eval: 'x' } }),
    repository({ files: ['e2e/home.spec.ts'], config: 'performance_command: \'["x"]\'\n' }),
  ]) {
    const idle = idleLanes(root)
    for (const lane of PLANNED) {
      const detect = runtimeOutput(root, [
        'ci',
        lane === 'eval' ? 'should_run' : 'task_profile',
        lane,
      ])
      assert.equal(
        /^applicable=false$/m.test(detect),
        idle.includes(lane),
        `${lane} planner and Detect step disagree`
      )
    }
  }
})

test('the mode job plans lanes and the caller forwards them to the orchestrator', () => {
  // Without these the orchestrator receives an empty list and every no-op
  // lane silently goes back to allocating a runner.
  const caller = workflow('validation_self-ci.yml')
  const mode = caller.slice(caller.indexOf('  mode:\n'), caller.indexOf('  validation:\n'))
  assert.match(mode, /idle-lanes: \$\{\{ steps\.lanes\.outputs\.idle_lanes \}\}/)
  assert.match(
    mode,
    /id: lanes\n\s+run: node "\$RUNNER_TEMP\/code-foundry\/src\/runtime\.mjs" validation lanes >> "\$GITHUB_OUTPUT"/
  )
  assert.match(caller, /^      idle-lanes: \$\{\{ needs\.mode\.outputs\.idle-lanes \}\}$/m)
})

test('every orchestrator accepts idle-lanes and skips only inside the lane workflows', () => {
  for (const name of ['validation.yml', 'validation-no-codeql.yml', 'validation-billing.yml']) {
    assert.match(
      workflow(name),
      /^      idle-lanes:\n\s+description:/m,
      `${name} declares idle-lanes`
    )
  }
  for (const name of ['validation.yml', 'validation-no-codeql.yml']) {
    const text = workflow(name)
    // Forwarded to both lane workflows; the gate still reads the unchanged
    // test and eval results, so a lane with work stays required.
    assert.equal(
      text.match(/^      idle-lanes: \$\{\{ inputs\.idle-lanes \}\}$/gm)?.length,
      2,
      name
    )
    assert.match(text, /FOUNDRY_TEST: \$\{\{ needs\.test\.result \}\}/)
    assert.match(text, /FOUNDRY_EVAL: \$\{\{ needs\.eval\.result \}\}/)
  }
  const lanes = workflow('test.yml')
  for (const [job, lane] of [
    ['performance', 'performance'],
    ['integration', 'integration'],
    ['integration-sharded', 'integration'],
    ['e2e', 'e2e'],
    ['smoke', 'smoke'],
  ]) {
    assert.ok(condition(lanes, job).includes(skip(lane)), `test.yml ${job} skips when idle`)
  }
  assert.ok(!condition(lanes, 'unit').includes('idle-lanes'), 'unit always keeps its job')
  assert.ok(condition(workflow('eval.yml'), 'eval').includes(skip('eval')))
  assert.ok(condition(workflow('validation-billing.yml'), 'e2e').includes(skip('e2e')))
})

test('rendered consumer callers plan lanes for every orchestrator variant', () => {
  for (const config of [{}, { codeql: 'false' }, { billing_lanes: 'true' }]) {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-idle-lanes-sync-'))
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
    const lines = Object.entries({ languages: 'typescript', package_manager: 'bun', ...config })
    writeFileSync(
      join(root, '.github', 'code-foundry.yml'),
      `${lines.map(([key, value]) => `${key}: ${value}`).join('\n')}\n`
    )
    writeFileSync(join(root, '.github', 'workflows', 'validation.yml'), 'name: caller\n')
    syncRepository({ target: root, source })
    const caller = readFileSync(join(root, '.github/workflows/validation.yml'), 'utf8')
    assert.match(caller, /runtime\.mjs" validation lanes >> "\$GITHUB_OUTPUT"/)
    assert.match(caller, /^      idle-lanes: \$\{\{ needs\.mode\.outputs\.idle-lanes \}\}$/m)
  }
})
