import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { percentile, runNodePackagePerformance } from '../src/lib/node-package-performance.mjs'

function fixture(budgets) {
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-node-performance-'))
  mkdirSync(join(root, 'dist'))
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture-package',
      version: '1.0.0',
      type: 'module',
      main: 'dist/index.js',
    })
  )
  writeFileSync(join(root, 'dist', 'index.js'), 'export const value = 42\n')
  writeFileSync(
    join(root, 'performance-package-budgets.json'),
    JSON.stringify({ schemaVersion: 1, samples: 3, budgets })
  )
  return root
}

test('percentile interpolates sorted samples', () => {
  assert.equal(percentile([30, 10, 20], 50), 20)
  assert.equal(percentile([0, 10], 95), 9.5)
})

test('node package performance writes reusable metrics and passes generous budgets', () => {
  const root = fixture({
    coldImportP95Ms: 10_000,
    coldImportRssMaxBytes: 1_000_000_000,
    packedBytes: 10_000_000,
    productionDependencyCount: 0,
  })
  const result = runNodePackagePerformance(root)
  assert.equal(result.passed, true)
  assert.equal(result.package, 'fixture-package')
  assert.equal(result.metrics.productionDependencyCount, 0)
  assert.ok(result.metrics.packedBytes > 0)
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, 'performance-results', 'node-package.json'), 'utf8')),
    result
  )
})

test('node package performance reports budget failures', () => {
  const result = runNodePackagePerformance(fixture({ packedBytes: 0 }))
  assert.equal(result.passed, false)
  assert.match(result.failures[0], /^packedBytes:/)
})

test('node package performance rejects unknown metrics', () => {
  assert.throws(
    () => runNodePackagePerformance(fixture({ mysteryMetric: 1 })),
    /unknown metric mysteryMetric/
  )
})
