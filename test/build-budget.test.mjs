import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  buildBudgetSetting,
  evaluateBuildBudget,
  readBuildBudget,
} from '../src/lib/task-policy.mjs'
import { evaluateValidationGate } from '../src/lib/validation-policy.mjs'
import { runRuntime } from '../src/runtime.mjs'

const repository = fileURLToPath(new URL('../', import.meta.url))
const SECOND = 1_000_000_000n
const OPT_IN = 'build_budget_file: budgets.json\n'

/** @param {number} ceilingSeconds */
function budgets(ceilingSeconds) {
  return JSON.stringify({ schemaVersion: 1, lanes: { build: { ceilingSeconds } } })
}

/**
 * A consumer with a build script and a substitute executor that exits with
 * `exitCode` (or reports the task not applicable), so no package manager runs.
 * @param {import('node:test').TestContext} t
 * @param {{ config?: string, budget?: string | null, exitCode?: number, applicable?: boolean }} [options]
 */
function consumer(
  t,
  { config = OPT_IN, budget = budgets(300), exitCode = 0, applicable = true } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'foundry-build-budget-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.github'))
  writeFileSync(join(root, '.github/code-foundry.yml'), config)
  writeFileSync(join(root, 'package.json'), '{"scripts":{"build":"fake"}}')
  if (budget !== null) writeFileSync(join(root, 'budgets.json'), budget)
  const core = join(root, 'executor.mjs')
  const marker = join(root, 'executed')
  writeFileSync(
    core,
    `import { writeFileSync } from 'node:fs'
if (process.argv[3] === 'task_profile') console.log('applicable=${applicable}')
else { writeFileSync(${JSON.stringify(marker)}, ''); process.exit(${exitCode}) }
`
  )
  return { root, core, marker }
}

/** A clock whose consecutive readings are `start` and `start + elapsed`. @param {bigint} elapsed */
function fixedClock(elapsed) {
  const readings = [5n * SECOND, 5n * SECOND + elapsed]
  return () => {
    const value = readings.shift()
    assert.notEqual(value, undefined, 'the runtime read the clock more than twice')
    return /** @type {bigint} */ (value)
  }
}

/** @param {string} root */
function receipt(root) {
  return JSON.parse(readFileSync(join(root, '.code-foundry/results/build.json'), 'utf8'))
}

for (const [label, elapsed, exitCode, status, within] of [
  ['below the ceiling', 300n * SECOND - 1n, 0, 'passed', true],
  ['exactly at the ceiling', 300n * SECOND, 0, 'passed', true],
  ['one nanosecond above the ceiling', 300n * SECOND + 1n, 1, 'failed', false],
  ['far above the ceiling', 900n * SECOND, 1, 'failed', false],
]) {
  test(`an opted-in Build ${label} records the measurement and ${status}`, (t) => {
    const { root, core, marker } = consumer(t)
    assert.equal(runRuntime(['ci', 'build'], root, core, { clock: fixedClock(elapsed) }), exitCode)
    assert.equal(existsSync(marker), true)
    const result = receipt(root)
    assert.equal(result.status, status)
    assert.equal(result.commands[0].status, 0)
    assert.equal(result.buildBudget.file, 'budgets.json')
    assert.equal(result.buildBudget.lane, 'build')
    assert.equal(result.buildBudget.clock, 'monotonic')
    assert.equal(result.buildBudget.ceilingSeconds, 300)
    assert.equal(result.buildBudget.measuredNanoseconds, elapsed.toString())
    assert.equal(result.buildBudget.measuredSeconds, Number(elapsed) / 1e9)
    assert.equal(result.buildBudget.within, within)
    if (within) assert.doesNotMatch(String(result.reason), /ceiling/)
    else assert.match(result.reason, /over the 300s ceiling in budgets\.json/)
  })
}

test('fractional ceilings compare exactly in nanoseconds', () => {
  assert.equal(evaluateBuildBudget(1_500_000_000n, 1.5).within, true)
  assert.equal(evaluateBuildBudget(1_500_000_001n, 1.5).within, false)
})

