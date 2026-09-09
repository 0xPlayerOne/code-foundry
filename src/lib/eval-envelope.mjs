// @ts-check

/**
 * The shared eval-report contract. Every `ci eval` run validates the consumer
 * repository's eval report against this envelope before applying budgets.
 * Deterministic probes (Layer 1) and model-agent runs (Layer 2) emit the same
 * envelope, so task outcomes stay comparable across executors and revisions.
 * See docs/EVALS.md for the full field reference.
 */

export const EVAL_REPORT_FILE = 'eval-results/result.json'
export const EVAL_SUMMARY_FILE = 'eval-results/summary.json'
export const EVAL_BUDGET_FILE_DEFAULT = 'eval-budgets.json'
export const EVAL_REPORT_SCHEMA_VERSION = 1
export const EVAL_SUMMARY_KIND = 'code-foundry-eval-summary'

const FAILURE_CLASSES = ['harness', 'task']
const STAT_FIELDS = ['mean', 'p50', 'p95', 'max']

/** @param {unknown} value @returns {value is number} */
function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** @param {unknown} value @returns {value is number} */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/** @param {unknown} value @returns {boolean} */
function isStats(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = /** @type {Record<string, unknown>} */ (value)
  if (!isNonNegativeInteger(record.count)) return false
  if (record.count === 0) {
    return (
      Object.keys(record).length === 1 || STAT_FIELDS.every((field) => record[field] === undefined)
    )
  }
  return STAT_FIELDS.every((field) => isFiniteNumber(record[field]))
}

/**
 * Validate one eval report envelope. Returns every violation instead of
 * throwing, so one broken report lists all of its problems at once.
 * @param {unknown} report @returns {{valid: boolean, errors: string[]}}
 */
export function validateEvalReport(report) {
  /** @type {string[]} */
  const errors = []
  /** @param {string} message */
  const push = (message) => errors.push(message)
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { valid: false, errors: ['report must be a JSON object'] }
  }
  const value = /** @type {Record<string, unknown>} */ (report)
  if (value.schemaVersion !== EVAL_REPORT_SCHEMA_VERSION)
    push(`schemaVersion: expected ${EVAL_REPORT_SCHEMA_VERSION}`)
  if (value.revision !== undefined && typeof value.revision !== 'string')
    push('revision: must be a string when present')
  if (value.dependencyHash !== undefined && typeof value.dependencyHash !== 'string')
    push('dependencyHash: must be a string when present')

  const summary = value.summary
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    push('summary: must be an object')
    return { valid: errors.length === 0, errors }
  }
  const counts = /** @type {Record<string, unknown>} */ (summary)
  for (const field of [
    'taskCount',
    'attempts',
    'passed',
    'failed',
    'harnessFailures',
    'toolCalls',
    'evidenceErrors',
  ]) {
    if (!isNonNegativeInteger(counts[field]))
      push(`summary.${field}: must be a non-negative integer`)
  }
  if (
    isNonNegativeInteger(counts.passed) &&
    isNonNegativeInteger(counts.failed) &&
    isNonNegativeInteger(counts.attempts) &&
    counts.passed + counts.failed > counts.attempts
  )
    push('summary.passed/failed: must not exceed attempts')
  if (
    isNonNegativeInteger(counts.harnessFailures) &&
    isNonNegativeInteger(counts.attempts) &&
    counts.harnessFailures > counts.attempts
  )
    push('summary.harnessFailures: must not exceed attempts')
  if (isFiniteNumber(counts.successRate) && (counts.successRate < 0 || counts.successRate > 1))
    push('summary.successRate: must be between 0 and 1')
  for (const field of ['taskDurationMs', 'startupMs', 'stepDurationMs']) {
    if (!isStats(counts[field])) push(`summary.${field}: must be a stats object`)
  }

  const tasks = value.tasks
  if (!Array.isArray(tasks)) {
    push('tasks: must be an array')
    return { valid: errors.length === 0, errors }
  }
  for (const [index, task] of tasks.entries()) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      push(`tasks[${index}]: must be an object`)
      continue
    }
    const record = /** @type {Record<string, unknown>} */ (task)
    if (typeof record.id !== 'string' || record.id.trim().length === 0)
      push(`tasks[${index}].id: must be a non-empty string`)
    if (!Array.isArray(record.attempts)) {
      push(`tasks[${index}].attempts: must be an array`)
      continue
    }
    for (const [attemptIndex, attempt] of record.attempts.entries()) {
      const path = `tasks[${index}].attempts[${attemptIndex}]`
      if (!attempt || typeof attempt !== 'object') {
        push(`${path}: must be an object`)
        continue
      }
      const entry = /** @type {Record<string, unknown>} */ (attempt)
      if (entry.status !== 'passed' && entry.status !== 'failed')
        push(`${path}.status: must be passed or failed`)
      if (entry.durationMs !== undefined && !isFiniteNumber(entry.durationMs))
        push(`${path}.durationMs: must be a finite number`)
      if (entry.startupMs !== undefined && !isFiniteNumber(entry.startupMs))
        push(`${path}.startupMs: must be a finite number`)
      if (entry.failure) {
        const failure = entry.failure
        if (!failure || typeof failure !== 'object') push(`${path}.failure: must be an object`)
        else if (
          typeof (/** @type {Record<string, unknown>} */ (failure).message) !== 'string' ||
          /** @type {Record<string, unknown>} */ (failure).message === ''
        )
          push(`${path}.failure.message: must be a non-empty string`)
        if (!FAILURE_CLASSES.includes(/** @type {string} */ (entry.failureClass)))
          push(`${path}.failureClass: must be harness or task when a failure is present`)
      } else if (entry.failureClass !== undefined) {
        if (!FAILURE_CLASSES.includes(/** @type {string} */ (entry.failureClass)))
          push(`${path}.failureClass: must be harness or task when present`)
      }
      if (Array.isArray(entry.steps)) {
        for (const [stepIndex, stepEntry] of entry.steps.entries()) {
          const stepPath = `${path}.steps[${stepIndex}]`
          if (!stepEntry || typeof stepEntry !== 'object') {
            push(`${stepPath}: must be an object`)
            continue
          }
          const step = /** @type {Record<string, unknown>} */ (stepEntry)
          if (typeof step.tool !== 'string' || step.tool.trim().length === 0)
            push(`${stepPath}.tool: must be a non-empty string`)
          if (!['running', 'passed', 'failed'].includes(/** @type {string} */ (step.status)))
            push(`${stepPath}.status: must be running, passed, or failed`)
          if (step.durationMs !== undefined && !isFiniteNumber(step.durationMs))
            push(`${stepPath}.durationMs: must be a finite number`)
        }
      }
    }
  }
  return { valid: errors.length === 0, errors }
}

