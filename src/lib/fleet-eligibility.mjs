// @ts-check
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RELEASE_POLICY_FILE = '.code-foundry-release-policy.json'
/** @typedef {(command:string, args:string[]) => string} Run */
/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function ensure(condition, message) {
  if (!condition) throw new Error(message)
}
/** @type {Run} */
function runCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' },
  })
  ensure(
    !result.error && result.status === 0,
    `Fleet eligibility is unverified: ${command} failed (${result.status ?? result.error?.message})`
  )
  return result.stdout.trim()
}
/** @param {Buffer} bytes */
function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
/** @param {unknown} value */
export function validateReleasePolicy(value) {
  const policy = /** @type {Record<string, any>} */ (value)
  ensure(policy?.schema_version === 1, 'Expected a version-1 release policy')
  ensure(
    typeof policy.repository === 'string' &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(policy.repository) &&
      !policy.repository
        .split('/')
        .some((/** @type {string} */ part) => ['.', '..'].includes(part)),
    'Invalid release-policy repository'
  )
  ensure(
    typeof policy.workflow === 'string' &&
      /^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(policy.workflow),
    'Expected an exact qualification workflow path'
  )
  ensure(
    policy.branch === 'main' || policy.branch === 'staging',
    'Select a protected main or staging qualification branch'
  )
  ensure(
    Array.isArray(policy.required_jobs) &&
      policy.required_jobs.length > 0 &&
      policy.required_jobs.every(
        (/** @type {unknown} */ job) =>
          typeof job === 'string' && job.trim() === job && job.length > 0
      ) &&
      new Set(policy.required_jobs).size === policy.required_jobs.length,
    'Expected unique nonempty required qualification job names'
  )
  return policy
}
/** @param {unknown} value @param {string} property */
function pages(value, property) {
  ensure(Array.isArray(value) && value.length > 0, 'Missing paginated qualification evidence')
  /** @type {Record<string, any>[]} */
  const items = []
  let expected = 0
  for (const page of value) {
    ensure(
      Number.isInteger(page.total_count) && page.total_count >= 0 && Array.isArray(page[property]),
      'Malformed paginated qualification evidence'
    )
    expected = Math.max(expected, page.total_count)
    items.push(...page[property])
  }
  ensure(items.length >= expected, 'Incomplete qualification evidence pagination')
  return items
}
/** @param {string} root @param {string} source @param {string} version @param {Run} [run] */
export function assertFleetEligibility(root, source, version, run = runCommand) {
  const path = join(root, RELEASE_POLICY_FILE)
  let entry
  try {
    entry = lstatSync(path)
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null
    throw error
  }
  ensure(
    entry.isFile() && !entry.isSymbolicLink(),
    'Release policy must be a regular non-symlink file'
  )
  const bytes = readFileSync(path)
  const policy = validateReleasePolicy(JSON.parse(bytes.toString('utf8')))
  ensure(
    /^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version),
    'Qualified upgrades require an explicit version tag'
  )
  const git = (/** @type {string[]} */ args) => run('git', ['-C', source, ...args]).trim()
  const sourceSha = git(['rev-parse', 'HEAD'])
  ensure(
    /^[a-f0-9]{40}$/.test(sourceSha),
    'Qualified upgrades require a source Git checkout with an exact commit'
  )
  ensure(
    git(['status', '--porcelain', '--untracked-files=all']) === '',
    'Qualification cannot authorize a dirty runtime source'
  )
  // Execute the installed/trusted verifier, never code from the proposed source checkout.
  const verifier = fileURLToPath(new URL('../commands/release-integrity.mjs', import.meta.url))
  const verified = JSON.parse(
    run(process.execPath, [
      verifier,
      'release',
      '--repo',
      policy.repository,
      '--tag',
      version,
      '--expected-sha',
      sourceSha,
    ])
  )
  ensure(
    verified.status === 'passed' &&
      verified.check === 'release-attestation' &&
      verified.immutable === true &&
      verified.repository === policy.repository &&
      verified.tag === version &&
      verified.sourceSha === sourceSha,
    'Release identity was not cryptographically verified'
  )
  const api = (/** @type {string} */ endpoint, paginate = false) =>
    JSON.parse(
      run('gh', [
        'api',
        '--hostname',
        'github.com',
        endpoint,
        ...(paginate ? ['--paginate', '--slurp'] : []),
      ])
    )
  const workflow = api(
    `repos/${policy.repository}/actions/workflows/${encodeURIComponent(policy.workflow.split('/').at(-1))}`
  )
  ensure(
    Number.isSafeInteger(workflow.id) &&
      workflow.path === policy.workflow &&
      workflow.state === 'active',
    'Qualification workflow is missing, disabled, or has a different identity'
  )
  const runs = pages(
    api(
      `repos/${policy.repository}/actions/workflows/${workflow.id}/runs?head_sha=${sourceSha}&per_page=100`,
      true
    ),
    'workflow_runs'
  )
    .filter(
      (item) =>
        ['push', 'workflow_dispatch'].includes(item.event) && item.head_branch === policy.branch
    )
    // oxlint-disable-next-line unicorn/no-array-sort
    .sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)
  ensure(
    runs.every(
      (item) => Number.isSafeInteger(item.run_number) && Number.isSafeInteger(item.run_attempt)
    ),
    'Malformed qualification run ordering'
  )
  const current = runs[0]
  ensure(
    current &&
      Number.isSafeInteger(current.id) &&
      Number.isSafeInteger(current.run_attempt) &&
      current.run_attempt > 0 &&
      current.workflow_id === workflow.id &&
      current.path === policy.workflow &&
      current.head_sha === sourceSha &&
      current.repository?.full_name === policy.repository &&
      current.head_repository?.full_name === policy.repository,
    'No trusted qualification run matches the exact source and workflow'
  )
  ensure(
    current.status === 'completed' && current.conclusion === 'success',
    'Latest matching qualification has not passed; older successes do not authorize rollout'
  )
  const jobs = pages(
    api(
      `repos/${policy.repository}/actions/runs/${current.id}/attempts/${current.run_attempt}/jobs?per_page=100`,
      true
    ),
    'jobs'
  )
  for (const name of policy.required_jobs) {
    const matches = jobs.filter((job) => job.name === name)
    ensure(
      matches.length === 1 &&
        matches[0].status === 'completed' &&
        matches[0].conclusion === 'success',
      `Required qualification job did not pass: ${name}`
    )
  }
  const latest = api(`repos/${policy.repository}/actions/runs/${current.id}`)
  ensure(
    latest.run_attempt === current.run_attempt &&
      latest.head_sha === sourceSha &&
      latest.status === 'completed' &&
      latest.conclusion === 'success',
    'Qualification run changed during verification'
  )
  ensure(
    git(['rev-parse', 'HEAD']) === sourceSha &&
      git(['status', '--porcelain', '--untracked-files=all']) === '',
    'Runtime source changed during eligibility verification'
  )
  ensure(
    !lstatSync(path).isSymbolicLink() && hash(readFileSync(path)) === hash(bytes),
    'Release policy changed during verification'
  )
  return {
    schema_version: 1,
    kind: 'code-foundry-fleet-eligibility',
    status: 'passed',
    repository: policy.repository,
    tag: version,
    source_sha: sourceSha,
    policy_sha256: hash(bytes),
    workflow_id: workflow.id,
    run_id: current.id,
    run_attempt: current.run_attempt,
    required_jobs: policy.required_jobs,
  }
}
/** Every public upgrade path, including dry run, passes the same opt-in guard.
 * @template T @param {string} root @param {string} source @param {string} version
 * @param {() => T} operation @param {Run} [run]
 */
export function guardedFleetUpgrade(root, source, version, operation, run) {
  const eligibility = assertFleetEligibility(root, source, version, run)
  if (eligibility) console.error(JSON.stringify(eligibility))
  return operation()
}
