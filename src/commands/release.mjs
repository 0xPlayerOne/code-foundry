// @ts-check

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { approvedReleaseFiles, buildReleaseRecoveryPlan, classifyReconciliation, readReleaseConfig, selectGeneratedReleasePrs, validateReleasePullRequests } from '../lib/release-policy.mjs'
import { hasDeliveredHook, releaseDeliveryKey, selectHookDelivery } from '../lib/release-hook.mjs'

/** @typedef {{ target: string, dryRun: boolean, github: boolean, base: string, head: string }} ReleaseOptions */

/**
 * Reconcile staging after Release Please updates main.
 *
 * Local mode is deterministic and suitable for CI; --github uses strict
 * lease-based mirror retries with fresh refetch/reclassification and fails
 * closed if classification or remote mutation fails.
 * @param {string} root
 * @param {ReleaseOptions} options
 */
export function reconcileRelease(root, options) {
  const target = resolve(root)
  const base = options.base || 'main'
  const head = options.head || 'staging'
  const allowed = approvedReleaseFiles(readReleaseConfig(target))
  let state = resolveReconciliationState(target, base, head, allowed, options.github)
  if (state.plan.action === 'fail') {
    throw new Error(formatReconciliationFailure(state.plan))
  }
  console.log(JSON.stringify({ base, head, ...state.plan }, null, 2))
  if (!['fast-forward', 'rebase-staging', 'aligned'].includes(state.plan.action) || !options.github || options.dryRun) return state.plan
  if (state.plan.action === 'aligned' && state.mainSha === state.stagingSha) return state.plan
  if (!process.env.GITHUB_REPOSITORY) throw new Error('GITHUB_REPOSITORY is required for --github reconciliation.')
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required for --github reconciliation.')
  const maxAttempts = 3
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    state = resolveReconciliationState(target, base, head, allowed, true)
    if (state.plan.action === 'fail') throw new Error(formatReconciliationFailure(state.plan))
    if (state.plan.action === 'aligned' && state.mainSha === state.stagingSha) return state.plan
    const mutation = executeReconciliationMutation(target, head, state)
    if (mutation.success) return { ...state.plan, ...mutation.result }
    if (!mutation.retry) throw new Error(mutation.error)
    const remoteSha = remoteRefSha(target, head)
    if (remoteSha === state.stagingSha) {
      throw new Error(`${head} synchronization was rejected by an exact lease while remote ${head} tip remained ${state.stagingSha}. ` +
        'Update branch protection or remote policy to permit this mutation, then retry.')
    }
  }
  throw new Error(`Reconciliation of ${head} was retried but failed while the branch moved concurrently.`)
}

/**
 * Resolve current reconciliation state and plan from current refs.
 * @param {string} target
 * @param {string} base
 * @param {string} head
 * @param {Set<string>} allowed
 * @param {boolean} requireRemote
 */
function resolveReconciliationState(target, base, head, allowed, requireRemote) {
  validateRefName(base)
  validateRefName(head)
  if (requireRemote) refreshRemoteRefs(target, base, head)
  const mainSha = resolveRef(target, base, requireRemote)
  const stagingSha = resolveRef(target, head, requireRemote)
  if (!mainSha || !stagingSha) {
    return {
      plan: {
        action: 'fail',
        reason: `Missing ${!mainSha ? `main (${base})` : `staging (${head})`} or staged branch ref during reconciliation.`,
      },
      mainSha,
      stagingSha,
      mainOnlyCommits: [],
      stagingOnlyCommits: [],
    }
  }
  try {
    const mainOnlyCommits = divergentCommits(target, stagingSha, mainSha)
    const stagingOnlyCommits = divergentCommits(target, mainSha, stagingSha)
    const plan = classifyReconciliation({
      mainSha,
      stagingSha,
      mainOnlyCommits,
      stagingOnlyCommits,
      allowed,
    })
    return { plan, mainSha, stagingSha, mainOnlyCommits, stagingOnlyCommits }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      plan: {
        action: 'fail',
        reason: `Failed to inspect divergent commits: ${message}`,
      },
      mainSha,
      stagingSha,
      mainOnlyCommits: [],
      stagingOnlyCommits: [],
    }
  }
}