/**
 * Evaluate the configured budget thresholds against one validated report.
 * Unknown budget keys fail closed so a typo can never silently disable a gate.
 * @param {{summary?: Record<string, unknown>}} report
 * @param {Record<string, unknown>} budgets
 * @returns {{passed: boolean, failures: string[]}}
 */
export function evaluateEvalBudgets(report, budgets) {
  if (!report || typeof report !== 'object' || Array.isArray(report))
    return { passed: false, failures: ['report must be a validated eval report object'] }
  const failures = []
  if (!budgets || typeof budgets !== 'object' || Array.isArray(budgets)) {
    return { passed: false, failures: ['budgets must be a JSON object'] }
  }
  const known = new Set([
    'successRate',
    'taskP95Ms',
    'startupP95Ms',
    'stepP95Ms',
    'maxHarnessFailures',
    'maxEvidenceErrors',
    'maxToolCalls',
  ])
  for (const key of Object.keys(budgets)) {
    if (!known.has(key)) failures.push(`budgets.${key}: unknown budget key`)
  }
  if (failures.length > 0) return { passed: false, failures }
  /** @type {Record<string, unknown>} */
  const summary = report.summary ?? {}
  const rate = budgets.successRate
  if (rate !== undefined) {
    if (!isFiniteNumber(rate) || rate < 0 || rate > 1)
      return { passed: false, failures: ['budgets.successRate: must be between 0 and 1'] }
    if (isFiniteNumber(summary.successRate) && summary.successRate < rate)
      failures.push(`successRate ${summary.successRate.toFixed(2)} is below budget ${rate}`)
  }
  const p95Fields = /** @type {const} */ ([
    ['taskP95Ms', 'taskDurationMs'],
    ['startupP95Ms', 'startupMs'],
    ['stepP95Ms', 'stepDurationMs'],
  ])
  for (const [budgetField, summaryField] of p95Fields) {
    const budget = /** @type {unknown} */ (budgets[budgetField])
    if (budget === undefined) continue
    if (!isFiniteNumber(budget) || budget <= 0)
      return { passed: false, failures: [`budgets.${budgetField}: must be a positive number`] }
    const stats = summary[summaryField]
    if (!stats || typeof stats !== 'object') continue
    const p95 = /** @type {unknown} */ (/** @type {Record<string, unknown>} */ (stats).p95)
    const count = /** @type {Record<string, unknown>} */ (stats).count
    if (!isFiniteNumber(p95) || count === 0) continue
    if (p95 > budget) failures.push(`${summaryField}.p95 ${p95}ms is above budget ${budget}ms`)
  }
  const maxFields = /** @type {const} */ ([
    ['maxHarnessFailures', 'harnessFailures'],
    ['maxEvidenceErrors', 'evidenceErrors'],
    ['maxToolCalls', 'toolCalls'],
  ])
  for (const [budgetField, summaryField] of maxFields) {
    const budget = /** @type {unknown} */ (budgets[budgetField])
    if (budget === undefined) continue
    if (!isNonNegativeInteger(budget))
      return { passed: false, failures: [`budgets.${budgetField}: must be a non-negative integer`] }
    const measured = /** @type {unknown} */ (summary[summaryField])
    if (isNonNegativeInteger(measured) && measured > budget)
      failures.push(`${summaryField} ${measured} is above budget ${budget}`)
  }
  return { passed: failures.length === 0, failures }
}
