// @ts-check
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const QUEUE_CALLER = '.github/workflows/validation-merge-queue.yml'
export const QUEUE_MARKER = '# code-foundry-managed: merge-queue-v1\n'
/** @param {unknown} value @param {string} message @returns {asserts value} */
function ensure(value, message) {
  if (!value) throw new Error(message)
}

/** @param {unknown} value */
export function mergeQueueEnabled(value) {
  if (value === undefined || value === '' || value === false || value === 'false') return false
  if (value === true || value === 'true') return true
  throw new Error('merge_queue must be true or false')
}

/** Same version-pin policy as normal sync: released semver pins advance while
 * custom refs persist unless an explicit fleet runtime override is supplied.
 * @param {string | undefined} current @param {string} sourceVersion @param {string | undefined} override
 */
export function queueRuntimeRef(current, sourceVersion, override) {
  if (override !== undefined) return override
  if (!current || current === 'auto' || /^v\d+\.\d+\.\d+$/.test(current)) return `v${sourceVersion}`
  return current
}

/** @param {Record<string, string>} config @param {string} ref */
export function renderMergeQueueCaller(config, ref) {
  const repository = config.runtime_repository || '0xPlayerOne/code-foundry'
  ensure(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) &&
      !repository.split('/').some((part) => ['.', '..'].includes(part)),
    'Invalid queue runtime repository'
  )
  ensure(
    /^(?:[a-f0-9]{40}|v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/.test(ref),
    'Merge queues require a released version or exact commit pin, not a moving branch'
  )
  const topology = config.git_workflow || 'direct'
  ensure(['direct', 'staging-release'].includes(topology), 'Unsupported queue topology')
  const features = (config.features || 'all').split(/[\s,]+/)
  ensure(
    features.some((feature) =>
      ['all', 'validation', 'ci', 'test', 'security', 'codeql'].includes(feature)
    ),
    'Merge queues require the canonical PR validation caller'
  )
  const branches = topology === 'direct' ? ['main'] : ['main', 'staging']
  const workflow = config.codeql === 'false' ? 'validation-no-codeql.yml' : 'validation.yml'
  const runner = (/** @type {string} */ key, fallback = 'ubuntu-latest') => {
    const value = config[key] || config.runner || fallback
    ensure(/^[A-Za-z0-9_.-]+$/.test(value), `Unsupported queue runner label: ${key}`)
    return JSON.stringify(value)
  }
  const threads = config.codeql_rust_threads || '1'
  const parallel = config.codeql_rust_max_parallel || '1'
  ensure(
    /^(?:[1-9]|[1-5][0-9]|6[0-4])$/.test(threads),
    'Unsupported codeql_rust_threads; use an integer from 1 to 64.'
  )
  ensure(
    /^(?:[1-8])$/.test(parallel),
    'Unsupported codeql_rust_max_parallel; use an integer from 1 to 8.'
  )

  const rawShards = config.codeql_rust_shards || '["all"]'
  let shards
  try {
    shards = JSON.parse(rawShards)
  } catch {
    throw new Error('Invalid codeql_rust_shards; use a JSON array of relative Rust source paths.')
  }
  ensure(
    Array.isArray(shards) && shards.length > 0 && shards.length <= 8,
    'Invalid codeql_rust_shards; configure between 1 and 8 shards.'
  )
  const seen = new Set()
  for (const shard of shards) {
    ensure(
      typeof shard === 'string' && shard.length > 0 && shard.length <= 512 && !seen.has(shard),
      'Invalid codeql_rust_shards; shards must be unique non-empty strings.'
    )
    seen.add(shard)
    if (shard === 'all') continue
    for (const candidate of shard.split(',')) {
      const path = candidate.trim()
      ensure(
        Boolean(path) &&
          !path.startsWith('/') &&
          !path.split('/').includes('..') &&
          /^[A-Za-z0-9._/@+ -]+$/.test(path),
        `Invalid Rust CodeQL shard path: ${path || '(empty)'}`
      )
    }
  }
  // "all" combined with scoped shards is a deliberate consumer strategy: the
  // broad pass keeps the workspace-level SARIF category reporting while the
  // scoped shards add per-manifest detail. The renderer forwards the same
  // list to every lane, so lane parity holds regardless of the combination.
  return `${QUEUE_MARKER}name: Merge Queue

on:
  merge_group:
    types: [checks_requested]
    branches: [${branches.join(', ')}]

permissions:
  actions: read
  contents: read
  packages: read
  security-events: write

concurrency:
  group: code-foundry-merge-queue-\${{ github.repository }}-\${{ github.event.merge_group.head_ref }}
  cancel-in-progress: true

jobs:
  identity:
    name: Merge group identity
    if: vars.CI_BILLING_PAUSED != 'true'
    runs-on: ${runner('runner')}
    timeout-minutes: 5
    permissions:
      contents: read
    steps:
      - name: Checkout trusted identity verifier
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          persist-credentials: false
          repository: ${JSON.stringify(repository)}
          ref: ${JSON.stringify(ref)}
          path: .github/.code-foundry
          sparse-checkout: src/lib
      - name: Verify the exact merge-group commit
        env:
          FOUNDRY_QUEUE_BRANCHES: '${JSON.stringify(branches)}'
        run: node .github/.code-foundry/src/lib/merge-queue.mjs

  validation:
    name: Validation
    needs: identity
    if: vars.CI_BILLING_PAUSED != 'true'
    uses: ${repository}/.github/workflows/${workflow}@${ref}
    with:
      mode: audit
      runtime-repository: ${JSON.stringify(repository)}
      runtime-ref: ${JSON.stringify(ref)}
      ci-runner: ${runner('ci_runner')}
      test-runner: ${runner('test_runner')}
      unit-runner: ${runner('unit_runner', 'ubuntu-slim')}
      performance-runner: ${runner('performance_runner')}
      security-runner: ${runner('security_runner', 'ubuntu-slim')}
      eval-runner: ${runner('eval_runner')}
      codeql-runner: ${runner('codeql_runner')}
      rust-shards: '${JSON.stringify(shards)}'
      rust-threads: '${threads}'
      rust-max-parallel: ${parallel}
`
}

