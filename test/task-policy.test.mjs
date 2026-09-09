import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { describeTask, evidencePath, evaluateCoverage, fingerprint, parseCoverage, readTaskPolicy } from '../src/lib/task-policy.mjs'
import { runRuntime } from '../src/runtime.mjs'

function fixture(t, config = '') {
  const root = mkdtempSync(join(tmpdir(), 'foundry-policy-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.github'))
  mkdirSync(join(root, 'coverage'))
  writeFileSync(join(root, '.github/code-foundry.yml'), config)
  return root
}

const summary = (covered = 80) => JSON.stringify({ total: { lines: { total: 100, covered, pct: 100 } } })

for (const config of [
  'required_capabilities: typo',
  'required_capabilities: coverage\ncoverage_enforcement: off',
  'required_capabilities: performance\nperformance: false',
  'coverage_minimum: NaN',
  'coverage_minimum: 101',
  'coverage_metrics: typo',
  'coverage_enforcement: yes',
]) {
  test(`invalid policy fails closed: ${config.split('\n')[0]}`, (t) => {
    assert.throws(() => readTaskPolicy(fixture(t, config)))
  })
}

test('explicit performance and coverage imply required tasks', (t) => {
  const policy = readTaskPolicy(fixture(t, 'performance: true\ncoverage_enforcement: required'))
  assert.ok(policy.required.includes('performance'))
  assert.ok(policy.required.includes('unit'))
})

test('required task fails discovery rather than becoming inapplicable', (t) => {
  const root = fixture(t, 'required_capabilities: e2e')
  assert.throws(() => describeTask(root, 'e2e', { applicable: 'false' }), /Required capability e2e/)
})

test('JS project without a build command is not a passing native build', (t) => {
  const root = fixture(t)
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}')
  assert.equal(describeTask(root, 'build', { applicable: 'true', javascript: 'true' }).applicable, false)
})

test('repository scripts remain authoritative', (t) => {
  const root = fixture(t, 'required_capabilities: build')
  writeFileSync(join(root, 'package.json'), '{"scripts":{"build":"node build.mjs"}}')
  assert.equal(describeTask(root, 'build', { applicable: 'true' }).source, 'package-script:build')
})

test('coverage recomputes percentages instead of trusting pct', () => {
  assert.equal(parseCoverage(summary(79), 'json').lines.percent, 79)
})

test('LCOV totals are aggregated over source records', () => {
  const report = 'SF:a.ts\nLF:10\nLH:8\nend_of_record\nSF:b.ts\nLF:10\nLH:10\nend_of_record\n'
  assert.equal(parseCoverage(report, 'lcov').lines.percent, 90)
})

for (const value of ['{}', summary(-1), summary(101), '{"total":{"lines":{"total":0,"covered":0}}}']) {
  test(`malformed or empty coverage is rejected: ${value}`, () => {
    assert.throws(() => parseCoverage(value, 'json'))
  })
}

test('auto coverage absence is explicitly skipped', (t) => {
  const root = fixture(t)
  assert.equal(evaluateCoverage(root, readTaskPolicy(root), {}).status, 'skipped')
})

test('required coverage absence fails', (t) => {
  const root = fixture(t, 'coverage_enforcement: required')
  assert.throws(() => evaluateCoverage(root, readTaskPolicy(root), {}), /not produced/)
})

test('coverage below threshold fails despite a claimed 100 pct', (t) => {
  const root = fixture(t, 'coverage_minimum: 80')
  writeFileSync(join(root, 'coverage/coverage-summary.json'), summary(79))
  assert.throws(() => evaluateCoverage(root, readTaskPolicy(root), {}), /below 80/)
})

test('fresh threshold equality passes and stale evidence fails', (t) => {
  const root = fixture(t, 'coverage_enforcement: required')
  const file = join(root, 'coverage/coverage-summary.json')
  writeFileSync(file, summary())
  assert.equal(evaluateCoverage(root, readTaskPolicy(root), {}).status, 'passed')
  assert.throws(() => evaluateCoverage(root, readTaskPolicy(root), {
    'coverage/coverage-summary.json': fingerprint(file),
  }), /not refreshed/)
})

test('evidence cannot escape by traversal or symlink', (t) => {
  const root = fixture(t)
  assert.throws(() => evidencePath(root, '../outside.json'), /escapes/)
  assert.throws(() => evidencePath(root, '/tmp/report'), /relative/)
  symlinkSync('/etc/hosts', join(root, 'coverage/outside'))
  assert.throws(() => evidencePath(root, 'coverage/outside'), /symlink/)
})

for (const [exitCode, expected] of [[0, 'passed'], [7, 'failed']]) {
  test(`runtime preserves exit ${exitCode} and records ${expected}`, (t) => {
    const root = fixture(t)
    writeFileSync(join(root, 'package.json'), '{"scripts":{"build":"fake"}}')
    const core = join(root, 'executor.mjs')
    writeFileSync(core, `if (process.argv[3] === 'task_profile') console.log('applicable=true'); else process.exit(${exitCode})\n`)
    assert.equal(runRuntime(['ci', 'build'], root, core), exitCode)
    const result = JSON.parse(readFileSync(join(root, '.code-foundry/results/build.json'), 'utf8'))
    assert.equal(result.status, expected)
    assert.equal(result.commands[0].status, exitCode)
  })
}

test('runtime records optional skip without running executor', (t) => {
  const root = fixture(t)
  const core = join(root, 'executor.mjs')
  writeFileSync(core, "if (process.argv[3] === 'task_profile') console.log('applicable=false'); else process.exit(99)")
  assert.equal(runRuntime(['ci', 'e2e'], root, core), 0)
  const result = JSON.parse(readFileSync(join(root, '.code-foundry/results/e2e.json'), 'utf8'))
  assert.equal(result.status, 'skipped')
  assert.equal(result.commands.length, 0)
})

test('runtime records missing required task failure', (t) => {
  const root = fixture(t, 'required_capabilities: e2e')
  const core = join(root, 'executor.mjs')
  writeFileSync(core, "console.log('applicable=false')")
  assert.equal(runRuntime(['ci', 'e2e'], root, core), 1)
  const result = JSON.parse(readFileSync(join(root, '.code-foundry/results/e2e.json'), 'utf8'))
  assert.equal(result.status, 'failed')
  assert.match(result.reason, /Required capability/)
})

test('discovery checks other required tasks before allowing scheduling', (t) => {
  const root = fixture(t, 'required_capabilities: e2e')
  const core = join(root, 'executor.mjs')
  writeFileSync(core, "console.log('applicable=false')")
  assert.throws(() => runRuntime(['ci', 'task_profile', 'integration'], root, core), /Required capability e2e/)
  assert.equal(existsSync(join(root, '.code-foundry/results/integration.json')), false)
})
