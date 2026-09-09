// @ts-check

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { listValue, readConfig } from './config.mjs'

export const TASKS = Object.freeze([
  'format',
  'lint',
  'type_check',
  'build',
  'unit',
  'integration',
  'e2e',
  'smoke',
  'eval',
  'performance',
])

/** @type {Readonly<Record<string, readonly string[]>>} */
export const TASK_SCRIPTS = Object.freeze({
  format: ['format:check', 'format', 'fmt'],
  lint: ['lint'],
  type_check: ['type-check', 'typecheck', 'type:check'],
  build: ['build'],
  unit: ['test:unit', 'test:coverage', 'test'],
  integration: ['test:integration'],
  e2e: ['test:e2e', 'e2e'],
  smoke: ['test:smoke', 'smoke'],
  eval: ['eval'],
  performance: ['performance:check', 'perf:check'],
})

/** @param {string} root */
export function readTaskPolicy(root) {
  const config = readConfig(resolve(root, '.github/code-foundry.yml'))
  const required = listValue(config.required_capabilities ?? '')
  for (const capability of required) {
    if (![...TASKS, 'coverage'].includes(capability))
      throw new Error(`Unknown required capability: ${capability}`)
  }
  if (!['true', 'false', 'auto'].includes(config.performance ?? 'auto'))
    throw new Error('performance must be true, false, or auto')
  if (!['true', 'false', 'auto'].includes(config.eval ?? 'auto'))
    throw new Error('eval must be true, false, or auto')
  const coverageMode = config.coverage_enforcement ?? 'auto'
  if (!['auto', 'required', 'off'].includes(coverageMode))
    throw new Error('coverage_enforcement must be auto, required, or off')
  if (required.includes('coverage') && coverageMode === 'off')
    throw new Error('Required coverage cannot use coverage_enforcement: off')
  if (required.includes('performance') && config.performance === 'false')
    throw new Error('Required performance cannot use performance: false')
  if (config.performance === 'true' && !required.includes('performance'))
    required.push('performance')
  if (required.includes('eval') && config.eval === 'false')
    throw new Error('Required eval cannot use eval: false')
  if (config.eval === 'true' && !required.includes('eval')) required.push('eval')
  const coverageRequired = required.includes('coverage') || coverageMode === 'required'
  if (coverageRequired && !required.includes('unit')) required.push('unit')
  const minimum = Number(config.coverage_minimum ?? '80')
  if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100)
    throw new Error('coverage_minimum must be a finite percentage between 0 and 100')
  const metrics = listValue(config.coverage_metrics ?? 'lines')
  if (
    !metrics.length ||
    metrics.some(
      (metricName) => !['lines', 'functions', 'branches', 'statements'].includes(metricName)
    )
  )
    throw new Error('coverage_metrics must select lines, functions, branches, or statements')
  return { config, required, coverageMode, coverageRequired, minimum, metrics }
}

