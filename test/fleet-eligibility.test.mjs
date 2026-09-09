import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertFleetEligibility, guardedFleetUpgrade, RELEASE_POLICY_FILE, validateReleasePolicy } from '../src/lib/fleet-eligibility.mjs'

const sha = 'a'.repeat(40)
const policy = { schema_version: 1, repository: 'owner/foundry', workflow: '.github/workflows/qualification.yml', branch: 'main', required_jobs: ['Node 20', 'Node 22', 'Node 24'] }
function fixture(t, configured = true) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-eligibility-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  if (configured) writeFileSync(join(root, RELEASE_POLICY_FILE), JSON.stringify(policy))
  return root
}
function evidence(overrides = {}) {
  const runInfo = { id: 88, run_number: 9, run_attempt: 2, workflow_id: 7, path: policy.workflow, head_sha: sha, head_branch: 'main', event: 'push', repository: { full_name: policy.repository }, head_repository: { full_name: policy.repository }, status: 'completed', conclusion: 'success', ...overrides.run }
  const jobs = policy.required_jobs.map((name) => ({ name, status: 'completed', conclusion: 'success' }))
  const calls = []
  const run = (command, args) => {
    calls.push([command, ...args])
    if (command === 'git') return args.includes('rev-parse') ? sha : (overrides.dirty ? ' M src/runtime.mjs' : '')
    if (command === process.execPath) return JSON.stringify({ status: 'passed', check: 'release-attestation', immutable: true, repository: policy.repository, tag: 'v1.2.3', sourceSha: sha, ...overrides.identity })
    const endpoint = args[3]
    if (endpoint.includes('/jobs?')) return JSON.stringify([{ total_count: 3, jobs: overrides.jobs ?? jobs }])
    if (endpoint.includes('/runs?')) return JSON.stringify([{ total_count: overrides.total ?? 1, workflow_runs: overrides.runs ?? [runInfo] }])
    if (endpoint.endsWith(`/actions/runs/${runInfo.id}`)) return JSON.stringify({ ...runInfo, ...overrides.latest })
    return JSON.stringify({ id: 7, path: policy.workflow, state: 'active', ...overrides.workflow })
  }
  return { run, calls, runInfo, jobs }
}
test('unconfigured roots retain legacy behavior without network access', (t) => {
  const root = fixture(t, false)
  assert.equal(assertFleetEligibility(root, root, 'unused', () => { throw Error('unexpected call') }), null)
  assert.equal(guardedFleetUpgrade(root, root, 'unused', () => 42), 42)
})
test('qualified release and all current-attempt jobs authorize the upgrade once', (t) => {
  const root = fixture(t)
  const { run, calls } = evidence()
  let operations = 0
  assert.equal(guardedFleetUpgrade(root, root, 'v1.2.3', () => ++operations, run), 1)
  assert.equal(operations, 1)
  assert.ok(calls.some((args) => args.some((value) => value.includes('/attempts/2/jobs?'))))
  assert.ok(calls.some((args) => args.includes('--expected-sha') && args.includes(sha)))
})
for (const [name, overrides] of [
  ['dirty source', { dirty: true }],
  ['unverified release', { identity: { status: 'failed' } }],
  ['mutable release', { identity: { immutable: false } }],
  ['wrong source', { identity: { sourceSha: 'b'.repeat(40) } }],
  ['wrong repository', { identity: { repository: 'other/repo' } }],
  ['pending qualification', { run: { status: 'in_progress', conclusion: null } }],
  ['failed qualification', { run: { conclusion: 'failure' } }],
  ['fork run', { run: { head_repository: { full_name: 'fork/repo' } } }],
  ['wrong workflow', { run: { workflow_id: 8 } }],
  ['PR qualification', { run: { event: 'pull_request' } }],
  ['disabled workflow', { workflow: { state: 'disabled_manually' } }],
  ['incomplete pagination', { total: 100 }],
  ['missing jobs', { jobs: [] }],
  ['rerun during verification', { latest: { run_attempt: 3 } }],
]) test(`reject ${name} before any upgrade callback`, (t) => {
  const root = fixture(t)
  let writes = 0
  assert.throws(() => guardedFleetUpgrade(root, root, 'v1.2.3', () => ++writes, evidence(overrides).run))
  assert.equal(writes, 0)
})
test('skipped required jobs are not successes', (t) => {
  const root = fixture(t)
  const { jobs } = evidence()
  jobs[0].conclusion = 'skipped'
  assert.throws(() => assertFleetEligibility(root, root, 'v1.2.3', evidence({ jobs }).run), /did not pass/)
})
test('an older successful run cannot override a newer failure', (t) => {
  const root = fixture(t)
  const { runInfo } = evidence()
  const newer = { ...runInfo, id: 90, run_number: 10, conclusion: 'failure' }
  assert.throws(() => assertFleetEligibility(root, root, 'v1.2.3', evidence({ runs: [runInfo, newer], total: 2 }).run), /Latest/)
})
test('malformed and dangling symlink policies fail instead of opting out', (t) => {
  const root = fixture(t, false)
  symlinkSync('missing.json', join(root, RELEASE_POLICY_FILE))
  assert.throws(() => assertFleetEligibility(root, root, 'v1.2.3'), /non-symlink/)
  assert.throws(() => validateReleasePolicy({ ...policy, required_jobs: [] }))
  assert.throws(() => validateReleasePolicy({ ...policy, workflow: '../qualification.yml' }))
  assert.throws(() => validateReleasePolicy({ ...policy, repository: '../repo' }))
})
test('source movement during verification invalidates eligibility', (t) => {
  const root = fixture(t)
  const original = evidence().run
  let heads = 0
  const run = (command, args) => command === 'git' && args.includes('rev-parse') && ++heads > 1 ? 'b'.repeat(40) : original(command, args)
  assert.throws(() => assertFleetEligibility(root, root, 'v1.2.3', run), /changed during/)
})
