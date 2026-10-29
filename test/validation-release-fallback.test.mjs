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

test('a verified receipt skips only duplicate source checks and keeps build, CodeQL, and receipt gates', () => {
  assert.deepEqual(requiredValidationJobs('release', { sourceQualification: true }), [
    'ci',
    'codeql',
    'qualification',
  ])
  assert.deepEqual(
    evaluateValidationGate({
      mode: 'release',
      sourceQualification: true,
      results: { ci: 'success', test: 'skipped', codeql: 'success', qualification: 'success' },
    }),
    { valid: true, required: ['ci', 'codeql', 'qualification'], failures: [] }
  )
  for (const results of [
    { ci: 'skipped', codeql: 'success', qualification: 'success' },
    { ci: 'success', codeql: 'success', qualification: 'skipped' },
    { ci: 'success', codeql: 'success', qualification: 'failure' },
    { ci: 'success', codeql: 'skipped', qualification: 'success' },
  ]) {
    assert.equal(
      evaluateValidationGate({ mode: 'release', sourceQualification: true, results }).valid,
      false
    )
  }
})

test('release reuse is opt-in, with a fail-closed full-validation fallback in every orchestrator', () => {
  const workflow = readFileSync(join(root, '.github/workflows/validation.yml'), 'utf8')
  const noCodeql = readFileSync(join(root, '.github/workflows/validation-no-codeql.yml'), 'utf8')
  const billing = readFileSync(join(root, '.github/workflows/validation-billing.yml'), 'utf8')
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
  const receiptWorkflow = readFileSync(
    join(root, '.github/workflows/qualification-receipt.yml'),
    'utf8'
  )

  for (const [source, nextJob] of [
    [workflow, 'ci'],
    [noCodeql, 'ci'],
    [billing, 'fast-lanes'],
  ]) {
    const start = source.indexOf('\n  qualification:')
    const qualification = source.slice(start, source.indexOf(`\n  ${nextJob}:`, start + 1))
    assert.match(qualification, /inputs\.mode == 'release'/)
    assert.match(qualification, /inputs\.release-qualification-receipts == true/)
    assert.match(qualification, /uses: \.\/\.github\/workflows\/qualification-receipt\.yml/)
    assert.match(qualification, /phase: verify/)
    assert.match(qualification, /codeql-enabled:/)
    assert.match(qualification, /runtime-ref: \$\{\{ inputs\.runtime-ref \}\}/)
    assert.match(qualification, /actions: read/)
  }

  for (const source of [workflow, noCodeql, billing]) {
    assert.match(source, /release-qualification-receipts:[\s\S]*default: false/)
    assert.match(source, /needs\.qualification\.outputs\.reuse == 'true'/)
    assert.match(
      source,
      /FOUNDRY_SOURCE_QUALIFICATION: \$\{\{ needs\.qualification\.outputs\.reuse \}\}/
    )
    assert.match(source, /FOUNDRY_QUALIFICATION: \$\{\{ needs\.qualification\.result \}\}/)
    const producer = source.slice(source.indexOf('\n  qualification-receipt:'))
    assert.match(producer, /uses: \.\/\.github\/workflows\/qualification-receipt\.yml/)
    assert.match(producer, /phase: produce/)
    assert.match(producer, /enabled: \$\{\{ inputs\.release-qualification-receipts \}\}/)
  }

  assert.match(receiptWorkflow, /name: Code Foundry Qualification Receipt/)
  assert.match(receiptWorkflow, /actions: read/)
  assert.match(receiptWorkflow, /contents: read/)
  assert.match(receiptWorkflow, /node-version: 24\.18\.0/)
  assert.match(receiptWorkflow, /Check version-only release diff/)
  assert.match(receiptWorkflow, /validation release_diff/)
  assert.match(receiptWorkflow, /POLICY_READY: \$\{\{ steps\.release-policy\.outcome \}\}/)
  assert.match(receiptWorkflow, /reuse=false/)
  assert.match(receiptWorkflow, /using full validation/)
  assert.match(receiptWorkflow, /retention-days: 7/)
  assert.match(
    receiptWorkflow,
    /code-foundry-qualification-v1-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/
  )

  assert.match(workflow, /name: CodeQL/)
  assert.match(workflow, /qualification-receipt:[\s\S]*needs\.codeql\.result == 'success'/)
  assert.match(noCodeql, /FOUNDRY_CODEQL: success/)
  assert.match(noCodeql, /"codeql":"not-configured"/)
  assert.match(billing, /inputs\.codeql == true && needs\.codeql\.result/)
  assert.match(billing, /name: Inspect versioned npm package contents/)

  assert.match(ci, /release-build-only:[\s\S]*default: false/)
  assert.match(ci, /release-package-check:[\s\S]*default: false/)
  assert.match(ci, /Build[\s\S]*npm pack --dry-run --ignore-scripts --json/)
  assert.match(ci, /result\[0\]\?\.version !== manifest\.version/)
  assert.match(
    workflow,
    /release-build-only: \$\{\{ inputs\.mode == 'release' && needs\.qualification\.outputs\.reuse == 'true' \}\}/
  )
  assert.match(
    workflow,
    /release-package-check: \$\{\{ inputs\.mode == 'release' && needs\.qualification\.outputs\.reuse == 'true' \}\}/
  )
  assert.match(
    noCodeql,
    /release-build-only: \$\{\{ inputs\.mode == 'release' && needs\.qualification\.outputs\.reuse == 'true' \}\}/
  )
  assert.match(
    noCodeql,
    /release-package-check: \$\{\{ inputs\.mode == 'release' && needs\.qualification\.outputs\.reuse == 'true' \}\}/
  )

  const billingFastPath = billing.slice(
    billing.indexOf('  fast-lanes:'),
    billing.indexOf('\n  lint:')
  )
  assert.match(billingFastPath, /name: Build/)
  assert.match(billingFastPath, /name: Inspect versioned npm package contents/)
  assert.match(
    billing,
    /needs: qualification[\s\S]*inputs\.mode == 'release' && needs\.qualification\.outputs\.reuse == 'true'/
  )
})