/** @param {{ reason: string, unexpected?: string[] }} plan */
function formatReconciliationFailure(plan) {
  return `${plan.reason}${plan.unexpected?.length ? ` Unexpected paths: ${plan.unexpected.join(', ')}` : ''}`
}

/** @param {string} ref */
function validateRefName(ref) {
  const result = spawnSync('git', ['check-ref-format', '--branch', ref], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Invalid branch reference: ${ref}`)
}

/** @param {string} target @param {string} ref @param {boolean} requireRemote @returns {string} */
function resolveRef(target, ref, requireRemote) {
  const remote = git(target, ['rev-parse', `origin/${ref}`])
  if (remote) return remote
  if (!requireRemote) return git(target, ['rev-parse', ref])
  return ''
}

/** @param {string} target @param {string} base @param {string} head */
function refreshRemoteRefs(target, base, head) {
  const result = spawnSync('git', ['fetch', 'origin', base, head], { cwd: target, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Failed to refresh origin/${base} and origin/${head} before reconciliation.`)
}

/** @param {string} target @param {string} branch */
function remoteRefSha(target, branch) {
  const result = spawnSync('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], { cwd: target, encoding: 'utf8' })
  if (result.status !== 0) return ''
  const [sha] = result.stdout.trim().split(/\t/, 1)
  return sha || ''
}

/**
 * Reconcile a single attempt from fresh state.
 * @param {string} target
 * @param {string} head
 * @param {{
 *  plan: ReturnType<typeof classifyReconciliation>,
 *  mainSha: string,
 *  stagingSha: string,
 *  mainOnlyCommits: Array<{ sha: string, changedPaths: string[] }>,
 *  stagingOnlyCommits: Array<{ sha: string, changedPaths: string[] }>,
 * }} state
 */
function executeReconciliationMutation(target, head, state) {
  if (!state.plan.targetSha) return { success: false, retry: false, error: `No target SHA for ${head} reconciliation.` }
  if (state.plan.action === 'rebase-staging') {
    const replaySha = replayOntoMain(target, state.mainSha, state.stagingOnlyCommits)
    const push = pushWithLease(target, head, state.stagingSha, replaySha)
    if (push.status === 0) return { success: true, result: { synchronization: 'replay', replaySha } }
    return { success: false, retry: true, error: `Git push of replayed ${head} history failed: ${push.message}` }
  }
  const targetSha = /** @type {string} */ (state.plan.targetSha)
  const leased = pushWithLease(target, head, state.stagingSha, targetSha)
  if (leased.status === 0) return { success: true, result: { synchronization: state.plan.action === 'aligned' ? 'synced' : 'leased' } }
  return { success: false, retry: true, error: `${head} synchronization failed with lease: ${leased.message}` }
}

/** @param {string} target @param {string} head @param {string} expectedSha @param {string} tipSha */
function pushWithLease(target, head, expectedSha, tipSha) {
  const result = spawnSync('git', [
    'push',
    'origin',
    `--force-with-lease=refs/heads/${head}:${expectedSha}`,
    `${tipSha}:refs/heads/${head}`,
  ], { cwd: target, encoding: 'utf8' })
  return {
    status: result.status,
    message: result.stdout?.trim() || result.stderr?.trim() || `push with lease failed for ${head}.`,
  }
}

/**
 * Replay staging-only commits onto a detached worktree at main.
 * @param {string} target
 * @param {string} mainSha
 * @param {Array<{ sha: string, changedPaths: string[] }>} commits
 */
function replayOntoMain(target, mainSha, commits) {
  const orderedCommits = commits.map((commit) => commit.sha).filter(Boolean)
  if (!orderedCommits.length) return mainSha
  const workspace = mkdtempSync(join(tmpdir(), 'code-foundry-reconcile-'))
  const identityArgs = [
    '-c',
    'user.name=github-actions[bot]',
    '-c',
    'user.email=41898282+github-actions[bot]@users.noreply.github.com',
  ]
  try {
    const added = spawnSync('git', ['worktree', 'add', '--detach', workspace, mainSha], { cwd: target, encoding: 'utf8' })
    if (added.status !== 0) throw new Error(`Failed to create temporary replay worktree: ${added.stderr?.trim() || added.stdout?.trim()}`)
    for (const sha of orderedCommits) {
      const cherryPick = spawnSync('git', [...identityArgs, 'cherry-pick', sha], { cwd: workspace, encoding: 'utf8' })
      if (cherryPick.status !== 0) {
        spawnSync('git', ['cherry-pick', '--abort'], { cwd: workspace, encoding: 'utf8' })
        throw new Error(`Cherry-pick of ${sha} failed while replaying staging commits.`)
      }
    }
    const replayTip = git(workspace, ['rev-parse', 'HEAD'])
    if (!replayTip) throw new Error('Failed to resolve replay tip SHA.')
    const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', mainSha, replayTip], { cwd: workspace, encoding: 'utf8' })
    if (ancestry.status !== 0) throw new Error('Replayed head is not based on the current main tip.')
    return replayTip
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', workspace], { cwd: target, encoding: 'utf8' })
    rmSync(workspace, { recursive: true, force: true })
  }
}

/**
 * Dispatch a configured post-release workflow at most once for a tag.
 * @param {string} root
 * @param {{ tag: string, workflow: string, mode?: string, dryRun?: boolean }} options
 */
export function dispatchPostReleaseHook(root, options) {
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) throw new Error('GITHUB_REPOSITORY is required for post-release hooks.')
  if (!options.tag) throw new Error('--tag is required for post-release hooks.')
  const decision = selectHookDelivery({ mode: options.mode, tokenPresent: Boolean(process.env.RELEASE_PLEASE_TOKEN) })
  console.log(JSON.stringify({ repository, tag: options.tag, workflow: options.workflow, ...decision }, null, 2))
  if (decision.delivery === 'disabled' || decision.delivery === 'release-event') return decision
  if (decision.delivery === 'unavailable') throw new Error(decision.reason)
  if (!options.workflow) throw new Error('--workflow is required for workflow-dispatch hooks.')
  const key = releaseDeliveryKey(repository, options.tag)
  const runs = ghJson(root, ['run', 'list', '--repo', repository, '--workflow', options.workflow, '--limit', '100', '--json', 'headBranch,displayTitle,status'])
  if (hasDeliveredHook(Array.isArray(runs) ? runs : [], options.tag)) {
    console.log(`Post-release hook already delivered for ${options.tag}; skipping duplicate dispatch.`)
    return { ...decision, deliveryKey: key, skipped: true }
  }
  if (options.dryRun) return { ...decision, deliveryKey: key, dispatched: false }
  const result = spawnSync('gh', [
    'workflow', 'run', options.workflow,
    '--repo', repository,
    '--ref', options.tag,
    '--field', `release-tag=${options.tag}`,
    '--field', `delivery-key=${key}`,
  ], { cwd: resolve(root), stdio: 'inherit', env: { ...process.env, GH_TOKEN: process.env.RELEASE_PLEASE_TOKEN } })
  if (result.status !== 0) throw new Error(`Failed to dispatch post-release workflow ${options.workflow}.`)
  return { ...decision, deliveryKey: key, dispatched: true }
}

