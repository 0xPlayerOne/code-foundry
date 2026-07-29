// @ts-check

import { createHash } from 'node:crypto'

/** @typedef {'disabled'|'workflow-dispatch'|'release-event'|'unavailable'} HookDelivery */

/**
 * Select exactly one post-release delivery mechanism.
 * @param {{ mode?: string, tokenPresent: boolean, releaseEventEnabled?: boolean }} input
 * @returns {{ delivery: HookDelivery, reason: string }}
 */
export function selectHookDelivery(input) {
  const mode = input.mode ?? 'auto'
  if (mode === 'false' || mode === 'disabled') return { delivery: 'disabled', reason: 'Post-release hooks are disabled by configuration.' }
  if (mode === 'workflow-dispatch' || (mode === 'auto' && input.tokenPresent)) {
    return input.tokenPresent
      ? { delivery: 'workflow-dispatch', reason: 'A PAT is available; use one explicit workflow dispatch.' }
      : { delivery: 'unavailable', reason: 'workflow-dispatch requires a PAT.' }
  }
  if (mode === 'release-event' || (mode === 'auto' && input.releaseEventEnabled !== false)) {
    return { delivery: 'release-event', reason: 'Use the published-release event; do not issue a fallback dispatch.' }
  }
  return { delivery: 'unavailable', reason: 'No supported post-release delivery mechanism is configured.' }
}

/** @param {string} repository @param {string} tag @returns {string} */
export function releaseDeliveryKey(repository, tag) {
  return createHash('sha256').update(`${repository}\0${tag}`).digest('hex').slice(0, 24)
}

/**
 * A workflow dispatch is considered already delivered when a run exists for
 * the release tag. Completed failures remain recorded so retries are explicit
 * rather than accidentally duplicated by a second event path.
 * @param {Array<{headBranch?: string, displayTitle?: string, status?: string}>} runs
 * @param {string} tag
 */
export function hasDeliveredHook(runs, tag) {
  return runs.some((run) => run.headBranch === tag || run.displayTitle?.includes(`release-tag=${tag}`))
}
