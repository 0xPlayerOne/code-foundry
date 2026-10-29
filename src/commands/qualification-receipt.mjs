// @ts-check

import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  createQualificationReceipt,
  QUALIFICATION_RECEIPT_ARTIFACT_PREFIX,
  QUALIFICATION_RECEIPT_MAX_AGE_MS,
  verifyQualificationReceipt,
} from '../lib/qualification-receipt.mjs'

const MAX_RUNS_TO_INSPECT = 30
const MAX_RECEIPT_BYTES = 1024 * 1024

/** @param {string} value */
function parsePositiveInteger(value) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('Invalid positive integer')
  return parsed
}

/** @param {string} value */
function parseSha(value) {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('Invalid Git SHA')
  return value
}

/** @param {string} workflowRef @param {string} repository */
function workflowPathFromRef(workflowRef, repository) {
  const prefix = `${repository}/.github/workflows/`
  const offset = workflowRef.indexOf(prefix)
  if (offset < 0) throw new Error('Workflow ref is not a repository workflow path')
  const path = `.github/workflows/${workflowRef.slice(offset + prefix.length).split('@', 1)[0]}`
  if (!/^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(path)) {
    throw new Error('Unsupported caller workflow path')
  }
  return path
}

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  }).trim()
}

/** @param {string} text @param {string} label */
function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

/** @param {Record<string, string | undefined>} env @param {string} key */
function requiredEnv(env, key) {
  const value = env[key]
  if (!value) throw new Error(`Missing ${key}`)
  return value
}

/** @param {string} outputFile @param {string} key @param {string} value */
function writeOutput(outputFile, key, value) {
  appendFileSync(outputFile, `${key}=${value.replace(/[\r\n]/g, ' ').slice(0, 240)}\n`)
}

/** @param {string} envName @param {string} repository */
function apiBase(envName, repository) {
  const configured = envName || 'https://api.github.com'
  const base = new URL(configured)
  if (base.protocol !== 'https:') throw new Error('GitHub API URL must use HTTPS')
  base.pathname = `${base.pathname.replace(/\/$/, '')}/repos/${repository}`
  return base
}

/**
 * Fetch authenticated GitHub JSON. The token is never included in errors.
 * @param {string} url
 * @param {string} token
 * @param {typeof fetch} fetchImpl
 */
