// @ts-check

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { approvedReleaseFiles, buildReleaseRecoveryPlan, buildReconciliationPullRequestBody, classifyReconciliation, readReleaseConfig, reconciliationPullRequestBranch, reconciliationPullRequestTitle, selectGeneratedReleasePrs, selectReconciliationPullRequest, validateReleasePullRequests } from '../lib/release-policy.mjs'
import { hasDeliveredHook, releaseDeliveryKey, selectHookDelivery } from '../lib/release-hook.mjs'

/** @typedef {{ target: string, dryRun: boolean, github: boolean, base: string, head: string }} ReleaseOptions */

/**
 * Reconcile staging after Release Please updates main.
 *
 * Local mode is deterministic and suitable for CI; --github uses strict
 * lease-based mirror retries with fresh refetch/reclassification and fails
 * closed if classification or remote mutation fails. When the protected
 * staging branch rejects the exact lease push with a branch-policy/ruleset/
 * required-PR error, the mutation is delivered through an idempotent
 * automated synchronization pull request instead of failing the job.
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
    const mutation = executeReconciliationMutation(target, base, head, state)
    if (mutation.success === true) return { ...state.plan, ...(mutation.result ?? {}) }
    if (mutation.retry !== true) throw new Error(mutation.error ?? `${head} reconciliation failed.`)
    const remoteSha = remoteRefSha(target, head)
    if (remoteSha === state.stagingSha) {
      throw new Error(`${head} synchronization was rejected by an exact lease while remote ${head} tip remained ${state.stagingSha}. ` +
        'Update branch protection or remote policy to permit this mutation, then retry. ' +
        `Last failure detail: ${mutation.error ?? 'unknown synchronization failure'}`)
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
    const directChangedPaths = treeChangedPaths(target, stagingSha, mainSha)
    const plan = classifyReconciliation({
      mainSha,
      stagingSha,
      mainOnlyCommits,
      stagingOnlyCommits,
      directChangedPaths,
      allowed,
    })
    return { plan, mainSha, stagingSha, mainOnlyCommits, stagingOnlyCommits, directChangedPaths }
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
      directChangedPaths: [],
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

/** @param {string} target @param {string} branch @returns {string | null} */
function remoteRefSha(target, branch) {
  const result = spawnSync('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], { cwd: target, encoding: 'utf8' })
  if (result.status !== 0) return null
  const [sha] = result.stdout.trim().split(/\t/, 1)
  return sha || ''
}

/**
 * Reconcile a single attempt from fresh state.
 * @param {string} target
 * @param {string} base
 * @param {string} head
 * @param {{
 *  plan: ReturnType<typeof classifyReconciliation>,
 *  mainSha: string,
 *  stagingSha: string,
 *  mainOnlyCommits: Array<{ sha: string, changedPaths: string[] }>,
 *  stagingOnlyCommits: Array<{ sha: string, changedPaths: string[] }>,
 * }} state
 * @returns {{ success: false, retry: boolean, error: string } | { success: true, result: ReconciliationMutationResult }}
 */
function executeReconciliationMutation(target, base, head, state) {
  if (!state.plan.targetSha) return { success: false, retry: false, error: `No target SHA for ${head} reconciliation.` }
  if (state.plan.action === 'rebase-staging') {
    let replaySha
    try {
      replaySha = replayOntoMain(target, state.mainSha, state.stagingOnlyCommits)
    } catch (error) {
      return {
        success: false,
        retry: false,
        error: `Replay conflict while applying staging-only commits before replay: ${String(error instanceof Error ? error.message : error)}`,
      }
    }

    const push = pushWithLease(target, head, state.stagingSha, replaySha)
    if (push.status === 0) return { success: true, result: { synchronization: 'replay', replaySha } }
    const classification = classifyPushFailure(head, push.message)
    if (classification.category === 'authentication') {
      return {
        success: false,
        retry: false,
        error: `${head} authentication failed during replay push: ${classification.message}`,
      }
    }
    if (classification.category === 'policy') {
      return deliverReconciliationPullRequest(target, base, head, state, replaySha, { synchronization: 'replay', replaySha }, classification.message)
    }
    return { success: false, retry: true, error: `${head} synchronization failed with lease: ${classification.message}` }
  }
  const targetSha = /** @type {string} */ (state.plan.targetSha)
  const leased = pushWithLease(target, head, state.stagingSha, targetSha)
  if (leased.status === 0) return { success: true, result: { synchronization: state.plan.action === 'aligned' ? 'synced' : 'leased' } }
  const classification = classifyPushFailure(head, leased.message)
  if (classification.category === 'authentication') {
    return {
      success: false,
      retry: false,
      error: `${head} authentication failed during push: ${classification.message}`,
    }
  }
  if (classification.category === 'policy') {
    return deliverReconciliationPullRequest(target, base, head, state, targetSha, {}, classification.message)
  }
  return { success: false, retry: true, error: `${head} synchronization failed with lease: ${classification.message}` }
}

/** @typedef {{ number: number, url: string, base: string, head: string, branch: string, title: string, body: string }} ReconciliationPullRequest */

/** @typedef {{ synchronization: string, replaySha?: string, pullRequest?: ReconciliationPullRequest }} ReconciliationMutationResult */

/** @param {string} error @returns {{ success: false, retry: false, error: string }} */
function failResult(error) {
  return { success: false, retry: false, error }
}

/**
 * Deliver reconciliation through an automated synchronization pull request
 * when staging branch policy rejects the exact lease push. The head branch is
 * deterministic and namespaced, and reuse is keyed on the exact branch, base,
 * and title so stale or ambiguous state fails closed.
 * @param {string} target
 * @param {string} base
 * @param {string} head
 * @param {{
 *  plan: ReturnType<typeof classifyReconciliation>,
 *  mainSha: string,
 *  stagingSha: string,
 * }} state
 * @param {string} targetSha
 * @param {Record<string, unknown>} extra
 * @param {string} pushError
 * @returns {{ success: false, retry: false, error: string } | { success: true, result: ReconciliationMutationResult }}
 */
function deliverReconciliationPullRequest(target, base, head, state, targetSha, extra, pushError) {
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) return failResult('GITHUB_REPOSITORY is required to open a reconciliation pull request.')
  // base (main) is only the reconciliation source; the generated pull
  // request must target the protected head branch (staging), so the PR base
  // is always the reconcile head. Keep one named source of truth so the gh
  // create call, the reuse selector, and the result metadata cannot drift.
  const prBase = head
  const branch = reconciliationPullRequestBranch(base, head)
  const title = reconciliationPullRequestTitle({ targetHead: head, sourceBase: base })
  const body = buildReconciliationPullRequestBody({
    sourceBase: base,
    targetHead: head,
    mainSha: state.mainSha,
    stagingSha: state.stagingSha,
    targetSha,
    action: state.plan.action,
    pushError,
  })
  const expected = { targetBase: prBase, branch, title }
  let prs = listOpenHeadPullRequests(target, repository, branch)
  if (!prs) return failResult(`Failed to list open pull requests for reconciliation branch ${branch}.`)
  let selection = selectReconciliationPullRequest(prs, expected)
  if (selection.error) return failResult(selection.error)
  if (!selection.create) {
    if (!selection.reuse) return failResult(`No reusable reconciliation pull request for ${branch}.`)
    return reuseReconciliationPullRequest(target, repository, selection.reuse, targetSha, body)
  }
  const pushed = pushReconciliationHead(target, branch, targetSha)
  if (pushed.status !== 0) {
    const classification = classifyPushFailure(branch, pushed.message)
    if (classification.category === 'authentication') {
      return failResult(`${branch} authentication failed while pushing the reconciliation head: ${classification.message}`)
    }
    return failResult(`Failed to push the reconciliation head ${branch}: ${classification.message}`)
  }
  prs = listOpenHeadPullRequests(target, repository, branch)
  if (!prs) return failResult(`Failed to re-list open pull requests for reconciliation branch ${branch} after pushing its head.`)
  selection = selectReconciliationPullRequest(prs, expected)
  if (selection.error) return failResult(selection.error)
  if (!selection.create) {
    if (!selection.reuse) return failResult(`No reusable reconciliation pull request for ${branch} after pushing its head.`)
    return reuseReconciliationPullRequest(target, repository, selection.reuse, targetSha, body)
  }
  const created = ghSpawn(target, ['pr', 'create', '--repo', repository, '--base', prBase, '--head', branch, '--title', title, '--body', body])
  if (created.status !== 0) {
    // A concurrent run may have created the pull request between our list
    // and create; reuse it when it is exactly ours, otherwise fail closed.
    prs = listOpenHeadPullRequests(target, repository, branch)
    if (!prs) return failResult(`Failed to create the reconciliation pull request and to re-list open pull requests for ${branch}.`)
    selection = selectReconciliationPullRequest(prs, expected)
    if (selection.error) return failResult(selection.error)
    if (selection.create) {
      return failResult(`gh pr create failed for ${branch}: ${sanitizeReconcileOutput(created.stderr) || 'unknown error'}`)
    }
    if (!selection.reuse) return failResult(`No reusable reconciliation pull request for ${branch} after gh pr create failed.`)
    return reuseReconciliationPullRequest(target, repository, selection.reuse, targetSha, body)
  }
  const number = parsePullRequestNumber(created.stdout)
  if (!number) return failResult(`Created the reconciliation pull request for ${branch} but could not parse its number.`)
  const url = created.stdout.trim()
  return {
    success: true,
    result: {
      ...extra,
      synchronization: 'pull-request',
      pullRequest: { number, url, base: prBase, head: branch, branch, title, body },
    },
  }
}

