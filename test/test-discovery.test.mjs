import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyTestFiles, isTestFile, testCategory } from '../src/lib/test-discovery.mjs'

test('recognizes native test files across supported languages', () => {
  assert.equal(isTestFile('src/value.test.ts'), true)
  assert.equal(isTestFile('tests/test_value.py'), true)
  assert.equal(isTestFile('tests/gateway_smoke.rs'), true)
  assert.equal(isTestFile('src/value.ts'), false)
})

test('classifies explicit category paths and suffixes', () => {
  assert.equal(testCategory('tests/unit/value.test.ts'), 'unit')
  assert.equal(testCategory('tests/integration/api.test.ts'), 'integration')
  assert.equal(testCategory('test/smoke/api.contract.test.ts'), 'smoke')
  assert.equal(testCategory('apps/web/e2e/browser.spec.ts'), 'e2e')
  assert.equal(testCategory('tests/cli.rs'), 'integration')
  assert.equal(testCategory('tests/gateway_smoke.rs'), 'smoke')
  assert.equal(testCategory('tests/test_live_infra.py'), 'smoke')
})

test('keeps unmarked tests in unit and filters categories without overlap', () => {
  const files = [
    'src/value.test.ts',
    'tests/integration/api.test.ts',
    'test/smoke/health.test.ts',
    'tests/browser.e2e.ts',
    'README.md',
  ]

  assert.deepEqual(classifyTestFiles(files, 'unit'), ['src/value.test.ts'])
  assert.deepEqual(classifyTestFiles(files, 'integration'), ['tests/integration/api.test.ts'])
  assert.deepEqual(classifyTestFiles(files, 'smoke'), ['test/smoke/health.test.ts'])
  assert.deepEqual(classifyTestFiles(files, 'e2e'), ['tests/browser.e2e.ts'])
})