async function getJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`)
  return response.json()
}

/** @param {any} event @param {Record<string, string | undefined>} env */
function pullRequestFromEvent(event, env) {
  const pr = event?.pull_request
  const baseRepository = pr?.base?.repo?.full_name
  const headRepository = pr?.head?.repo?.full_name
  const repository = requiredEnv(env, 'GITHUB_REPOSITORY')
  if (
    env.GITHUB_EVENT_NAME !== 'pull_request' ||
    pr?.base?.ref !== 'main' ||
    baseRepository !== repository ||
    !headRepository ||
    !Number.isSafeInteger(pr?.number) ||
    !pr?.head?.ref ||
    !/^[a-f0-9]{40}$/.test(pr?.base?.sha ?? '') ||
    !/^[a-f0-9]{40}$/.test(pr?.head?.sha ?? '')
  ) {
    throw new Error('Event is not a valid main-targeted pull request')
  }
  return {
    number: pr.number,
    base_repository: baseRepository,
    base_ref: pr.base.ref,
    base_sha: pr.base.sha,
    head_repository: headRepository,
    head_ref: pr.head.ref,
    head_sha: pr.head.sha,
  }
}

/**
 * Produce one receipt after the source-validation gate has passed. Any
 * unavailable or inconsistent metadata is an omitted receipt, not a failed
 * source-validation run.
 * @param {Record<string, string | undefined>} env
 * @param {{fetchImpl?:typeof fetch, cwd?:string}} [options]
 */
export async function produceQualificationReceipt(env = process.env, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const cwd = options.cwd ?? process.cwd()
  const event = parseJson(
    readFileSync(requiredEnv(env, 'GITHUB_EVENT_PATH'), 'utf8'),
    'GitHub event'
  )
  const pullRequest = pullRequestFromEvent(event, env)
  if (env.FOUNDRY_MODE !== 'audit') throw new Error('Only a full audit run can produce a receipt')

  const jobs = parseJson(requiredEnv(env, 'FOUNDRY_JOB_RESULTS_JSON'), 'job results')
  const token = requiredEnv(env, 'GITHUB_TOKEN')
  const repository = requiredEnv(env, 'GITHUB_REPOSITORY')
  const runtimeRepository = requiredEnv(env, 'RUNTIME_REPOSITORY')
  const runtimePath = requiredEnv(env, 'RUNTIME_PATH')
  const workflowPath = workflowPathFromRef(requiredEnv(env, 'GITHUB_WORKFLOW_REF'), repository)
  const workflowSha = parseSha(requiredEnv(env, 'GITHUB_WORKFLOW_SHA'))
  const eventSha = parseSha(requiredEnv(env, 'GITHUB_SHA'))
  const checkedOutSha = git(cwd, ['rev-parse', 'HEAD'])
  if (checkedOutSha !== eventSha) throw new Error('Producer checkout does not match the event SHA')
  const parents = git(cwd, ['rev-list', '--parents', '-n', '1', eventSha]).split(/\s+/).slice(1)
  if (
    parents.length !== 2 ||
    parents[0] !== pullRequest.base_sha ||
    parents[1] !== pullRequest.head_sha
  ) {
    throw new Error('Tested merge commit does not match the source event')
  }

  const executedWorkflowBlob = git(cwd, ['rev-parse', `${workflowSha}:${workflowPath}`])
  const testedWorkflowBlob = git(cwd, ['rev-parse', `${eventSha}:${workflowPath}`])
  if (executedWorkflowBlob !== testedWorkflowBlob) {
    throw new Error('Caller workflow changed in the tested source tree')
  }
  const runtimeSha = parseSha(git(runtimePath, ['rev-parse', 'HEAD']))
  const api = apiBase(env.GITHUB_API_URL ?? 'https://api.github.com', repository)
  const workflow = await getJson(
    endpoint(api.href, `actions/workflows/${encodeURIComponent(basename(workflowPath))}`),
    token,
    fetchImpl
  )
  if (
    !Number.isSafeInteger(workflow?.id) ||
    workflow.path !== workflowPath ||
    workflow.state !== 'active'
  ) {
    throw new Error('Caller workflow identity is unavailable or inactive')
  }

  const runId = parsePositiveInteger(requiredEnv(env, 'GITHUB_RUN_ID'))
  const runAttempt = parsePositiveInteger(requiredEnv(env, 'GITHUB_RUN_ATTEMPT'))
  const run = await getJson(endpoint(api.href, `actions/runs/${runId}`), token, fetchImpl)
  if (
    run?.id !== runId ||
    run?.run_attempt !== runAttempt ||
    run?.workflow_id !== workflow.id ||
    run?.path !== workflowPath ||
    run?.event !== 'pull_request' ||
    run?.head_sha !== pullRequest.head_sha ||
    run?.repository?.full_name !== repository ||
    run?.head_branch !== pullRequest.head_ref ||
    !Array.isArray(run?.pull_requests) ||
    run.pull_requests.length !== 1 ||
    run.pull_requests[0]?.number !== pullRequest.number ||
    !run?.created_at
  ) {
    throw new Error('Current run metadata does not match the source event')
  }

  const receipt = createQualificationReceipt({
    repository,
    workflow: {
      id: workflow.id,
      path: workflowPath,
      sha: workflowSha,
      blob_sha: executedWorkflowBlob,
    },
    run: {
      id: runId,
      attempt: runAttempt,
      event: 'pull_request',
      head_sha: pullRequest.head_sha,
      created_at: run.created_at,
    },
    pull_request: pullRequest,
    mode: 'audit',
    tested: { sha: eventSha, tree_sha: git(cwd, ['rev-parse', `${eventSha}^{tree}`]) },
    runtime: { repository: runtimeRepository, sha: runtimeSha },
    jobs,
  })

  return receipt
}

/** @param {string} base @param {string} path */
function endpoint(base, path) {
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}

/** @param {any} value @returns {Record<string, any>[]} */
function workflowRuns(value) {
  if (!Array.isArray(value?.workflow_runs) || !Number.isSafeInteger(value.total_count)) {
    throw new Error('Malformed workflow-run response')
  }
  return value.workflow_runs
}

/** @param {any} value @returns {Record<string, any>[]} */
function runArtifacts(value) {
  if (!Array.isArray(value?.artifacts) || !Number.isSafeInteger(value.total_count)) {
    throw new Error('Malformed artifact response')
  }
  return value.artifacts
}

/** @param {any} value @param {string} label */
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`)
  }
  return value
}

/**
 * Download a single JSON file without extracting an untrusted archive tree.
 * The bearer token is sent only to the configured GitHub API origin, never to
 * the short-lived artifact redirect host.
 * @param {any} artifact
 * @param {string} apiOrigin
 * @param {string} token
 * @param {typeof fetch} fetchImpl
 */