/**
 * Refresh an existing reconciliation pull request to the exact target tip and
 * body. The head branch is pushed under an exact lease when its tip is stale,
 * so a concurrent move fails closed instead of being clobbered.
 * @param {string} target
 * @param {string} repository
 * @param {{number?: number, title?: string, headRefName?: string, headRefOid?: string, baseRefName?: string, url?: string}} pr
 * @param {string} targetSha
 * @param {string} body
 * @returns {{ success: false, retry: false, error: string } | { success: true, result: ReconciliationMutationResult }}
 */
function reuseReconciliationPullRequest(target, repository, pr, targetSha, body) {
  const number = Number(pr.number)
  if (String(pr.headRefOid ?? '') !== targetSha) {
    const pushed = pushReconciliationHead(target, /** @type {string} */ (pr.headRefName), targetSha)
    if (pushed.status !== 0) {
      return failResult(`Failed to refresh the reconciliation branch ${pr.headRefName} to the target tip: ${sanitizeReconcileOutput(pushed.message)}`)
    }
    const edited = ghSpawn(target, ['pr', 'edit', String(number), '--repo', repository, '--body', body])
    if (edited.status !== 0) {
      return failResult(`Failed to update reconciliation pull request #${number}: ${sanitizeReconcileOutput(edited.stderr) || 'unknown error'}`)
    }
  }
  return {
    success: true,
    result: {
      synchronization: 'pull-request',
      pullRequest: {
        number,
        url: pr.url ?? '',
        base: pr.baseRefName ?? '',
        head: pr.headRefName ?? '',
        branch: pr.headRefName ?? '',
        title: pr.title ?? '',
        body,
      },
    },
  }
}

