// @ts-check

/**
 * Pure validation for short-lived evidence that a full main-targeted PR run
 * tested the exact source tree now used by a Release Please PR. The workflow
 * adapter supplies the GitHub API records and the current base-tree details.
 */

export const QUALIFICATION_RECEIPT_KIND = 'code-foundry-validation-qualification'
export const QUALIFICATION_RECEIPT_SCHEMA_VERSION = 2
export const QUALIFICATION_RECEIPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const QUALIFICATION_RECEIPT_ARTIFACT_PREFIX = 'code-foundry-qualification-v2'

const SHA_PATTERN = /^[a-f0-9]{40}$/
const WORKFLOW_PATTERN = /^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/
const REQUIRED_COMPONENTS = ['ci', 'test', 'security', 'eval', 'gate']

/** @param {unknown} value @returns {value is Record<string, any>} */
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value */
function positiveInteger(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) > 0
}

/** @param {unknown} value */
function sha(value) {
  return typeof value === 'string' && SHA_PATTERN.test(value)
}

/** @param {unknown} value */
function nonempty(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

/** @param {unknown} value */
function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

/** @param {string} reason */
function notVerified(reason) {
  return { verified: false, reason }
}

/** @param {unknown} input */
export function verifyQualificationJobEvidence(input) {
  if (!object(input) || !Array.isArray(input.jobs) || !Array.isArray(input.requiredJobNames)) {
    return notVerified('missing exact-attempt workflow jobs')
  }
  const { jobs, requiredJobNames, runId, headSha } = input
  if (
    !positiveInteger(runId) ||
    !sha(headSha) ||
    requiredJobNames.length === 0 ||
    requiredJobNames.length > 32 ||
    requiredJobNames.some((name) => !nonempty(name)) ||
    new Set(requiredJobNames).size !== requiredJobNames.length
  ) {
    return notVerified('invalid required workflow job contract')
  }
  for (const name of requiredJobNames) {
    const matches = jobs.filter((job) => job?.name === name)
    if (
      matches.length !== 1 ||
      matches[0].run_id !== runId ||
      matches[0].head_sha !== headSha ||
      matches[0].status !== 'completed' ||
      matches[0].conclusion !== 'success'
    ) {
      return notVerified(`required workflow job ${name} is missing or unsuccessful`)
    }
  }
  return { verified: true, reason: 'required exact-attempt workflow jobs succeeded' }
}

/**
 * Validate the serialized receipt without consulting GitHub or the clock.
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export function isQualificationReceipt(value) {
  if (!object(value)) return false
  const receipt = /** @type {Record<string, any>} */ (value)
  if (
    receipt.schema_version !== QUALIFICATION_RECEIPT_SCHEMA_VERSION ||
    receipt.kind !== QUALIFICATION_RECEIPT_KIND ||
    !nonempty(receipt.repository) ||
    !WORKFLOW_PATTERN.test(receipt.workflow?.path ?? '') ||
    !positiveInteger(receipt.workflow?.id) ||
    !sha(receipt.workflow?.sha) ||
    !sha(receipt.workflow?.blob_sha) ||
    !positiveInteger(receipt.run?.id) ||
    !positiveInteger(receipt.run?.attempt) ||
    !Array.isArray(receipt.run?.required_job_names) ||
    receipt.run.required_job_names.length === 0 ||
    receipt.run.required_job_names.length > 32 ||
    receipt.run.required_job_names.some((/** @type {unknown} */ name) => !nonempty(name)) ||
    new Set(receipt.run.required_job_names).size !== receipt.run.required_job_names.length ||
    receipt.run?.event !== 'pull_request' ||
    !sha(receipt.run?.head_sha) ||
    !timestamp(receipt.run?.created_at) ||
    !positiveInteger(receipt.pull_request?.number) ||
    !nonempty(receipt.pull_request?.base_repository) ||
    receipt.pull_request?.base_ref !== 'main' ||
    !sha(receipt.pull_request?.base_sha) ||
    !nonempty(receipt.pull_request?.head_repository) ||
    !nonempty(receipt.pull_request?.head_ref) ||
    !sha(receipt.pull_request?.head_sha) ||
    receipt.mode !== 'audit' ||
    !sha(receipt.tested?.sha) ||
    !sha(receipt.tested?.tree_sha) ||
    !nonempty(receipt.runtime?.repository) ||
    !sha(receipt.runtime?.sha) ||
    !sha(receipt.runtime?.tree_sha) ||
    !object(receipt.jobs)
  ) {
    return false
  }

  for (const component of REQUIRED_COMPONENTS) {
    if (receipt.jobs[component] !== 'success') return false
  }
  return receipt.jobs.codeql === 'success' || receipt.jobs.codeql === 'not-configured'
}