/** @param {Record<string, any>} payload @param {Record<string, string | undefined>} environment @param {unknown} branches */
export function validateMergeGroup(payload, environment, branches) {
  ensure(
    Array.isArray(branches) &&
      branches.length > 0 &&
      branches.every((branch) => ['main', 'staging'].includes(branch)) &&
      new Set(branches).size === branches.length,
    'Invalid allowed merge-queue branches'
  )
  ensure(
    environment.GITHUB_EVENT_NAME === 'merge_group' && payload.action === 'checks_requested',
    'Only merge_group checks_requested is accepted'
  )
  const group = payload.merge_group
  ensure(
    group &&
      /^[a-f0-9]{40}$/.test(group.head_sha ?? '') &&
      /^[a-f0-9]{40}$/.test(group.base_sha ?? ''),
    'Merge-group SHA identity is incomplete'
  )
  ensure(
    branches.some((branch) => group.base_ref === `refs/heads/${branch}`),
    'Merge-group base branch is not enabled'
  )
  const branch = group.base_ref.slice('refs/heads/'.length)
  ensure(
    typeof group.head_ref === 'string' &&
      group.head_ref.startsWith(`refs/heads/gh-readonly-queue/${branch}/`) &&
      group.head_ref.length > `refs/heads/gh-readonly-queue/${branch}/`.length,
    'Unexpected merge-group ref'
  )
  ensure(
    environment.GITHUB_SHA === group.head_sha && environment.GITHUB_REF === group.head_ref,
    'Workflow commit/ref differs from the merge group'
  )
  ensure(
    typeof environment.GITHUB_REPOSITORY === 'string' &&
      environment.GITHUB_REPOSITORY === payload.repository?.full_name,
    'Merge-group repository identity mismatch'
  )
  return {
    mode: 'audit',
    head_sha: group.head_sha,
    base_sha: group.base_sha,
    base_ref: group.base_ref,
  }
}

/** Refuse symlinked workflow paths and preserve unowned files, even with force.
 * @param {string} root @param {string | null} content
 */
export function inspectQueueCaller(root, content) {
  let current = resolve(root)
  for (const part of QUEUE_CALLER.split('/')) {
    current = join(current, part)
    let entry
    try {
      entry = lstatSync(current)
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
    }
    ensure(!entry?.isSymbolicLink(), 'Merge-queue workflow paths must not contain symlinks')
  }
  let existing = null
  try {
    existing = readFileSync(current, 'utf8')
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
  }
  if (existing !== null && !existing.startsWith(QUEUE_MARKER)) {
    ensure(
      content === null,
      'A repository-owned merge-queue caller already exists; refusing to overwrite it'
    )
    return { path: current, changed: false }
  }
  return { path: current, changed: existing !== content }
}

/** @param {string} root @param {string | null} content @param {boolean} [dryRun] */
export function syncQueueCaller(root, content, dryRun = false) {
  const plan = inspectQueueCaller(root, content)
  if (!plan.changed) return []
  if (dryRun) console.log(`Would ${content === null ? 'remove' : 'sync'} ${QUEUE_CALLER}`)
  else if (content === null) rmSync(plan.path, { force: true })
  else {
    mkdirSync(dirname(plan.path), { recursive: true })
    writeFileSync(plan.path, content)
  }
  return [QUEUE_CALLER]
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    ensure(process.env.GITHUB_EVENT_PATH, 'Missing GitHub event payload')
    console.log(
      JSON.stringify(
        validateMergeGroup(
          JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
          process.env,
          JSON.parse(process.env.FOUNDRY_QUEUE_BRANCHES || '[]')
        )
      )
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
