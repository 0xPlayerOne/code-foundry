import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readTaskPolicy } from '../src/lib/task-policy.mjs'

const runtime = new URL('../src/runtime.mjs', import.meta.url)

/** @param {import('node:test').TestContext} t @param {string} config */
function fixture(t, config = 'languages: typescript\npackage_manager: npm\n') {
  const root = mkdtempSync(join(tmpdir(), 'foundry-eval-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.github'), { recursive: true })
  writeFileSync(join(root, '.github', 'code-foundry.yml'), config)
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","private":true}\n')
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  return root
}

const validReport = {
  schemaVersion: 1,
  revision: 'abc123',
  summary: {
    taskCount: 1,
    attempts: 1,
    passed: 1,
    failed: 0,
    harnessFailures: 0,
    successRate: 1,
    toolCalls: 1,
    evidenceErrors: 0,
    taskDurationMs: { count: 1, mean: 1, p50: 1, p95: 2, max: 2 },
    startupMs: { count: 1, mean: 0.1, p50: 0.1, p95: 0.2, max: 0.2 },
    stepDurationMs: { count: 1, mean: 0.1, p50: 0.1, p95: 0.2, max: 0.2 },
  },
  tasks: [
    {
      id: 'probe',
      attempts: [
        {
          iteration: 1,
          status: 'passed',
          durationMs: 1,
          steps: [{ tool: 'probe', status: 'passed', durationMs: 0.1 }],
        },
      ],
    },
  ],
}

/** @param {unknown} report @returns {string} */
function evalWriter(report) {
  return `import { mkdirSync, writeFileSync } from 'node:fs'
mkdirSync('eval-results', { recursive: true })
writeFileSync('eval-results/result.json', JSON.stringify(${JSON.stringify(report)}))
`
}

/** @param {string} root @param {string} script @param {string} config @param {import('node:test').TestContext} t */
function evalFixture(t, script, config) {
  const root = fixture(t, config)
  writeFileSync(
    join(root, 'package.json'),
    '{"name":"fixture","private":true,"scripts":{"eval":"node eval.mjs"}}\n'
  )
  writeFileSync(join(root, 'eval.mjs'), script)
  execFileSync('git', ['add', '.'], { cwd: root })
  return root
}

test('eval task profile skips without a script or command', (t) => {
  const root = fixture(t)
  const output = execFileSync(process.execPath, [runtime.pathname, 'ci', 'task_profile', 'eval'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: '' },
  })
  assert.match(output, /applicable=false/)
})

test('eval task discovers the repository script and validates the report', (t) => {
  const root = evalFixture(t, evalWriter(validReport))
  const profile = execFileSync(process.execPath, [runtime.pathname, 'ci', 'task_profile', 'eval'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: '' },
  })
  assert.match(profile, /applicable=true/)

  execFileSync(process.execPath, [runtime.pathname, 'ci', 'eval'], { cwd: root })
  const summary = JSON.parse(readFileSync(join(root, 'eval-results', 'summary.json'), 'utf8'))
  assert.equal(summary.status, 'passed')
  assert.equal(summary.commands[0].source, 'package-script:eval')
  assert.equal(summary.budgets.applied, false)
  assert.deepEqual(summary.artifacts, ['eval-results/result.json', 'eval-results/summary.json'])
})

test('eval task fails closed on a contract-violating report', (t) => {
  const root = evalFixture(
    t,
    `import { mkdirSync, writeFileSync } from 'node:fs'
mkdirSync('eval-results', { recursive: true })
writeFileSync('eval-results/result.json', JSON.stringify({ schemaVersion: 99 }))
`
  )
  const result = spawnSync(process.execPath, [runtime.pathname, 'ci', 'eval'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  })
  assert.notEqual(result.status, 0)
  const summary = JSON.parse(readFileSync(join(root, 'eval-results', 'summary.json'), 'utf8'))
  assert.equal(summary.status, 'failed')
  assert.match(summary.error, /violates the contract/)
})

test('eval budgets gate a measured regression', (t) => {
  const root = evalFixture(
    t,
    evalWriter({
      ...validReport,
      summary: { ...validReport.summary, passed: 0, failed: 1, successRate: 0 },
    }),
    'languages: typescript\npackage_manager: npm\neval_budget_file: eval-budgets.json\n'
  )
  writeFileSync(join(root, 'eval-budgets.json'), '{"successRate": 1.0, "stepP95Ms": 1000}')
  execFileSync('git', ['add', '.'], { cwd: root })

  const result = spawnSync(process.execPath, [runtime.pathname, 'ci', 'eval'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  })
  assert.notEqual(result.status, 0)
  const summary = JSON.parse(readFileSync(join(root, 'eval-results', 'summary.json'), 'utf8'))
  assert.equal(summary.status, 'failed')
  assert.equal(summary.budgets.applied, true)
  assert.ok(summary.budgets.failures.length > 0)
  assert.match(summary.error, /eval budgets failed/)
})

test('eval command configuration runs without shell interpolation', (t) => {
  const root = fixture(t)
  const probe = join(root, 'eval-probe')
  const log = join(root, 'eval-command.log')
  const report = JSON.stringify(validReport)
  writeFileSync(
    probe,
    `#!/bin/sh\nprintf "%s\\n" "$@" > "$EVAL_ARGS_LOG"\nmkdir -p eval-results\nprintf '%s' '${report}' > eval-results/result.json\n`
  )
  chmodSync(probe, 0o755)
  writeFileSync(
    join(root, '.github', 'code-foundry.yml'),
    `languages: typescript\npackage_manager: bun\neval_command: '${JSON.stringify([probe, '--strict', 'two words'])}'\n`
  )
  execFileSync('git', ['add', '.'], { cwd: root })

  execFileSync(process.execPath, [runtime.pathname, 'ci', 'eval'], {
    cwd: root,
    env: { ...process.env, EVAL_ARGS_LOG: log },
  })
  assert.equal(readFileSync(log, 'utf8'), '--strict\ntwo words\n')
})

test('eval: true makes the capability required and false contradicts requirements', (t) => {
  const root = fixture(t, 'languages: typescript\npackage_manager: npm\neval: true\n')
  assert.ok(readTaskPolicy(root).required.includes('eval'))
  const contradicting = fixture(
    t,
    'languages: typescript\nrequired_capabilities: eval\neval: false\n'
  )
  assert.throws(() => readTaskPolicy(contradicting))
})
