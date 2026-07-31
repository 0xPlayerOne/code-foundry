// @ts-check

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { approvedReleaseFiles, buildReleaseRecoveryPlan, classifyReconciliation, readReleaseConfig, selectGeneratedReleasePrs, validateReleasePullRequests } from '../lib/release-policy.mjs'
import { hasDeliveredHook, releaseDeliveryKey, selectHookDelivery } from '../lib/release-hook.mjs'

/** @typedef {{ target: string, dryRun: boolean, github: boolean, base: string, head: string }} ReleaseOptions */

/**
 * Reconcile staging after Release Please updates main. The local mode is
 * deterministic and suitable for CI; --github mirrors staging onto main's
 * tip through the GitHub API (fast-forward, then forced, then a linear sync
 * commit) and otherwise fails closed.
 * @param {string} root
 * @param {ReleaseOptions} options
 */
export function reconcileRelease(root, options) {
  const target = resolve(root)
  const base = options.base || 'main'
  const head = options.head || 'staging'
  const mainSha = git(target, ['rev-parse', `origin/${base}`]) || git(target, ['rev-parse', base])
  const stagingSha = git(target, ['rev-parse', `origin/${head}`]) || git(target, ['rev-parse', head])
  const mergeBaseSha = git(target, ['merge-base', mainSha, stagingSha])
  // Compare the branch tips directly. Release Please may rebase or recreate
  // commits during promotion, leaving equivalent code with different ancestry.
  // Comparing both tips preserves the fail-closed behavior for real content
  // differences without mistaking that normal history rewrite for a change.
  const mainChangedPaths = diffNames(target, stagingSha, mainSha)
  const stagingChangedPaths = diffNames(target, mainSha, stagingSha)
  const plan = classifyReconciliation({
    mainSha,
    stagingSha,
    mergeBaseSha,
    mainChangedPaths,
    stagingChangedPaths,
    allowed: approvedReleaseFiles(readReleaseConfig(target)),
  })
  console.log(JSON.stringify({ base, head, ...plan }, null, 2))
  if (plan.action === 'fail') throw new Error(plan.reason + (plan.unexpected?.length ? ` Unexpected paths: ${plan.unexpected.join(', ')}` : ''))
  if (!['fast-forward', 'pull-request', 'aligned'].includes(plan.action) || !options.github || options.dryRun) return plan
  if (!plan.targetSha) return plan
  if (!process.env.GITHUB_REPOSITORY) throw new Error('GITHUB_REPOSITORY is required for --github reconciliation.')
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required for --github reconciliation.')
  const targetSha = /** @type {string} */ (plan.targetSha)
  // 1. Verified fast-forward through the API (linear, no force).
  const fastForward = spawnSync('gh', [
    'api', '--method', 'PATCH', `repos/${process.env.GITHUB_REPOSITORY}/git/refs/heads/${head}`,
    '-f', `sha=${targetSha}`, '-F', 'force=false',
  ], { cwd: target, stdio: 'inherit', env: { ...process.env, GH_TOKEN: token } })
  if (fastForward.status === 0) return { ...plan, synchronization: 'fast-forward' }
  // 2. Forced update when staging may be rewritten without violating the
  // linear-history rule (main's tip is linear and already contains staging's
  // content, so nothing unpromoted is lost).
  const forced = spawnSync('gh', [
    'api', '--method', 'PATCH', `repos/${process.env.GITHUB_REPOSITORY}/git/refs/heads/${head}`,
    '-f', `sha=${targetSha}`, '-F', 'force=true',
  ], { cwd: target, stdio: 'inherit', env: { ...process.env, GH_TOKEN: token } })
  if (forced.status === 0) return { ...plan, synchronization: 'forced' }
  // 3. Linear sync commit fallback: staging keeps its history and receives
  // main's tree as a single-parent commit, which the ruleset always accepts.
  const syncSha = createLinearSyncCommit(target, stagingSha, targetSha)
  const push = spawnSync('git', ['push', 'origin', `${syncSha}:refs/heads/${head}`], { cwd: target, stdio: 'inherit', env: { ...process.env, GH_TOKEN: token } })
  if (push.status !== 0) throw new Error(`GitHub refused the linear synchronization of ${head}.`)
  return { ...plan, syncSha, synchronization: 'linear-commit' }
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

/**
 * Build a linear commit whose tree equals main's tip and whose parent is the
 * current staging tip. Staging requires linear history and main's tip almost
 * always sits behind promotion merge commits, so a direct fast-forward to
 * main's tip is rejected by the branch ruleset ("must not contain merge
 * commits"). A single-parent commit is always pushable and keeps staging
 * content-identical to main.
 * @param {string} root @param {string} parentSha @param {string} mainSha @returns {string}
 */
function createLinearSyncCommit(root, parentSha, mainSha) {
  const tree = git(root, ['rev-parse', `${mainSha}^{tree}`])
  if (!tree) throw new Error('Failed to resolve the target tree.')
  const identity = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com']
  const result = spawnSync('git', [...identity, 'commit-tree', tree, '-p', parentSha, '-m', 'chore(release): synchronize staging with main'], { cwd: resolve(root), encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Failed to create the synchronization commit: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

/** @param {string} root @param {string} from @param {string} to @returns {string[]} */
function diffNames(root, from, to) {
  if (!from || !to || from === to) return []
  const result = spawnSync('git', ['diff', '--name-only', from, to], { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : []
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