/**
 * Push the exact target tip to the deterministic reconciliation head branch,
 * creating it when absent and refreshing it under an exact lease otherwise.
 * @param {string} target @param {string} branch @param {string} targetSha
 */
function pushReconciliationHead(target, branch, targetSha) {
  const existingTip = remoteRefSha(target, branch)
  if (existingTip === null) return { status: 1, message: `could not resolve the remote reconciliation branch ${branch} before pushing.` }
  if (existingTip === targetSha) return { status: 0, message: '' }
  if (!existingTip) {
    const result = spawnSync('git', ['push', 'origin', `${targetSha}:refs/heads/${branch}`], { cwd: target, encoding: 'utf8' })
    const message = `${result.stdout?.trim() || ''}\n${result.stderr?.trim() || ''}`.trim() || `failed to create reconciliation branch ${branch}.`
    return { status: result.status, message: sanitizeReconcileOutput(message) }
  }
  return pushWithLease(target, branch, existingTip, targetSha)
}

/**
 * @param {string} target
 * @param {string} repository
 * @param {string} branch
 * @returns {Array<{number?: number, title?: string, headRefName?: string, headRefOid?: string, baseRefName?: string, url?: string}> | null}
 */
function listOpenHeadPullRequests(target, repository, branch) {
  const result = ghSpawn(target, ['pr', 'list', '--repo', repository, '--state', 'open', '--head', branch, '--json', 'number,title,headRefName,headRefOid,baseRefName,url'])
  if (result.status !== 0) return null
  try {
    const prs = JSON.parse(result.stdout)
    return Array.isArray(prs) ? prs : null
  } catch {
    return null
  }
}

