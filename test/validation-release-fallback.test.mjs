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

function workflowJob(source, name) {
  const start = source.indexOf(`\n  ${name}:\n`)
  assert.notEqual(start, -1, `${name} job exists`)
  const jobStart = start + 1
  const next = /\n  [a-z0-9_-]+:\n/.exec(source.slice(jobStart))
  return source.slice(jobStart, next ? jobStart + next.index : undefined)
}

function workflowInputScalar(job, name) {
  const lines = job.split(/\r?\n/)
  const index = lines.findIndex((line) => new RegExp(`^\\s+${name}:`).test(line))
  assert.notEqual(index, -1, `${name} input exists`)
  const line = lines[index]
  const indent = line.length - line.trimStart().length
  const value = line.slice(line.indexOf(':') + 1).trim()
  if (value === '>-') {
    const block = []
    for (const next of lines.slice(index + 1)) {
      const nextIndent = next.length - next.trimStart().length
      if (next.trim() && nextIndent <= indent) break
      block.push(next.trim())
    }
    return block.join(' ').replace(/\s+$/, '')
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'")
  }
  if (value.startsWith('"')) return JSON.parse(value)
  return value
}

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
    assert.match(producer, /!cancelled\(\)/)
    assert.match(producer, /needs\.gate\.result == 'success'/)
    assert.match(producer, /phase: produce/)
    assert.match(producer, /enabled: \$\{\{ inputs\.release-qualification-receipts \}\}/)
  }

  assert.doesNotMatch(receiptWorkflow, /qualification-receipt\.mjs" (?:verify|produce)\s*>>/)
  assert.match(receiptWorkflow, /name: Code Foundry Qualification Receipt/)
  assert.match(receiptWorkflow, /actions: read/)
  assert.match(receiptWorkflow, /contents: read/)
  assert.match(receiptWorkflow, /pull-requests: read/)
  assert.match(receiptWorkflow, /node-version: 24\.18\.0/)
  assert.match(receiptWorkflow, /Check version-only release diff/)
  assert.match(receiptWorkflow, /validation release_diff/)
  assert.match(receiptWorkflow, /POLICY_READY: \$\{\{ steps\.release-policy\.outcome \}\}/)
  assert.match(receiptWorkflow, /reuse=false/)
  assert.match(receiptWorkflow, /using full validation/)
  assert.match(receiptWorkflow, /required-job-names-json/)
  assert.match(receiptWorkflow, /FOUNDRY_REQUIRED_JOB_NAMES_JSON/)
  assert.match(receiptWorkflow, /retention-days: 7/)
  assert.match(
    receiptWorkflow,
    /code-foundry-qualification-v2-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/
  )

  assert.match(workflow, /name: CodeQL/)
  assert.match(workflow, /qualification-receipt:[\s\S]*needs\.codeql\.result == 'success'/)
  assert.match(noCodeql, /FOUNDRY_CODEQL: success/)
  assert.match(noCodeql, /"codeql":"not-configured"/)
  assert.match(billing, /inputs\.codeql == true && \(\(needs\.codeql\.result == 'skipped'/)
  assert.match(billing, /name: Inspect versioned npm package contents/)

  assert.match(ci, /release-build-only:[\s\S]*default: false/)
  assert.match(ci, /release-package-check:[\s\S]*default: false/)
  assert.match(ci, /Build[\s\S]*npm pack --dry-run --ignore-scripts --json/)
  assert.match(ci, /node --input-type=module -e/)
  assert.match(ci, /src\/lib\/node-package-performance\.mjs/)
  assert.match(ci, /verifyNpmPackPackage\(report, manifest\)/)
  assert.match(
    ci,
    /Verify versioned package build contract[\s\S]*FOUNDRY_BUILD_TASK_APPLICABLE:[\s\S]*qualification-receipt\.mjs" package-contract/
  )
  const buildJob = ci.slice(ci.indexOf('\n  build:'))
  for (const lane of ['Setup', 'Build']) {
    const start = buildJob.indexOf(`      - name: ${lane}\n`)
    const end = buildJob.indexOf('\n      - name:', start + 1)
    const step = buildJob.slice(start, end < 0 ? undefined : end)
    assert.match(step, /applicability\.outputs\.applicable == 'true'/)
    assert.match(
      step,
      /inputs\.release-build-only == true \|\| steps\.applicability\.outputs\.affected != 'false'/
    )
  }
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
  assert.match(workflow, /required-job-names-json: '\["Validation \/ Gate"\]'/)
  assert.match(noCodeql, /required-job-names-json: '\["Validation \/ Gate"\]'/)
  assert.match(billing, /required-job-names-json: '\["Validation \/ Gate"\]'/)
  assert.match(
    readFileSync(join(root, '.github/workflows/validation_self-ci.yml'), 'utf8'),
    /pull-requests: read[\s\S]*runtime-ref: >-[\s\S]*startsWith\(github\.event\.pull_request\.head\.ref, 'release-please--branches--main'\)[\s\S]*github\.event\.pull_request\.base\.sha/
  )
  for (const [source, jobs] of [
    [workflow, ['ci', 'test', 'security', 'codeql', 'eval', 'gate']],
    [noCodeql, ['ci', 'test', 'security', 'eval', 'gate']],
    [billing, ['fast-lanes', 'lint', 'type-check', 'unit', 'e2e', 'audit', 'codeql', 'gate']],
  ]) {
    for (const name of jobs) {
      const start = source.indexOf(`\n  ${name}:\n`)
      assert.ok(start >= 0, `${name} job is present`)
      const section = source.slice(start + 1).split(/\n  [a-z0-9_-]+:\n/)[0]
      assert.match(section, /permissions:/, `${name} has a bounded job permission set`)
      assert.doesNotMatch(section, /pull-requests:/, `${name} does not inherit PR metadata access`)
    }
  }

  const billingFastPath = billing.slice(
    billing.indexOf('  fast-lanes:'),
    billing.indexOf('\n  lint:')
  )
  assert.match(billingFastPath, /name: Build/)
  assert.match(billingFastPath, /name: Verify versioned package build contract/)
  assert.match(billingFastPath, /name: Inspect versioned npm package contents/)
  assert.match(billingFastPath, /src\/commands\/qualification-receipt\.mjs/)
  assert.match(billingFastPath, /qualification-receipt\.mjs" package-contract/)
  assert.match(billingFastPath, /verifyNpmPackPackage\(report, manifest\)/)
  assert.doesNotMatch(billingFastPath, /Array\.isArray\(result\)/)
  for (const laneName of ['Setup build', 'Build']) {
    const start = billingFastPath.indexOf(`- name: ${laneName}\n`)
    const end = billingFastPath.indexOf('\n      - name:', start + 1)
    const step = billingFastPath.slice(start, end < 0 ? undefined : end)
    assert.match(step, /steps\.build_applicability\.outputs\.applicable == 'true'/)
    assert.match(
      step,
      /inputs\.mode == 'release' && needs\.qualification\.outputs\.reuse == 'true'/
    )
    assert.match(step, /steps\.build_applicability\.outputs\.affected != 'false'/)
  }
  assert.match(
    billing,
    /needs: qualification[\s\S]*inputs\.mode == 'release' && needs\.qualification\.outputs\.reuse == 'true'/
  )

  const billingReceiptProducer = workflowJob(billing, 'qualification-receipt')
  assert.deepEqual(
    JSON.parse(workflowInputScalar(billingReceiptProducer, 'required-job-names-json')),
    ['Validation / Gate']
  )

  const buildWorkflowJob = workflowJob(ci, 'build')
  const runtimeStepStart = buildWorkflowJob.indexOf('      - name: Runtime\n')
  const runtimeStepEnd = buildWorkflowJob.indexOf('\n      - name:', runtimeStepStart + 1)
  const runtimeStep = buildWorkflowJob.slice(runtimeStepStart, runtimeStepEnd)
  const sparseCheckout = runtimeStep.match(/sparse-checkout:\s*\|\n((?:\s{12,}.+\n?)+)/)
  assert.ok(sparseCheckout, 'Build runtime checkout has an explicit sparse path list')
  assert.ok(
    sparseCheckout[1]
      .split(/\r?\n/)
      .map((path) => path.trim())
      .includes('src/commands/qualification-receipt.mjs'),
    'Build checkout includes the package-contract command it executes'
  )
})
