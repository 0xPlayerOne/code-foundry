// @ts-check

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { approvedReleaseFiles, classifyReconciliation, readReleaseConfig } from '../lib/release-policy.mjs'
import { hasDeliveredHook, releaseDeliveryKey, selectHookDelivery } from '../lib/release-hook.mjs'

/** @typedef {{ target: string, dryRun: boolean, github: boolean, base: string, head: string }} ReleaseOptions */

/**
 * Reconcile staging after Release Please updates main. The local mode is
 * deterministic and suitable for CI; --github applies only a verified
 * fast-forward through the GitHub API and otherwise fails closed.
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
  const mainChangedPaths = diffNames(target, mergeBaseSha, mainSha)
  const stagingChangedPaths = diffNames(target, mergeBaseSha, stagingSha)
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
  if (plan.action !== 'fast-forward' || !options.github || options.dryRun) return plan
  if (!process.env.GITHUB_REPOSITORY) throw new Error('GITHUB_REPOSITORY is required for --github reconciliation.')
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required for --github reconciliation.')
  const result = spawnSync('gh', [
    'api', '--method', 'PATCH', `repos/${process.env.GITHUB_REPOSITORY}/git/refs/heads/${head}`,
    '-f', `sha=${plan.targetSha}`, '-F', 'force=false',
  ], { cwd: target, stdio: 'inherit', env: { ...process.env, GH_TOKEN: token } })
  if (result.status !== 0) throw new Error(`GitHub refused the protected fast-forward of ${head}.`)
  return plan
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

/** @param {string} root @param {string[]} args @returns {string} */
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}

/** @param {string} root @param {string} from @param {string} to @returns {string[]} */
function diffNames(root, from, to) {
  if (!from || !to || from === to) return []
  const result = spawnSync('git', ['diff', '--name-only', from, to], { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : []
}

/** @param {string} root @param {string[]} args @returns {unknown} */
function ghJson(root, args) {
  const result = spawnSync('gh', args, { cwd: resolve(root), encoding: 'utf8', env: { ...process.env, GH_TOKEN: process.env.RELEASE_PLEASE_TOKEN } })
  if (result.status !== 0) return []
  try { return JSON.parse(result.stdout) }
  catch { return [] }
}

/** @param {string} root */
export function releaseConfigExists(root) {
  return existsSync(join(resolve(root), 'release-please-config.json'))
}