/** @param {string} root @returns {Record<string, any>} */
export function readTaskPackage(root) {
  const file = resolve(root, 'package.json')
  if (!existsSync(file)) return {}
  const value = JSON.parse(readFileSync(file, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('package.json must contain an object')
  return value
}

/**
 * Explain the core's applicability decision and reject known native no-ops.
 * Discovery is not execution; a native command may still fail at run time.
 * @param {string} root
 * @param {string} task
 * @param {Record<string, string>} profile
 */
export function describeTask(root, task, profile) {
  if (!TASKS.includes(task)) throw new Error(`Unknown CI task: ${task}`)
  const policy = readTaskPolicy(root)
  const pkg = readTaskPackage(root)
  const script = TASK_SCRIPTS[task]?.find((name) => {
    const value = pkg.scripts?.[name]
    return typeof value === 'string' && value.trim().length > 0
  })
  const required = policy.required.includes(task)
  let applicable = profile.applicable === 'true'
  let reason = applicable ? 'native runtime discovery' : 'no supported entrypoint was discovered'
  if (script && applicable) reason = `package-script:${script}`
  if (applicable && !script && ['format', 'lint', 'type_check', 'build'].includes(task)) {
    const rust = profile.rust === 'true' && existsSync(resolve(root, 'Cargo.toml'))
    const python =
      profile.python === 'true' &&
      (existsSync(resolve(root, 'pyproject.toml')) ||
        existsSync(resolve(root, 'requirements.txt')) ||
        existsSync(resolve(root, 'uv.lock')))
    const js = profile.javascript === 'true' && existsSync(resolve(root, 'package.json'))
    const native =
      rust ||
      (['format', 'lint'].includes(task) && python) ||
      (task === 'type_check' && existsSync(resolve(root, 'tsconfig.json'))) ||
      (js && task === 'format' && hasNativeToolSetup(root, pkg, 'oxfmt')) ||
      (js && task === 'lint' && hasNativeToolSetup(root, pkg, 'oxlint'))
    if (!native) {
      applicable = false
      reason = 'repository detected, but no executable script or supported native fallback exists'
    }
  }
  if (required && !applicable) throw new Error(`Required capability ${task}: ${reason}`)
  return {
    task,
    applicable,
    required,
    reason,
    source: script ? `package-script:${script}` : 'runtime',
  }
}

/** @param {string} root @returns {string[]} */
function repositoryFiles(root) {
  const result = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : []
}

/** @param {string} root @param {Record<string, any>} pkg @param {'oxfmt'|'oxlint'} tool */
function hasNativeToolSetup(root, pkg, tool) {
  const dependencies = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.optionalDependencies,
    ...pkg.peerDependencies,
  }
  if (dependencies[tool]) return true
  if (
    Object.values(pkg.scripts ?? {}).some((value) =>
      new RegExp(`\\b${tool}\\b`).test(String(value))
    )
  )
    return true
  const config =
    tool === 'oxfmt'
      ? /(^|\/)(\.oxfmtrc\.json|oxfmt\.config\.[^/]*)$/
      : /(^|\/)(\.oxlintrc\.json|oxlint\.config\.[^/]*)$/
  return repositoryFiles(root).some((file) => config.test(file))
}

/** Repository-owned evidence must never escape the checkout through paths or symlinks.
 * @param {string} root @param {string} file
 */
export function evidencePath(root, file) {
  if (!file || isAbsolute(file)) throw new Error('Evidence paths must be repository-relative')
  const base = realpathSync(root)
  const target = resolve(base, file)
  const inside = relative(base, target)
  if (inside === '..' || inside.startsWith(`..${sep}`))
    throw new Error(`Evidence path escapes repository: ${file}`)

  // Resolve the deepest existing ancestor so a missing report cannot hide
  // behind a symlinked directory outside the checkout.
  let existing = target
  while (!existsSync(existing)) {
    const parent = resolve(existing, '..')
    if (parent === existing) break
    existing = parent
  }
  const actual = relative(base, realpathSync(existing))
  if (actual === '..' || actual.startsWith(`..${sep}`))
    throw new Error(`Evidence symlink escapes repository: ${file}`)
  if (existsSync(target) && !statSync(target).isFile())
    throw new Error(`Evidence must be a regular file: ${file}`)
  return target
}

/** @param {string} root @param {ReturnType<typeof readTaskPolicy>} policy */
export function coverageFiles(root, policy) {
  const configured = listValue(policy.config.coverage_report ?? '')
  return (
    configured.length ? configured : ['coverage/coverage-summary.json', 'coverage/lcov.info']
  ).map((file) => ({ file, path: evidencePath(root, file) }))
}

/** @param {string} path */
export function fingerprint(path) {
  if (!existsSync(path)) return null
  const stat = statSync(path)
  return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
}

/** @param {number} total @param {number} covered @param {string} label */
function metric(total, covered, label) {
  if (
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(covered) ||
    total < 0 ||
    covered < 0 ||
    covered > total
  )
    throw new Error(`Invalid coverage counts for ${label}`)
  return { total, covered, percent: total ? (covered * 100) / total : null }
}

/** @param {string} content @param {'json'|'lcov'} format */
export function parseCoverage(content, format) {
  /** @type {Record<string, {total: number, covered: number, percent: number|null}>} */
  const metrics = {}
  if (format === 'json') {
    const report = JSON.parse(content)
    if (!report?.total || typeof report.total !== 'object')
      throw new Error('Coverage summary is missing total')
    for (const name of ['lines', 'functions', 'branches', 'statements']) {
      if (report.total[name])
        metrics[name] = metric(report.total[name].total, report.total[name].covered, name)
    }
  } else {
    const fields = { lines: ['LF', 'LH'], functions: ['FNF', 'FNH'], branches: ['BRF', 'BRH'] }
    const records = content.split(/end_of_record\s*(?:\r?\n|$)/).filter((record) => record.trim())
    if (!records.length) throw new Error('LCOV report contains no records')
    for (const record of records) {
      if (!/^SF:.+/m.test(record)) throw new Error('LCOV record is missing SF')
      for (const [name, [totalKey, hitKey]] of Object.entries(fields)) {
        const totalMatch = record.match(new RegExp(`^${totalKey}:(\\d+)\\r?$`, 'm'))
        const hitMatch = record.match(new RegExp(`^${hitKey}:(\\d+)\\r?$`, 'm'))
        if (!totalMatch && !hitMatch) continue
        if (!totalMatch || !hitMatch) throw new Error(`Incomplete LCOV ${name} counts`)
        const current = metric(Number(totalMatch[1]), Number(hitMatch[1]), name)
        const previous = metrics[name] ?? { total: 0, covered: 0 }
        metrics[name] = metric(
          previous.total + current.total,
          previous.covered + current.covered,
          name
        )
      }
    }
  }
  if (!metrics.lines?.total) throw new Error('Coverage report measured no lines')
  return metrics
}

/**
 * Auto enforces present reports but reports absence explicitly. Required mode also
 * rejects absent/stale reports. Reports are never deleted to manufacture freshness.
 * @param {string} root
 * @param {ReturnType<typeof readTaskPolicy>} policy
 * @param {Record<string, string|null>} before
 */
export function evaluateCoverage(root, policy, before) {
  if (policy.coverageMode === 'off')
    return { status: 'skipped', reason: 'coverage enforcement explicitly disabled', artifacts: [] }
  const files = coverageFiles(root, policy).filter(({ path }) => existsSync(path))
  if (!files.length) {
    if (policy.coverageRequired) throw new Error('Required coverage report was not produced')
    return {
      status: 'skipped',
      reason: 'no coverage report; set coverage_enforcement: required to require evidence',
      artifacts: [],
    }
  }
  const reports = files.map(({ file, path }) => {
    if (fingerprint(path) === before[file])
      throw new Error(`Coverage report was not refreshed by this run: ${file}`)
    const metrics = parseCoverage(
      readFileSync(path, 'utf8'),
      file.endsWith('.info') ? 'lcov' : 'json'
    )
    for (const name of policy.metrics) {
      const value = metrics[name]
      if (!value || value.percent === null)
        throw new Error(`Coverage report has no measured ${name}: ${file}`)
      if (value.percent < policy.minimum)
        throw new Error(
          `${name} coverage ${value.percent.toFixed(2)}% is below ${policy.minimum}% (${file})`
        )
    }
    return { file, metrics }
  })
  return {
    status: 'passed',
    reason: 'fresh coverage meets configured thresholds',
    artifacts: files.map(({ file }) => file),
    reports,
  }
}