async function readArtifactReceipt(artifact, apiOrigin, token, fetchImpl) {
  const archiveUrl = new URL(artifact.archive_download_url)
  if (archiveUrl.origin !== apiOrigin || archiveUrl.protocol !== 'https:') {
    throw new Error('Artifact URL does not match the configured GitHub API')
  }
  const response = await fetchImpl(archiveUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  })
  let bytes
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location')
    if (!location || !location.startsWith('https://')) throw new Error('Invalid artifact redirect')
    const archive = await fetchImpl(location, {
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    })
    if (!archive.ok) throw new Error(`Artifact download returned HTTP ${archive.status}`)
    bytes = Buffer.from(await archive.arrayBuffer())
  } else if (response.ok) {
    bytes = Buffer.from(await response.arrayBuffer())
  } else {
    throw new Error(`Artifact API returned HTTP ${response.status}`)
  }
  if (bytes.length === 0 || bytes.length > MAX_RECEIPT_BYTES) {
    throw new Error('Receipt archive has an invalid size')
  }

  const directory = mkdtempSync(join(tmpdir(), 'code-foundry-receipt-'))
  const archivePath = join(directory, 'receipt.zip')
  try {
    writeFileSync(archivePath, bytes, { mode: 0o600, flag: 'wx' })
    const result = spawnSync('unzip', ['-p', archivePath, 'qualification-receipt.json'], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: MAX_RECEIPT_BYTES,
    })
    if (result.error || result.status !== 0) throw new Error('Receipt archive has no valid payload')
    return parseJson(result.stdout, 'qualification receipt')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * Find and verify a recent source receipt. Candidate discovery and all API
 * failures are fail-closed to the normal CI/Test path.
 * @param {Record<string, string | undefined>} env
 * @param {{fetchImpl?:typeof fetch, cwd?:string, now?:number, readArtifact?:typeof readArtifactReceipt}} [options]
 */