/** @param {string} root */
export function validateReleasePullRequestDiffs(root) {
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) throw new Error('GITHUB_REPOSITORY is required for release PR validation.')
  let prs = []
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = ghJson(root, ['pr', 'list', '--repo', repository, '--state', 'open', '--base', 'main', '--json', 'number,title,headRefName'])
    prs = Array.isArray(result) ? result : []
    if (selectGeneratedReleasePrs(prs).length) break
    if (attempt < 4) spawnSync('sleep', ['2'])
  }
  const generated = selectGeneratedReleasePrs(Array.isArray(prs) ? prs : [])
  /** @type {Map<number, string[]>} */
  const paths = new Map()
  for (const pr of generated) {
    const number = Number(pr.number)
    const result = spawnSync('gh', ['pr', 'diff', String(number), '--repo', repository, '--name-only'], { cwd: resolve(root), encoding: 'utf8' })
    paths.set(number, result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : [])
  }
  const validation = validateReleasePullRequests(Array.isArray(prs) ? prs : [], paths, approvedReleaseFiles(readReleaseConfig(root)))
  console.log(JSON.stringify(validation, null, 2))
  if (!validation.valid) throw new Error(validation.errors.join(' '))
  return validation
}

/** @param {string} root */
export function releaseRecoveryPlan(root) {
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) throw new Error('GITHUB_REPOSITORY is required for release recovery planning.')
  const tags = ghJson(root, ['api', `repos/${repository}/tags?per_page=100`])
  const releases = ghJson(root, ['release', 'list', '--repo', repository, '--limit', '100', '--json', 'tagName,name,isDraft,isPrerelease'])
  const releasePrs = ghJson(root, ['pr', 'list', '--repo', repository, '--state', 'open', '--base', 'main', '--json', 'number,title'])
  const packageVersions = localPackageVersions(root)
  const plan = buildReleaseRecoveryPlan({
    tags: Array.isArray(tags) ? tags.map((tag) => tag.name).filter(Boolean) : [],
    releases: Array.isArray(releases) ? releases : [],
    releasePrs: Array.isArray(releasePrs) ? releasePrs.filter((pr) => /^chore\(main\): release /.test(pr.title ?? '')) : [],
    packageVersions,
  })
  console.log(JSON.stringify(plan, null, 2))
  return plan
}

