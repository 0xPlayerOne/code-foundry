import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  classifyValidationMode,
  evaluateValidationGate,
  requiredValidationJobs,
} from '../src/lib/validation-policy.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('Release Please keeps CI, unit tests, and CodeQL without exact successful source evidence', () => {
  const mode = classifyValidationMode({
    eventName: 'pull_request',
    baseRef: 'main',
    headRef: 'release-please--branches--main--components--ui',
  })
  assert.equal(mode, 'release')
  assert.deepEqual(requiredValidationJobs(mode), ['ci', 'test', 'codeql'])
  assert.deepEqual(
    evaluateValidationGate({
      mode,
      results: {
        ci: 'success',
        test: 'success',
        security: 'skipped',
        codeql: 'success',
        eval: 'skipped',
      },
    }),
    { valid: true, required: ['ci', 'test', 'codeql'], failures: [] }
  )

  for (const results of [
    { ci: 'skipped', test: 'skipped', codeql: 'success' },
    { ci: 'failure', test: 'success', codeql: 'success' },
    { ci: 'success', test: 'cancelled', codeql: 'success' },
    { ci: 'success', test: 'success', codeql: 'skipped' },
  ]) {
    assert.equal(evaluateValidationGate({ mode, results }).valid, false)
  }
  assert.deepEqual(requiredValidationJobs('audit'), ['ci', 'test', 'security', 'codeql', 'eval'])
})

test('every release orchestrator runs source CI and tests until qualification evidence is implemented', () => {
  const workflow = readFileSync(join(root, '.github/workflows/validation.yml'), 'utf8')
  const noCodeql = readFileSync(join(root, '.github/workflows/validation-no-codeql.yml'), 'utf8')
  const billing = readFileSync(join(root, '.github/workflows/validation-billing.yml'), 'utf8')
  const job = (name, next) =>
    workflow.slice(workflow.indexOf(`  ${name}:`), workflow.indexOf(`\n  ${next}:`))
  const ci = job('ci', 'test')
  const tests = job('test', 'security')
  const codeql = job('codeql', 'eval')
  const gate = workflow.slice(workflow.indexOf('\n  gate:'))

  assert.match(ci, /inputs\.mode == 'fast'.*inputs\.mode == 'audit'.*inputs\.mode == 'release'/)
  assert.match(tests, /inputs\.mode == 'fast'.*inputs\.mode == 'audit'.*inputs\.mode == 'release'/)
  assert.match(
    tests,
    /unit-only: \$\{\{ inputs\.mode == 'fast' \|\| inputs\.mode == 'release' \}\}/
  )
  assert.match(codeql, /inputs\.mode == 'audit'.*inputs\.mode == 'release'/)
  assert.match(gate, /inputs\.mode == 'release'/)
  assert.match(gate, /validation release_diff/)

  for (const [name, source, next] of [
    ['ci', noCodeql, 'test'],
    ['test', noCodeql, 'security'],
  ]) {
    const section = source.slice(source.indexOf(`  ${name}:`), source.indexOf(`\n  ${next}:`))
    assert.match(
      section,
      /inputs\.mode == 'fast'.*inputs\.mode == 'audit'.*inputs\.mode == 'release'/
    )
  }
  assert.match(noCodeql, /FOUNDRY_CODEQL: success/)
  assert.match(noCodeql, /validation release_diff/)

  for (const [name, next] of [
    ['fast-lanes', 'lint'],
    ['lint', 'type-check'],
    ['type-check', 'unit'],
    ['unit', 'e2e'],
  ]) {
    const start = billing.indexOf(`  ${name}:`)
    const end = billing.indexOf(`\n  ${next}:`, start)
    const section = billing.slice(start, end)
    assert.doesNotMatch(section, /inputs\.mode != 'release'/)
  }
  assert.match(billing, /inputs\.mode == 'audit'.*inputs\.mode == 'release'/)
  assert.match(billing, /validation release_diff/)
})
