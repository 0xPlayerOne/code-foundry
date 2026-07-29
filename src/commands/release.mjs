// @ts-check

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { approvedReleaseFiles, classifyReconciliation, readReleaseConfig } from '../lib/release-policy.mjs'

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

/** @param {string} root */
export function releaseConfigExists(root) {
  return existsSync(join(resolve(root), 'release-please-config.json'))
}
