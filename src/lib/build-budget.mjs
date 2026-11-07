// @ts-check

import { readFileSync } from 'node:fs'
import { evidencePath } from './task-policy.mjs'

/** The only budgets.json schema this runtime understands. */
export const BUILD_BUDGET_SCHEMA_VERSION = 1

/**
 * The repository-relative budget file a consumer opted into with
 * `build_budget_file`, or null when the key is absent or empty. Only an
 * explicit setting turns enforcement on, so repositories that never set it
 * keep the Build lane exactly as it was.
 * @param {Record<string, string>} config
 * @returns {string | null}
 */
export function buildBudgetSetting(config) {
  const value = config.build_budget_file
  return value === undefined || value === '' ? null : value
}

/**
 * Read and validate `lanes.build.ceilingSeconds` from an opted-in budget file.
 * Every problem throws: an opted-in consumer fails closed rather than building
 * without a ceiling.
 * @param {string} root
 * @param {string} file repository-relative path from `build_budget_file`
 * @returns {{ file: string, schemaVersion: number, ceilingSeconds: number }}
 */
export function readBuildBudget(root, file) {
  let target
  try {
    target = evidencePath(root, file)
  } catch (error) {
    throw new Error(
      `Build budget file is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
  let raw
  try {
    raw = readFileSync(target, 'utf8')
  } catch (error) {
    throw new Error(`Build budget file is missing or unreadable: ${file}`, { cause: error })
  }
  let budgets
  try {
    budgets = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `Build budget file is not valid JSON: ${file}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
  if (!budgets || typeof budgets !== 'object' || Array.isArray(budgets))
    throw new Error(`Build budget file must contain a JSON object: ${file}`)
  if (budgets.schemaVersion !== BUILD_BUDGET_SCHEMA_VERSION)
    throw new Error(
      `Build budget file has unsupported schemaVersion ${JSON.stringify(budgets.schemaVersion)}; expected ${BUILD_BUDGET_SCHEMA_VERSION}: ${file}`
    )
  const lanes = budgets.lanes
  if (!lanes || typeof lanes !== 'object' || Array.isArray(lanes))
    throw new Error(`Build budget file has no lanes object: ${file}`)
  const build = lanes.build
  if (!build || typeof build !== 'object' || Array.isArray(build))
    throw new Error(`Build budget file has no lanes.build entry: ${file}`)
  const ceiling = build.ceilingSeconds
  if (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling <= 0)
    throw new Error(
      `Build budget lanes.build.ceilingSeconds must be a positive finite number of seconds, got ${JSON.stringify(ceiling)}: ${file}`
    )
  return { file, schemaVersion: budgets.schemaVersion, ceilingSeconds: ceiling }
}

/**
 * Compare a measured monotonic interval with the ceiling. The comparison is
 * exact in nanoseconds: a build that takes exactly the ceiling passes, and one
 * nanosecond more fails.
 * @param {bigint} elapsedNanoseconds
 * @param {number} ceilingSeconds
 */
export function evaluateBuildBudget(elapsedNanoseconds, ceilingSeconds) {
  const ceilingNanoseconds = BigInt(Math.round(ceilingSeconds * 1e9))
  return {
    within: elapsedNanoseconds <= ceilingNanoseconds,
    measuredSeconds: Number(elapsedNanoseconds) / 1e9,
    measuredNanoseconds: elapsedNanoseconds.toString(),
    ceilingSeconds,
  }
}
