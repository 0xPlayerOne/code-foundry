// @ts-check

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const METRICS = new Set([
  'coldImportP50Ms',
  'coldImportP95Ms',
  'coldImportRssMaxBytes',
  'coldImportRelativeP50',
  'packedBytes',
  'unpackedBytes',
  'packageFileCount',
  'packageMapFileCount',
  'productionDependencyCount',
])

/**
 * npm 12 keys pack reports by package name; older npm versions return an array.
 * Count reports before validating their shape so an extra malformed entry cannot be ignored.
 * @param {unknown} value
 * @returns {{filename: string, size: number, unpackedSize: number, files: Array<{path: string}>, name?: string, version?: string}}
 */
export function singleNpmPackReport(value) {
  let reports
  if (Array.isArray(value)) reports = value
  else if (value && typeof value === 'object') {
    const object = /** @type {Record<string, unknown>} */ (value)
    reports = typeof object.filename === 'string' ? [object] : Object.values(object)
  } else reports = []
  if (reports.length !== 1) throw new Error('Expected one npm pack report.')
  const packed = reports[0]
  if (!packed || typeof packed !== 'object' || Array.isArray(packed))
    throw new Error('npm pack returned no package result.')
  if (typeof packed.filename !== 'string' || packed.filename.length === 0)
    throw new Error('npm pack result is missing filename.')
  for (const field of ['size', 'unpackedSize'])
    if (typeof packed[field] !== 'number' || !Number.isFinite(packed[field]) || packed[field] < 0)
      throw new Error(`npm pack result is missing non-negative numeric ${field}.`)
  if (
    !Array.isArray(packed.files) ||
    !packed.files.every(
      (/** @type {unknown} */ file) =>
        file !== null &&
        typeof file === 'object' &&
        !Array.isArray(file) &&
        typeof (/** @type {{path?: unknown}} */ (file).path) === 'string'
    )
  )
    throw new Error('npm pack result is missing a valid files list.')
  return packed
}

/**
 * Verify the single npm pack report used to inspect a versioned root package.
 * Supports both npm's legacy array and npm 12's package-name keyed object.
 * @param {unknown} value
 * @param {{name?:unknown,version?:unknown}} manifest
 */
export function verifyNpmPackPackage(value, manifest) {
  const packed = singleNpmPackReport(value)
  if (
    typeof manifest?.name !== 'string' ||
    typeof manifest.version !== 'string' ||
    packed.name !== manifest.name ||
    packed.version !== manifest.version ||
    !packed.files.some((file) => file.path === 'package.json')
  ) {
    throw new Error('npm pack result does not match the root package manifest.')
  }
  return packed
}

/** @param {number[]} values @param {number} percent */
export function percentile(values, percent) {
  if (values.length === 0) throw new Error('percentile requires at least one value')
  // oxlint-disable-next-line unicorn/no-array-sort -- The project typechecks against ES2022.
  const ordered = [...values].sort((a, b) => a - b)
  const position = ((ordered.length - 1) * percent) / 100
  const lower = Math.floor(position)
  const upper = Math.min(lower + 1, ordered.length - 1)
  const fraction = position - lower
  return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction
}