test('the default clock is monotonic and measures the real executor', (t) => {
  const { root, core } = consumer(t, { budget: budgets(0.000001) })
  writeFileSync(
    core,
    `if (process.argv[3] === 'task_profile') console.log('applicable=true')
else { const end = Date.now() + 50; while (Date.now() < end); }
`
  )
  assert.equal(runRuntime(['ci', 'build'], root, core), 1)
  const result = receipt(root)
  assert.equal(result.status, 'failed')
  assert.ok(result.buildBudget.measuredSeconds >= 0.05)
  assert.equal(result.buildBudget.within, false)
})

for (const [label, budget, pattern] of [
  ['missing', null, /missing or unreadable: budgets\.json/],
  ['malformed', '{"schemaVersion": 1, "lanes": {', /not valid JSON/],
  ['a non-object', '[]', /must contain a JSON object/],
  [
    'an unsupported schema',
    JSON.stringify({ schemaVersion: 2, lanes: { build: { ceilingSeconds: 300 } } }),
    /unsupported schemaVersion 2/,
  ],
  [
    'without a schema',
    JSON.stringify({ lanes: { build: { ceilingSeconds: 300 } } }),
    /unsupported schemaVersion undefined/,
  ],
  ['without lanes', JSON.stringify({ schemaVersion: 1 }), /no lanes object/],
  [
    'without a build lane',
    JSON.stringify({ schemaVersion: 1, lanes: { unit: { ceilingSeconds: 1 } } }),
    /no lanes\.build entry/,
  ],
  [
    'without a ceiling',
    JSON.stringify({ schemaVersion: 1, lanes: { build: { baselineSeconds: 1 } } }),
    /ceilingSeconds must be a positive finite number/,
  ],
  ['a string ceiling', budgets('300'), /got "300"/],
  ['a zero ceiling', budgets(0), /got 0/],
  ['a negative ceiling', budgets(-1), /got -1/],
  [
    'a null ceiling',
    JSON.stringify({ schemaVersion: 1, lanes: { build: { ceilingSeconds: null } } }),
    /got null/,
  ],
]) {
  test(`an opted-in Build with ${label} budget data fails closed without building`, (t) => {
    const { root, core, marker } = consumer(t, { budget })
    assert.equal(runRuntime(['ci', 'build'], root, core, { clock: fixedClock(1n) }), 1)
    assert.equal(existsSync(marker), false)
    const result = receipt(root)
    assert.equal(result.status, 'failed')
    assert.equal(result.commands.length, 0)
    assert.match(result.reason, pattern)
  })
}

test('an opted-in budget path cannot escape the repository', (t) => {
  const { root, core, marker } = consumer(t, { config: 'build_budget_file: ../budgets.json\n' })
  assert.equal(runRuntime(['ci', 'build'], root, core), 1)
  assert.equal(existsSync(marker), false)
  assert.match(receipt(root).reason, /Build budget file is invalid: .*escapes repository/)
  assert.throws(() => readBuildBudget(root, '/etc/hosts'), /repository-relative/)
  symlinkSync('/etc/hosts', join(root, 'linked.json'))
  assert.throws(() => readBuildBudget(root, 'linked.json'), /symlink escapes/)
})

test('a consumer that has not opted in keeps the old Build behavior', (t) => {
  for (const config of ['', 'build_budget_file:\n', "build_budget_file: ''\n"]) {
    // A budget file alone is not an opt-in, even one this build would exceed.
    const { root, core } = consumer(t, { config, budget: budgets(1) })
    assert.equal(runRuntime(['ci', 'build'], root, core, { clock: fixedClock(900n * SECOND) }), 0)
    const result = receipt(root)
    assert.equal(result.status, 'passed')
    assert.equal(result.buildBudget, undefined)
    const absent = consumer(t, { config, budget: null })
    assert.equal(runRuntime(['ci', 'build'], absent.root, absent.core), 0)
  }
  assert.equal(buildBudgetSetting({}), null)
  assert.equal(buildBudgetSetting({ build_budget_file: '' }), null)
  assert.equal(buildBudgetSetting({ build_budget_file: 'budgets.json' }), 'budgets.json')
})

