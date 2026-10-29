import assert from 'node:assert/strict'
import test from 'node:test'
import {
  QUALIFICATION_RECEIPT_ARTIFACT_PREFIX,
  QUALIFICATION_RECEIPT_KIND,
  QUALIFICATION_RECEIPT_MAX_AGE_MS,
  QUALIFICATION_RECEIPT_SCHEMA_VERSION,
  createQualificationReceipt,
  isQualificationReceipt,
  verifyQualificationReceipt,
} from '../src/lib/qualification-receipt.mjs'

const NOW = Date.parse('2026-10-29T12:00:00.000Z')
const sha = (digit) => digit.repeat(40)

function fixture(overrides = {}) {
  const receipt = {
    schema_version: QUALIFICATION_RECEIPT_SCHEMA_VERSION,
    kind: QUALIFICATION_RECEIPT_KIND,
    repository: '0xPlayerOne/consumer',
    workflow: {
      id: 42,
      path: '.github/workflows/validation.yml',
      sha: sha('1'),
      blob_sha: sha('2'),
    },
    run: {
      id: 1234,
      attempt: 2,
      event: 'pull_request',
      head_sha: sha('3'),
      created_at: '2026-10-27T10:00:00.000Z',
      required_job_names: ['CI', 'Test', 'Security', 'CodeQL', 'Eval', 'Gate'],
    },
    pull_request: {
      number: 77,
      base_repository: '0xPlayerOne/consumer',
      base_ref: 'main',
      base_sha: sha('4'),
      head_repository: '0xPlayerOne/consumer',
      head_ref: 'fix/source-change',
      head_sha: sha('3'),
    },
    mode: 'audit',
    tested: { sha: sha('5'), tree_sha: sha('6') },
    runtime: { repository: '0xPlayerOne/code-foundry', sha: sha('7'), tree_sha: sha('8') },
    jobs: {
      ci: 'success',
      test: 'success',
      security: 'success',
      codeql: 'success',
      eval: 'success',
      gate: 'success',
    },
  }
  const run = {
    id: 1234,
    run_attempt: 2,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    head_sha: sha('3'),
    head_branch: 'fix/source-change',
    workflow_id: 42,
    path: '.github/workflows/validation.yml',
    repository: { full_name: '0xPlayerOne/consumer' },
    head_repository: { full_name: '0xPlayerOne/consumer' },
    created_at: '2026-10-27T10:00:00.000Z',
    updated_at: '2026-10-27T11:00:00.000Z',
    pull_requests: [{ number: 77 }],
  }
  const pullRequest = {
    number: 77,
    state: 'closed',
    merged: true,
    merged_at: '2026-10-27T12:00:00.000Z',
    base: { repo: { full_name: '0xPlayerOne/consumer' }, ref: 'main', sha: sha('8') },
    head: {
      repo: { full_name: '0xPlayerOne/consumer' },
      ref: 'fix/source-change',
      sha: sha('3'),
    },
  }
  const artifact = {
    name: `${QUALIFICATION_RECEIPT_ARTIFACT_PREFIX}-1234-2`,
    expired: false,
    created_at: '2026-10-27T11:00:00.000Z',
    expires_at: '2026-11-03T11:00:00.000Z',
    workflow_run: { id: 1234, head_sha: sha('3') },
    size_in_bytes: 512,
    digest: `sha256:${'a'.repeat(64)}`,
    digest_verified: true,
  }
  const target = {
    repository: '0xPlayerOne/consumer',
    base_ref: 'main',
    base_tree_sha: sha('6'),
    workflow_id: 42,
    workflow_path: '.github/workflows/validation.yml',
    workflow_blob_sha: sha('2'),
    runtime_repository: '0xPlayerOne/code-foundry',
    runtime_tree_sha: sha('8'),
    codeql_enabled: true,
  }
  return {
    receipt: { ...receipt, ...overrides.receipt },
    run: { ...run, ...overrides.run },
    pullRequest: { ...pullRequest, ...overrides.pullRequest },
    artifact: { ...artifact, ...overrides.artifact },
    target: { ...target, ...overrides.target },
    expectedJobNames: overrides.expectedJobNames ?? receipt.run.required_job_names,
    jobs:
      overrides.jobs ??
      receipt.run.required_job_names.map((name) => ({
        name,
        run_id: 1234,
        head_sha: sha('3'),
        status: 'completed',
        conclusion: 'success',
      })),
    now: overrides.now ?? NOW,
  }
}

test('validates the strict receipt schema', () => {
  const valid = fixture().receipt
  assert.equal(isQualificationReceipt(valid), true)
  assert.equal(isQualificationReceipt(null), false)
  assert.equal(isQualificationReceipt({ ...valid, mode: 'release' }), false)
  assert.equal(isQualificationReceipt({ ...valid, tested: { tree_sha: 'short' } }), false)
  assert.equal(
    isQualificationReceipt({ ...valid, jobs: { ...valid.jobs, test: 'skipped' } }),
    false
  )
})