/** @param {string} root @param {string} budgetFile @param {string} resultsDirectory */
export function runNodePackagePerformance(
  root,
  budgetFile = 'performance-package-budgets.json',
  resultsDirectory = 'performance-results'
) {
  const packageJson = readJson(resolve(root, 'package.json'), 'package.json')
  const policy = readJson(resolve(root, budgetFile), budgetFile)
  if (policy.schemaVersion !== 1) throw new Error(`${budgetFile} must declare schemaVersion 1.`)

  const samples = policy.samples ?? 7
  if (!Number.isInteger(samples) || samples < 3 || samples > 50)
    throw new Error(`${budgetFile} samples must be an integer from 3 through 50.`)
  const budgets = policy.budgets
  if (!budgets || typeof budgets !== 'object' || Array.isArray(budgets))
    throw new Error(`${budgetFile} budgets must be an object.`)
  for (const [name, maximum] of Object.entries(budgets)) {
    if (!METRICS.has(name)) throw new Error(`${budgetFile} contains unknown metric ${name}.`)
    if (typeof maximum !== 'number' || !Number.isFinite(maximum) || maximum < 0)
      throw new Error(`${budgetFile} budget ${name} must be a non-negative finite number.`)
  }

  const importTarget = resolve(root, policy.importTarget ?? packageEntry(packageJson))
  if (!existsSync(importTarget))
    throw new Error(`Node package performance import target does not exist: ${importTarget}`)
  const imports = measureImports(root, pathToFileURL(importTarget).href, samples)
  const control = policy.controlImport
    ? measureImports(root, String(policy.controlImport), samples)
    : null
  const pack = npmJson(root, ['pack', '--dry-run', '--json', '--ignore-scripts'], 'npm pack')
  const packed = singleNpmPackReport(pack)
  /** @type {Array<{path?: string}>} */
  const files = Array.isArray(packed.files) ? packed.files : []
  const productionDependencyCount = npmProductionDependencyCount(root)
  const metrics = {
    coldImportP50Ms: round(
      percentile(
        imports.map((sample) => sample.durationMs),
        50
      )
    ),
    coldImportP95Ms: round(
      percentile(
        imports.map((sample) => sample.durationMs),
        95
      )
    ),
    coldImportRssMaxBytes: Math.max(...imports.map((sample) => sample.rssDeltaBytes)),
    ...(control
      ? {
          coldImportRelativeP50: round(
            percentile(
              imports.map((sample) => sample.durationMs),
              50
            ) /
              percentile(
                control.map((sample) => sample.durationMs),
                50
              )
          ),
        }
      : {}),
    packedBytes: numberField(packed, 'size'),
    unpackedBytes: numberField(packed, 'unpackedSize'),
    packageFileCount: files.length,
    packageMapFileCount: files.filter(
      (file) => file && typeof file === 'object' && String(file.path ?? '').endsWith('.map')
    ).length,
    productionDependencyCount,
  }
  const failures = Object.entries(budgets).flatMap(([name, maximum]) => {
    const value = metrics[/** @type {keyof typeof metrics} */ (name)]
    if (typeof value !== 'number' || !Number.isFinite(value)) return [`${name}: metric unavailable`]
    return value > maximum ? [`${name}: ${value} > ${maximum}`] : []
  })
  const result = {
    schemaVersion: 1,
    kind: 'code-foundry-node-package-performance',
    recordedAt: new Date().toISOString(),
    package: typeof packageJson.name === 'string' ? packageJson.name : null,
    importTarget: String(policy.importTarget ?? packageEntry(packageJson)),
    controlImport: policy.controlImport ?? null,
    samples,
    metrics,
    budgets,
    failures,
    passed: failures.length === 0,
  }
  const output = resolve(root, resultsDirectory, 'node-package.json')
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
  return result
}

/** @param {string} root @param {string} specifier @param {number} samples */
function measureImports(root, specifier, samples) {
  return Array.from({ length: samples }, () => {
    const source = [
      'const before = process.memoryUsage().rss',
      'const started = performance.now()',
      `await import(${JSON.stringify(specifier)})`,
      'const durationMs = performance.now() - started',
      'const rssDeltaBytes = Math.max(0, process.memoryUsage().rss - before)',
      'process.stdout.write(JSON.stringify({ durationMs, rssDeltaBytes }))',
    ].join(';')
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
    })
    if (result.error) throw result.error
    if (result.status !== 0)
      throw new Error(`cold import failed for ${specifier}: ${result.stderr.trim()}`)
    const value = JSON.parse(result.stdout)
    if (
      typeof value.durationMs !== 'number' ||
      !Number.isFinite(value.durationMs) ||
      typeof value.rssDeltaBytes !== 'number' ||
      !Number.isFinite(value.rssDeltaBytes)
    )
      throw new Error(`cold import returned invalid metrics for ${specifier}.`)
    return value
  })
}

/** @param {Record<string, any>} packageJson */
function packageEntry(packageJson) {
  const rootExport = packageJson.exports?.['.'] ?? packageJson.exports
  if (typeof rootExport === 'string') return rootExport
  if (rootExport && typeof rootExport === 'object') {
    for (const key of ['import', 'default', 'node', 'require']) {
      if (typeof rootExport[key] === 'string') return rootExport[key]
    }
  }
  for (const key of ['module', 'main']) {
    if (typeof packageJson[key] === 'string') return packageJson[key]
  }
  throw new Error('Unable to infer a package import target; set importTarget in the budget file.')
}

/** @param {string} root */
function npmProductionDependencyCount(root) {
  const result = spawnSync('npm', ['ls', '--omit=dev', '--all', '--parseable', '--silent'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  })
  if (result.error || result.status !== 0) return null
  return Math.max(
    0,
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean).length - 1
  )
}

/** @param {string} root @param {string[]} args @param {string} label */
function npmJson(root, args, label) {
  const result = spawnSync('npm', args, { cwd: root, encoding: 'utf8', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr.trim()}`)
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`${label} did not return valid JSON.`)
  }
}

/** @param {string} file @param {string} label */
function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(
      `${label} must contain valid JSON: ${error instanceof Error ? error.message : error}`,
      { cause: error }
    )
  }
}

/** @param {Record<string, any>} value @param {string} field */
function numberField(value, field) {
  if (typeof value[field] !== 'number' || !Number.isFinite(value[field]))
    throw new Error(`npm pack result is missing numeric ${field}.`)
  return value[field]
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 1000) / 1000
}