/** @param {string} root @param {string[]} args @returns {string} */
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}

/** @param {string} root @param {string} from @param {string} to @returns {Array<{ sha: string, changedPaths: string[] }>} */
function divergentCommits(root, from, to) {
  if (!from || !to || from === to) return []
  const result = spawnSync('git', [
    'log',
    '--cherry-pick',
    '--no-merges',
    '--left-right',
    '--reverse',
    '--pretty=tformat:%m%H',
    `${from}...${to}`,
  ], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`Failed to enumerate divergent commits between ${from} and ${to}. ${result.stderr?.trim() || result.stdout?.trim()}`)
  }
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('>'))
    .map((line) => ({
      sha: line.slice(1),
      changedPaths: commitChangedPaths(root, line.slice(1)),
    }))
    .filter((entry) => entry.sha)
}

/** @param {string} root @param {string} commitSha @returns {string[]} */
function commitChangedPaths(root, commitSha) {
  const result = spawnSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', commitSha], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Unable to read changed paths for commit ${commitSha}. ${result.stderr?.trim() || result.stdout?.trim()}`)
  return result.stdout.split(/\r?\n/).filter(Boolean)
}

/** @param {string} root @param {string[]} args @returns {unknown} */
function ghJson(root, args) {
  const token = process.env.RELEASE_PLEASE_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const result = spawnSync('gh', args, { cwd: resolve(root), encoding: 'utf8', env: { ...process.env, ...(token ? { GH_TOKEN: token } : {}) } })
  if (result.status !== 0) return []
  try { return JSON.parse(result.stdout) }
  catch { return [] }
}

/** @param {string} root @returns {string[]} */
function localPackageVersions(root) {
  const versions = []
  const packageJson = join(resolve(root), 'package.json')
  if (existsSync(packageJson)) {
    try { versions.push(JSON.parse(readFileSync(packageJson, 'utf8')).version) } catch { /* doctor handles malformed manifests */ }
  }
  /** @type {Array<[string, RegExp]>} */
  const manifests = [['Cargo.toml', /^version\s*=\s*["']([^"']+)["']/m], ['pyproject.toml', /^(?:version|version\s*)\s*=\s*["']([^"']+)["']/m]]
  for (const [file, pattern] of manifests) {
    const path = join(resolve(root), file)
    if (!existsSync(path)) continue
    const match = readFileSync(path, 'utf8').match(pattern)
    if (match?.[1]) versions.push(match[1])
  }
  return versions.filter(Boolean)
}

/** @param {string} root */
export function releaseConfigExists(root) {
  return existsSync(join(resolve(root), 'release-please-config.json'))
}
