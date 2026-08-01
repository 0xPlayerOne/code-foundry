// @ts-check

/**
 * Tiered validation policy shared by the generated validation caller, the
 * reusable validation orchestrator, and their deterministic tests.
 *
 * The caller classifies every triggering event into exactly one of three
 * fail-closed modes; the orchestrator's aggregate gate evaluates normalized
 * job results against a mode-aware truth table. The shell steps embedded in
 * the generated workflows are thin mirrors of these functions; keep the
 * workflow YAML and this module in lockstep.
 */

/** The three validation tiers. */
export const VALIDATION_MODES = ['fast', 'audit', 'release']

/** Exact branch prefix used by Release Please for generated version pull requests. */
export const RELEASE_PLEASE_PREFIX = 'release-please--branches--main'

/** Stable aggregate check name emitted by the validation orchestrator's gate job. */
export const AGGREGATE_CHECK_NAME = 'Validation / Gate'
/** Job ids owned by the validation orchestrator. */
export const VALIDATION_JOBS = ['ci', 'test', 'security', 'codeql', 'release-policy']

/** Events that may trigger canonical validation. */
export const VALIDATION_EVENTS = ['pull_request', 'schedule', 'workflow_dispatch']

/**
 * True when the head branch is a generated Release Please version branch:
 * either the exact prefix or the prefix followed by the `--` separator.
 * Any other string (including prefix lookalikes without the exact boundary)
 * is not approved.
 * @param {unknown} headRef
 * @returns {boolean}
 */
export function isReleasePleaseHead(headRef) {
  if (typeof headRef !== 'string' || headRef.length === 0) return false
  return headRef === RELEASE_PLEASE_PREFIX || headRef.startsWith(`${RELEASE_PLEASE_PREFIX}--`)
}

/**
 * Classify an event into exactly one validation mode, failing closed:
 * - fast: pull_request targeting staging
 * - release: pull_request targeting main whose head is the exact approved
 *   Release Please prefix
 * - audit: every other pull_request targeting main, plus schedule and
 *   workflow_dispatch
 * Unsupported events (for example push) and unsupported base branches are
 * rejected so canonical validation can never silently run or silently skip.
 * @param {{ eventName: string, baseRef?: string, headRef?: string }} input
 * @returns {'fast'|'audit'|'release'}
 */
export function classifyValidationMode(input) {
  const { eventName, baseRef, headRef } = input
  if (typeof eventName !== 'string' || !VALIDATION_EVENTS.includes(eventName)) {
    throw new Error(
      `Unsupported validation event: ${eventName ?? '(missing)'}; canonical validation must not run on this event.`
    )
  }
  if (eventName === 'schedule' || eventName === 'workflow_dispatch') return 'audit'
  if (typeof baseRef !== 'string' || baseRef.length === 0) {
    throw new Error('pull_request classification requires base_ref.')
  }
  if (typeof headRef !== 'string' || headRef.length === 0) {
    throw new Error('pull_request classification requires head_ref.')
  }
  if (baseRef === 'staging') return 'fast'
  if (baseRef === 'main') return isReleasePleaseHead(headRef) ? 'release' : 'audit'
  throw new Error(`Unsupported pull_request base branch: ${baseRef}; expected staging or main.`)
}

/** @type {Record<'fast'|'audit'|'release', string[]>} */
const REQUIRED_JOBS_BY_MODE = {
  fast: ['ci', 'test'],
  audit: ['ci', 'test', 'security', 'codeql'],
  release: ['release-policy'],
}

/**
 * Job ids that the aggregate gate requires for a mode. Expected skips never
 * appear here: anything outside the returned list is not part of the gate.
 * @param {string} mode
 * @returns {string[]}
 */
export function requiredValidationJobs(mode) {
  const jobs = REQUIRED_JOBS_BY_MODE[/** @type {'fast'|'audit'|'release'} */ (mode)]
  if (!jobs) {
    throw new Error(
      `Unknown validation mode: ${mode ?? '(missing)'}; expected one of ${VALIDATION_MODES.join(', ')}.`
    )
  }
  return [...jobs]
}

/**
 * Evaluate the aggregate gate for one mode against normalized job results.
 * Only jobs required for the mode are consulted, so expected skips of
 * non-required jobs never fail the gate. Every required job must report
 * exactly `success`; failure, cancellation, an unexpected skip, a missing
 * result, or an unknown result fails the gate (fail closed).
 * @param {{ mode: string, results?: Record<string, string | null | undefined> }} input
 * @returns {{ valid: boolean, required: string[], failures: Array<{ job: string, result: string }> }}
 */
export function evaluateValidationGate(input) {
  const { mode, results = {} } = input
  let required
  try {
    required = requiredValidationJobs(mode)
  } catch (error) {
    return {
      valid: false,
      required: [],
      failures: [{ job: 'mode', result: error instanceof Error ? error.message : String(error) }],
    }
  }
  /** @type {Array<{ job: string, result: string }>} */
  const failures = []
  for (const job of required) {
    const result = results[job]
    if (result === 'success') continue
    failures.push({
      job,
      result: result === undefined || result === null ? 'missing' : String(result),
    })
  }
  return { valid: failures.length === 0, required, failures }
}