/** @param {string} stdout @returns {number | null} */
function parsePullRequestNumber(stdout) {
  const match = stdout.trim().match(/\/pull\/(\d+)\/?$/)
  return match ? Number(match[1]) : null
}

/** @param {string} target @param {string} head @param {string} expectedSha @param {string} tipSha */
function pushWithLease(target, head, expectedSha, tipSha) {
  const result = spawnSync('git', [
    'push',
    'origin',
    `--force-with-lease=refs/heads/${head}:${expectedSha}`,
    `${tipSha}:refs/heads/${head}`,
  ], { cwd: target, encoding: 'utf8' })
  const message = `${result.stdout?.trim() || ''}\n${result.stderr?.trim() || ''}`.trim() || `push with lease failed for ${head}.`
  return {
    status: result.status,
    message: sanitizeReconcileOutput(message),
  }
}

/**
 * Classify a push failure to avoid leaking sensitive details and provide useful
 * diagnostics while preserving exact-lease behavior.
 * @param {string} branch
 * @param {string} raw
 */
function classifyPushFailure(branch, raw) {
  const message = sanitizeReconcileOutput(raw)
  if (!message) return { category: 'other', message: `push with lease failed for ${branch}.` }
  const lower = message.toLowerCase()
  if (/permission denied|authentication failed|could not read from remote repository|publickey|not authorized|bad credentials/.test(lower)) {
    return { category: 'authentication', message }
  }
  if (/changes must be made through a pull request|protected branch|protected branch hook declined|required status checks|pre-receive hook|branch policy|repository rule|ruleset|push declined due to repository rule|gh006|gh007|gh008|gh013/.test(lower)) {
    return { category: 'policy', message }
  }
  return { category: 'other', message }
}

/** @param {string} value */
function sanitizeReconcileOutput(value) {
  return value
    .replace(/https?:\/\/[^\s@]+:[^\s@]*@/g, 'https://***:***@')
    .replace(/https?:\/\/[^\s@]+@/g, 'https://***@')
    .trim()
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
        const details = [cherryPick.stdout?.trim(), cherryPick.stderr?.trim()].filter(Boolean).join('\n')
        throw new Error(`Cherry-pick of ${sha} failed while replaying staging commits: ${sanitizeReconcileOutput(details)}`)
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

/** @param {string} root @param {string} from @param {string} to @returns {string[]} */
function treeChangedPaths(root, from, to) {
  const result = spawnSync('git', ['diff', '--name-only', from, to], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`Failed to compare branch trees between ${from} and ${to}. ${result.stderr?.trim() || result.stdout?.trim()}`)
  }
  return result.stdout.split(/\r?\n/).filter(Boolean)
}

/** @param {string} root @param {string[]} args @returns {{ status: number | null, stdout: string, stderr: string }} */
function ghSpawn(root, args) {
  const token = process.env.RELEASE_PLEASE_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  return spawnSync('gh', args, { cwd: resolve(root), encoding: 'utf8', env: { ...process.env, ...(token ? { GH_TOKEN: token } : {}) } })
}

/** @param {string} root @param {string[]} args @returns {unknown} */
function ghJson(root, args) {
  const result = ghSpawn(root, args)
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
