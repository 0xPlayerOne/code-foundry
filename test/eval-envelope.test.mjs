import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateEvalBudgets, validateEvalReport } from '../src/lib/eval-envelope.mjs'

const stats = (count, values = [1, 2, 3]) =>
  count === 0
    ? { count: 0 }
    : { count, mean: values[0], p50: values[1], p95: values[2], max: values[2] }

const validReport = (overrides = {}) => ({
  schemaVersion: 1,
  revision: 'abc123',
  dependencyHash: 'def456',
  summary: {
    taskCount: 1,
    attempts: 1,
    passed: 1,
    failed: 0,
    harnessFailures: 0,
    successRate: 1,
    toolCalls: 3,
    evidenceErrors: 0,
    taskDurationMs: stats(1),
    startupMs: stats(1),
    stepDurationMs: stats(3),
  },
  tasks: [
    {
      id: 'form-submit',
      attempts: [
        {
          iteration: 1,
          status: 'passed',
          durationMs: 2.1,
          startupMs: 0.3,
          steps: [{ tool: 'fill_form', status: 'passed', durationMs: 0.4 }],
          checks: ['fill_form completed'],
          metrics: { formFields: 2 },
        },
      ],
    },
  ],
  ...overrides,
})

test('accepts a contract-conforming report', () => {
  const result = validateEvalReport(validReport())
  assert.deepEqual(result, { valid: true, errors: [] })
})

test('accepts empty stats objects', () => {
  const report = validReport({
    summary: {
      ...validReport().summary,
      taskDurationMs: { count: 0 },
      startupMs: { count: 0 },
      stepDurationMs: { count: 0 },
    },
  })
  assert.equal(validateEvalReport(report).valid, true)
})

test('rejects non-object reports', () => {
  for (const report of [null, 'text', 42, []]) {
    const result = validateEvalReport(report)
    assert.equal(result.valid, false)
    assert.ok(result.errors.length > 0)
  }
})

test('rejects a wrong schema version and non-string revision', () => {
  const result = validateEvalReport(validReport({ schemaVersion: 2, revision: 7 }))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((error) => /schemaVersion/.test(error)))
  assert.ok(result.errors.some((error) => /revision/.test(error)))
})

for (const summary of [
  { ...validReport().summary, passed: 2 },
  { ...validReport().summary, harnessFailures: 2 },
  { ...validReport().summary, successRate: 1.5 },
  { ...validReport().summary, toolCalls: -1 },
  { ...validReport().summary, taskDurationMs: { count: 1, mean: 1, p50: 1 } },
]) {
  test(`rejects invalid summary: ${JSON.stringify(Object.keys(summary).find((key) => summary[key] !== validReport().summary[key]))}`, () => {
    const result = validateEvalReport(validReport({ summary }))
    assert.equal(result.valid, false)
  })
}

test('requires failureClass with a failure and validates its enum', () => {
  const base = validReport()
  const attempt = base.tasks[0].attempts[0]
  const failed = {
    ...base,
    summary: { ...base.summary, passed: 0, failed: 1, successRate: 0 },
    tasks: [
      {
        id: 'task',
        attempts: [
          {
            ...attempt,
            status: 'failed',
            failure: { name: 'Error', message: 'Fixture assertion failed.' },
          },
        ],
      },
    ],
  }
  assert.equal(validateEvalReport(failed).valid, false)
  assert.ok(validateEvalReport(failed).errors.some((error) => /failureClass/.test(error)))

  const classified = JSON.parse(JSON.stringify(failed))
  classified.tasks[0].attempts[0].failureClass = 'somewhere-else'
  assert.equal(validateEvalReport(classified).valid, false)
})

test('validates step shape', () => {
  const base = validReport()
  base.tasks[0].attempts[0].steps = [{ tool: '', status: 'exploded', durationMs: 'fast' }]
  const result = validateEvalReport(base)
  assert.equal(result.valid, false)
  assert.equal(result.errors.filter((error) => /steps\[0\]/.test(error)).length, 3)
})

test('budgets gate on success rate, p95s, and maxima', () => {
  const report = validReport()
  assert.deepEqual(evaluateEvalBudgets(report, { successRate: 1, stepP95Ms: 500 }), {
    passed: true,
    failures: [],
  })
  const regressed = validReport()
  regressed.summary.successRate = 0.66
  regressed.summary.stepDurationMs = stats(3, [1, 2, 900])
  regressed.summary.harnessFailures = 1
  regressed.summary.evidenceErrors = 2
  const gate = evaluateEvalBudgets(regressed, {
    successRate: 1,
    stepP95Ms: 500,
    maxHarnessFailures: 0,
    maxEvidenceErrors: 1,
  })
  assert.equal(gate.passed, false)
  assert.equal(gate.failures.length, 4)
})

test('missing stats skip p95 budgets instead of failing', () => {
  const report = validReport({
    summary: { ...validReport().summary, startupMs: { count: 0 } },
  })
  assert.deepEqual(evaluateEvalBudgets(report, { startupP95Ms: 100 }), {
    passed: true,
    failures: [],
  })
})

test('unknown or invalid budget keys fail closed', () => {
  const report = validReport()
  assert.ok(!evaluateEvalBudgets(report, { stepP95: 100 }).passed)
  assert.ok(!evaluateEvalBudgets(report, { successRate: 'always' }).passed)
  assert.ok(!evaluateEvalBudgets(report, { stepP95Ms: 0 }).passed)
  assert.ok(!evaluateEvalBudgets(report, { maxToolCalls: -1 }).passed)
  assert.equal(evaluateEvalBudgets(null, {}).passed, false)
})