test('creates only complete schema-versioned receipts', () => {
  const valid = fixture().receipt
  const input = { ...valid }
  delete input.kind
  delete input.schema_version
  assert.deepEqual(createQualificationReceipt(input), valid)
  assert.throws(
    () => createQualificationReceipt({ ...input, tested: { sha: sha('5') } }),
    /incomplete qualification receipt/
  )
})

test('accepts exact recent merged-PR evidence for the current tree and runtime', () => {
  assert.deepEqual(verifyQualificationReceipt(fixture()), {
    verified: true,
    reason: 'exact recent source qualification verified',
  })
})

test('merged PR metadata and the exact run association are mandatory', () => {
  const input = fixture()
  delete input.pullRequest
  assert.equal(verifyQualificationReceipt(input).verified, false)
  assert.equal(verifyQualificationReceipt(fixture({ run: { pull_requests: [] } })).verified, false)
})

test('allows an explicitly no-CodeQL profile only when the target also disables CodeQL', () => {
  const input = fixture()
  input.receipt.jobs.codeql = 'not-configured'
  input.target.codeql_enabled = false
  assert.equal(verifyQualificationReceipt(input).verified, true)

  input.target.codeql_enabled = true
  assert.equal(verifyQualificationReceipt(input).verified, false)
})

test('rejects a different source tree, workflow, runtime, or repository', () => {
  for (const target of [
    { base_tree_sha: sha('9') },
    { workflow_blob_sha: sha('8') },
    { runtime_tree_sha: sha('9') },
    { repository: 'other/repository' },
  ]) {
    assert.equal(verifyQualificationReceipt(fixture({ target })).verified, false)
  }
})

test('rejects an unmerged, wrong, or ambiguous pull request association', () => {
  for (const pullRequest of [
    { merged: false },
    { number: 76 },
    { base: { repo: { full_name: 'other/repository' }, ref: 'main' } },
    { head: { repo: { full_name: '0xPlayerOne/consumer' }, ref: 'other-branch', sha: sha('3') } },
  ]) {
    assert.equal(verifyQualificationReceipt(fixture({ pullRequest })).verified, false)
  }

  assert.equal(
    verifyQualificationReceipt(
      fixture({ run: { pull_requests: [{ number: 76 }, { number: 77 }] } })
    ).verified,
    false
  )
  for (const pull_requests of [undefined, [], [{ number: 76 }]]) {
    assert.equal(verifyQualificationReceipt(fixture({ run: { pull_requests } })).verified, false)
  }
})

test('rejects a stale or unsuccessful run and every skipped source component', () => {
  const oldTime = NOW - QUALIFICATION_RECEIPT_MAX_AGE_MS - 1
  const oldDate = new Date(oldTime).toISOString()
  assert.equal(
    verifyQualificationReceipt(
      fixture({
        run: { created_at: oldDate, updated_at: oldDate },
        receipt: { run: { created_at: oldDate } },
      })
    ).verified,
    false
  )
  assert.equal(
    verifyQualificationReceipt(fixture({ run: { conclusion: 'failure' } })).verified,
    false
  )
  assert.equal(verifyQualificationReceipt(fixture({ run: { run_attempt: 1 } })).verified, false)

  for (const job of ['ci', 'test', 'security', 'codeql', 'eval', 'gate']) {
    assert.equal(
      verifyQualificationReceipt(
        fixture({ receipt: { jobs: { ...fixture().receipt.jobs, [job]: 'skipped' } } })
      ).verified,
      false,
      `${job} cannot be skipped`
    )
  }
})

test('rejects missing, expired, mismatched, or wrong-attempt artifacts', () => {
  for (const artifact of [
    { expired: true },
    { name: `${QUALIFICATION_RECEIPT_ARTIFACT_PREFIX}-1234-1` },
    { workflow_run: { id: 999, head_sha: sha('3') } },
    { expires_at: '2026-10-29T11:59:59.000Z' },
  ]) {
    assert.equal(verifyQualificationReceipt(fixture({ artifact })).verified, false)
  }
})

test('requires live successful jobs from the exact run attempt and current job contract', () => {
  const input = fixture()
  const requiredGate = input.expectedJobNames[0]
  const failures = [
    input.jobs.filter((job) => job.name !== requiredGate),
    input.jobs.map((job) => (job.name === requiredGate ? { ...job, conclusion: 'skipped' } : job)),
    input.jobs.map((job) => (job.name === requiredGate ? { ...job, run_id: 999 } : job)),
    input.jobs.map((job) => (job.name === requiredGate ? { ...job, head_sha: sha('9') } : job)),
    [...input.jobs, { ...input.jobs[0] }],
  ]
  for (const jobs of failures)
    assert.equal(verifyQualificationReceipt({ ...input, jobs }).verified, false)
  assert.equal(
    verifyQualificationReceipt({ ...input, expectedJobNames: ['CI', 'Test', 'Gate'] }).verified,
    false
  )
})

test('compares runtime content trees while retaining differing commit IDs for provenance', () => {
  const input = fixture()
  input.receipt.runtime.sha = sha('9')
  assert.equal(verifyQualificationReceipt(input).verified, true)
  input.receipt.runtime.tree_sha = sha('9')
  assert.equal(verifyQualificationReceipt(input).verified, false)
})