/**
 * Create a schema-versioned receipt and reject any producer input that would
 * not be safe to upload.
 * @param {Record<string, any>} input
 */
export function createQualificationReceipt(input) {
  const receipt = {
    ...input,
    schema_version: QUALIFICATION_RECEIPT_SCHEMA_VERSION,
    kind: QUALIFICATION_RECEIPT_KIND,
  }
  if (!isQualificationReceipt(receipt)) {
    throw new Error('Refusing to create an incomplete qualification receipt')
  }
  return receipt
}

/**
 * Return whether a candidate receipt proves reusable source qualification.
 * Every mismatch is a normal `verified: false` result so callers can run the
 * full release fallback instead of turning missing evidence into a skip.
 * @param {{receipt:unknown, run:any, pullRequest:any, jobs:any, expectedJobNames:string[], artifact:any, target:any, now?:number}} input
 * @returns {{verified:boolean, reason:string}}
 */
export function verifyQualificationReceipt(input) {
  const {
    receipt,
    run,
    pullRequest,
    jobs,
    expectedJobNames,
    artifact,
    target,
    now = Date.now(),
  } = input

  if (!isQualificationReceipt(receipt)) return notVerified('malformed or incomplete receipt')
  if (
    !object(run) ||
    !object(pullRequest) ||
    !Array.isArray(jobs) ||
    !Array.isArray(expectedJobNames) ||
    !object(artifact) ||
    !object(target)
  ) {
    return notVerified('missing GitHub or target evidence')
  }
  if (!Number.isSafeInteger(now)) return notVerified('invalid verification clock')
  if (
    !nonempty(target.repository) ||
    target.base_ref !== 'main' ||
    !sha(target.base_tree_sha) ||
    !positiveInteger(target.workflow_id) ||
    !WORKFLOW_PATTERN.test(target.workflow_path ?? '') ||
    !sha(target.workflow_blob_sha) ||
    !nonempty(target.runtime_repository) ||
    !sha(target.runtime_tree_sha) ||
    typeof target.codeql_enabled !== 'boolean'
  ) {
    return notVerified('invalid current target identity')
  }

  if (
    receipt.repository !== target.repository ||
    receipt.pull_request.base_repository !== target.repository ||
    receipt.pull_request.base_ref !== target.base_ref ||
    receipt.tested.tree_sha !== target.base_tree_sha
  ) {
    return notVerified('tested source tree or repository does not match current main')
  }

  if (
    receipt.workflow.id !== target.workflow_id ||
    receipt.workflow.path !== target.workflow_path ||
    receipt.workflow.blob_sha !== target.workflow_blob_sha
  ) {
    return notVerified('qualification workflow does not match current configuration')
  }
  if (
    receipt.runtime.repository !== target.runtime_repository ||
    receipt.runtime.tree_sha !== target.runtime_tree_sha
  ) {
    return notVerified('qualification runtime content does not match current runtime')
  }
  if (target.codeql_enabled && receipt.jobs.codeql !== 'success') {
    return notVerified('CodeQL was not successful in the source qualification')
  }
  if (!target.codeql_enabled && receipt.jobs.codeql !== 'not-configured') {
    return notVerified('source CodeQL configuration is ambiguous')
  }

  const artifactName = `${QUALIFICATION_RECEIPT_ARTIFACT_PREFIX}-${receipt.run.id}-${receipt.run.attempt}`
  if (
    artifact.expired !== false ||
    artifact.digest_verified !== true ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') ||
    !positiveInteger(artifact.size_in_bytes) ||
    artifact.name !== artifactName ||
    !timestamp(artifact.created_at) ||
    !timestamp(artifact.expires_at) ||
    Date.parse(artifact.created_at) > now ||
    Date.parse(artifact.expires_at) <= now ||
    artifact.workflow_run?.id !== receipt.run.id ||
    artifact.workflow_run?.head_sha !== receipt.run.head_sha
  ) {
    return notVerified('receipt artifact is missing, expired, or belongs to another run')
  }

  if (
    run.id !== receipt.run.id ||
    run.run_attempt !== receipt.run.attempt ||
    run.event !== receipt.run.event ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.head_sha !== receipt.run.head_sha ||
    run.workflow_id !== receipt.workflow.id ||
    run.path !== receipt.workflow.path ||
    run.repository?.full_name !== target.repository ||
    run.head_repository?.full_name !== receipt.pull_request.head_repository ||
    run.head_branch !== receipt.pull_request.head_ref ||
    !timestamp(run.created_at) ||
    Date.parse(run.created_at) !== Date.parse(receipt.run.created_at)
  ) {
    return notVerified('workflow run identity, latest attempt, or conclusion does not match')
  }

  if (
    !Array.isArray(run.pull_requests) ||
    run.pull_requests.length !== 1 ||
    run.pull_requests[0]?.number !== receipt.pull_request.number
  ) {
    return notVerified('workflow run is associated with a different or ambiguous pull request')
  }

  if (
    pullRequest.number !== receipt.pull_request.number ||
    pullRequest.state !== 'closed' ||
    pullRequest.merged !== true ||
    !timestamp(pullRequest.merged_at) ||
    pullRequest.base?.repo?.full_name !== receipt.pull_request.base_repository ||
    pullRequest.base?.ref !== receipt.pull_request.base_ref ||
    pullRequest.head?.repo?.full_name !== receipt.pull_request.head_repository ||
    pullRequest.head?.ref !== receipt.pull_request.head_ref ||
    pullRequest.head?.sha !== receipt.pull_request.head_sha ||
    receipt.run.head_sha !== receipt.pull_request.head_sha
  ) {
    return notVerified('pull request does not match the successful source run')
  }

  const expectedNames = [...expectedJobNames].toSorted()
  const recordedNames = [...receipt.run.required_job_names].toSorted()
  if (
    expectedNames.length === 0 ||
    expectedNames.some((name) => !nonempty(name)) ||
    new Set(expectedNames).size !== expectedNames.length ||
    expectedNames.join('\n') !== recordedNames.join('\n')
  ) {
    return notVerified('receipt required-job contract does not match current workflow')
  }
  const jobEvidence = verifyQualificationJobEvidence({
    jobs,
    requiredJobNames: expectedNames,
    runId: run.id,
    headSha: run.head_sha,
  })
  if (!jobEvidence.verified) return jobEvidence

  const createdAt = Date.parse(run.created_at)
  const completedAt = Date.parse(run.updated_at ?? run.created_at)
  if (
    !Number.isFinite(completedAt) ||
    completedAt < createdAt ||
    completedAt > now + 5 * 60 * 1000 ||
    now - completedAt > QUALIFICATION_RECEIPT_MAX_AGE_MS
  ) {
    return notVerified('source qualification is older than seven days or has invalid timestamps')
  }

  return { verified: true, reason: 'exact recent source qualification verified' }
}