test('a failing opted-in Build keeps its exit code and still records the measurement', (t) => {
  for (const elapsed of [1n, 900n * SECOND]) {
    const { root, core } = consumer(t, { exitCode: 7 })
    assert.equal(runRuntime(['ci', 'build'], root, core, { clock: fixedClock(elapsed) }), 7)
    const result = receipt(root)
    assert.equal(result.status, 'failed')
    assert.equal(result.reason, 'executor exited 7')
    assert.equal(result.buildBudget.measuredNanoseconds, elapsed.toString())
    assert.equal(result.buildBudget.within, elapsed <= 300n * SECOND)
  }
})

test('a skipped opted-in Build stays skipped and never reads the budget', (t) => {
  const { root, core, marker } = consumer(t, { applicable: false, budget: null })
  assert.equal(runRuntime(['ci', 'build'], root, core), 0)
  assert.equal(existsSync(marker), false)
  const result = receipt(root)
  assert.equal(result.status, 'skipped')
  assert.equal(result.buildBudget, undefined)
})

test('the budget applies only to the Build lane', (t) => {
  const { root, core } = consumer(t, { budget: budgets(1) })
  writeFileSync(join(root, 'package.json'), '{"scripts":{"build":"fake","lint":"fake"}}')
  assert.equal(runRuntime(['ci', 'lint'], root, core, { clock: fixedClock(900n * SECOND) }), 0)
  const result = JSON.parse(readFileSync(join(root, '.code-foundry/results/lint.json'), 'utf8'))
  assert.equal(result.status, 'passed')
  assert.equal(result.buildBudget, undefined)
})

test('an over-budget Build fails the CI job and the aggregate Validation gate', (t) => {
  // 1. The runtime exits non-zero for an over-budget Build.
  const { root, core } = consumer(t)
  const exitCode = runRuntime(['ci', 'build'], root, core, { clock: fixedClock(301n * SECOND) })
  assert.equal(exitCode, 1)

  // 2. The Build step runs that runtime with nothing that could swallow the
  //    exit, so the Build job, and with it the reusable CI workflow, fails.
  const ci = readFileSync(join(repository, '.github/workflows/ci.yml'), 'utf8')
  const buildJob = ci.split('\n  build:\n')[1].split(/\n  [a-z0-9-]+:\n/)[0]
  const buildStep = buildJob.split('      - name: Build\n')[1].split('      - name:')[0]
  assert.match(buildStep, /run: node "\$RUNNER_TEMP\/code-foundry\/src\/runtime\.mjs" ci build\n/)
  assert.doesNotMatch(buildJob, /continue-on-error/)
  assert.doesNotMatch(buildStep, /\|\| true/)

  // 3. The Gate consumes the CI workflow's result for every mode.
  const validation = readFileSync(join(repository, '.github/workflows/validation.yml'), 'utf8')
  const gateJob = validation.split('\n  gate:\n')[1].split(/\n  [a-z0-9-]+:\n/)[0]
  assert.match(gateJob, /needs: \[ci, /)
  assert.match(gateJob, /FOUNDRY_CI: \$\{\{ needs\.ci\.result \}\}\n/)
  assert.match(gateJob, /runtime\.mjs" validation gate\n/)

  // 4. With CI failed and everything else green, the real gate command fails.
  const ciResult = exitCode === 0 ? 'success' : 'failure'
  for (const mode of ['fast', 'audit', 'release']) {
    const results = {
      ci: ciResult,
      test: 'success',
      security: 'success',
      codeql: 'success',
      eval: 'success',
    }
    const gate = evaluateValidationGate({ mode, results })
    assert.equal(gate.valid, false)
    assert.deepEqual(gate.failures, [{ job: 'ci', result: 'failure' }])
    const run = spawnSync(
      process.execPath,
      [join(repository, 'src/runtime.mjs'), 'validation', 'gate'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          FOUNDRY_MODE: mode,
          FOUNDRY_CI: ciResult,
          FOUNDRY_TEST: 'success',
          FOUNDRY_SECURITY: 'success',
          FOUNDRY_CODEQL: 'success',
          FOUNDRY_EVAL: 'success',
          FOUNDRY_QUALIFICATION: 'skipped',
        },
      }
    )
    assert.equal(run.status, 1, run.stderr)
    assert.match(run.stderr, /::error::ci: failure/)
  }
})