export async function findQualificationReceipt(env = process.env, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const cwd = options.cwd ?? process.cwd()
  const now = options.now ?? Date.now()
  const readArtifact = options.readArtifact ?? readArtifactReceipt
  if (env.FOUNDRY_MODE !== 'release') return { verified: false, reason: 'not a release run' }

  const event = parseJson(
    readFileSync(requiredEnv(env, 'GITHUB_EVENT_PATH'), 'utf8'),
    'GitHub event'
  )
  const pullRequest = pullRequestFromEvent(event, env)
  const repository = requiredEnv(env, 'GITHUB_REPOSITORY')
  const token = requiredEnv(env, 'GITHUB_TOKEN')
  const apiUrl = new URL(env.GITHUB_API_URL || 'https://api.github.com')
  if (apiUrl.protocol !== 'https:') throw new Error('GitHub API URL must use HTTPS')
  const workflowPath = workflowPathFromRef(requiredEnv(env, 'GITHUB_WORKFLOW_REF'), repository)
  const workflowSha = parseSha(requiredEnv(env, 'GITHUB_WORKFLOW_SHA'))
  const baseTreeSha = git(cwd, ['rev-parse', `${pullRequest.base_sha}^{tree}`])
  const workflowBlobSha = git(cwd, ['rev-parse', `${pullRequest.base_sha}:${workflowPath}`])
  const executedWorkflowBlob = git(cwd, ['rev-parse', `${workflowSha}:${workflowPath}`])
  if (executedWorkflowBlob !== workflowBlobSha) {
    throw new Error('Current caller workflow differs from the release base')
  }
  const runtimePath = requiredEnv(env, 'RUNTIME_PATH')
  const runtimeSha = parseSha(git(runtimePath, ['rev-parse', 'HEAD']))
  const runtimeRepository = requiredEnv(env, 'RUNTIME_REPOSITORY')
  const codeqlEnabled = requiredEnv(env, 'FOUNDRY_CODEQL_ENABLED') === 'true'
  const api = apiBase(apiUrl.href, repository).href
  const workflow = record(
    await getJson(
      endpoint(api, `actions/workflows/${encodeURIComponent(basename(workflowPath))}`),
      token,
      fetchImpl
    ),
    'Workflow'
  )
  if (
    !Number.isSafeInteger(workflow.id) ||
    workflow.path !== workflowPath ||
    workflow.state !== 'active'
  ) {
    return { verified: false, reason: 'caller workflow identity is unavailable or inactive' }
  }

  const since = new Date(now - QUALIFICATION_RECEIPT_MAX_AGE_MS).toISOString()
  const runsUrl = new URL(endpoint(api, `actions/workflows/${workflow.id}/runs`))
  runsUrl.searchParams.set('event', 'pull_request')
  runsUrl.searchParams.set('created', `>=${since}`)
  runsUrl.searchParams.set('per_page', '100')
  const listedRuns = await getJson(runsUrl.href, token, fetchImpl)
  const runs = workflowRuns(listedRuns)
    .filter(
      (/** @type {Record<string, any>} */ run) =>
        run.workflow_id === workflow.id &&
        run.path === workflowPath &&
        run.event === 'pull_request' &&
        run.status === 'completed' &&
        run.conclusion === 'success' &&
        run.repository?.full_name === repository &&
        Number.isSafeInteger(run.id) &&
        Number.isSafeInteger(run.run_attempt) &&
        run.run_attempt > 0 &&
        Date.parse(run.updated_at ?? '') >= now - QUALIFICATION_RECEIPT_MAX_AGE_MS
    )
    .toSorted(
      (/** @type {Record<string, any>} */ a, /** @type {Record<string, any>} */ b) =>
        Date.parse(b.updated_at) - Date.parse(a.updated_at)
    )
    .slice(0, MAX_RUNS_TO_INSPECT)

  const target = {
    repository,
    base_ref: 'main',
    base_tree_sha: baseTreeSha,
    workflow_id: workflow.id,
    workflow_path: workflowPath,
    workflow_blob_sha: workflowBlobSha,
    runtime_repository: runtimeRepository,
    runtime_sha: runtimeSha,
    codeql_enabled: codeqlEnabled,
  }

  for (const listedRun of runs) {
    const artifactsResponse = await getJson(
      endpoint(api, `actions/runs/${listedRun.id}/artifacts?per_page=100`),
      token,
      fetchImpl
    )
    const artifacts = runArtifacts(artifactsResponse)
    const expectedName = `${QUALIFICATION_RECEIPT_ARTIFACT_PREFIX}-${listedRun.id}-${listedRun.run_attempt}`
    const artifact = artifacts.find(
      (/** @type {Record<string, any>} */ item) =>
        item.name === expectedName && item.expired === false && item.size_in_bytes > 0
    )
    if (!artifact) continue

    const receipt = await readArtifact(artifact, apiUrl.origin, token, fetchImpl)
    const currentRun = record(
      await getJson(endpoint(api, `actions/runs/${listedRun.id}`), token, fetchImpl),
      'Workflow run'
    )
    // The API scopes this artifact listing to the exact run. Some API versions
    // omit workflow_run on the artifact record, so normalize that proven link.
    const normalizedArtifact = {
      ...artifact,
      workflow_run: artifact.workflow_run ?? {
        id: listedRun.id,
        head_sha: listedRun.head_sha,
      },
    }
    const result = verifyQualificationReceipt({
      receipt,
      run: currentRun,
      artifact: normalizedArtifact,
      target,
      now,
    })
    if (result.verified) return result
  }

  const truncated = listedRuns.total_count > listedRuns.workflow_runs.length
  return {
    verified: false,
    reason: truncated
      ? 'no receipt found in the bounded recent-run search; using full validation'
      : 'no matching seven-day source receipt; using full validation',
  }
}

/** @param {Record<string, string | undefined>} env @param {boolean} success @param {string} reason */
function report(env, success, reason) {
  const outputFile = requiredEnv(env, 'GITHUB_OUTPUT')
  writeOutput(outputFile, 'reuse', String(success))
  writeOutput(outputFile, 'reason', reason)
  console.log(`Source qualification reuse: ${success ? 'verified' : 'not available'} (${reason})`)
}

/** @param {Record<string, string | undefined>} env @param {typeof fetch} fetchImpl */
async function produceCommand(env, fetchImpl) {
  try {
    const receipt = await produceQualificationReceipt(env, { fetchImpl })
    writeFileSync('qualification-receipt.json', `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    report(env, true, 'full audit components succeeded')
  } catch (error) {
    report(env, false, error instanceof Error ? error.message : 'receipt metadata unavailable')
  }
}

/** @param {Record<string, string | undefined>} env @param {typeof fetch} fetchImpl */
async function verifyCommand(env, fetchImpl) {
  try {
    const result = await findQualificationReceipt(env, { fetchImpl })
    report(env, result.verified, result.reason)
  } catch (error) {
    report(env, false, error instanceof Error ? error.message : 'receipt lookup failed')
  }
}

const [command] = process.argv.slice(2)
if (command === 'produce') await produceCommand(process.env, fetch)
else if (command === 'verify') await verifyCommand(process.env, fetch)
else if (command !== undefined) {
  console.error('Expected `produce` or `verify`.')
  process.exitCode = 2
}
