// @ts-check

import { execFileSync } from 'node:child_process'

/**
 * Tasks that support `filter_<task>` path filters in code-foundry.yml. A
 * filter lists repo-relative globs; when every changed path misses the filter
 * the lane reports `affected=false` and its workflow steps skip. CI lanes and
 * security tasks are not filterable because their coverage is structural.
 */
export const FILTERABLE_TASKS = [
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
]

/**
 * Parse `filter_<task>` config keys into per-task glob lists.
 * @param {Record<string, string>} config
 * @returns {Map<string, string[]>}
 */
export function readTaskFilters(config) {
  const filters = new Map()
  for (const task of FILTERABLE_TASKS) {
    const value = config[`filter_${task}`]
    if (value === undefined || value === '') continue
    const globs = value
      .split(',')
      .map((glob) => glob.trim())
      .filter(Boolean)
    if (globs.length > 0) filters.set(task, globs)
  }
  return filters
}

/**
 * Compile a repo-relative glob to a RegExp. Supported syntax: double-star
 * segments match any directory depth, `*` stays inside a path segment, `?`
 * matches one character, and a trailing `/` is a directory shorthand.
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let pattern = glob.replace(/^\.\//, '')
  if (pattern.endsWith('/')) pattern += '**'
  let regex = '^'
  let index = 0
  while (index < pattern.length) {
    if (pattern.startsWith('**/', index)) {
      regex += '(?:[^/]+/)*'
      index += 3
    } else if (pattern.startsWith('/**', index) && index + 3 === pattern.length) {
      regex += '/.*'
      index += 3
    } else if (pattern.startsWith('**', index)) {
      regex += '.*'
      index += 2
    } else if (pattern[index] === '*') {
      regex += '[^/]*'
      index += 1
    } else if (pattern[index] === '?') {
      regex += '[^/]'
      index += 1
    } else {
      regex += pattern[index].replace(/[.+^${}()|[\]\\]/g, '\\$&')
      index += 1
    }
  }
  return new RegExp(`${regex}$`)
}

/**
 * Resolve the pull request or push change set. The generated Detect steps
 * pass EVENT_NAME plus BASE_REF/BASE_SHA/HEAD_SHA (pull_request) or
 * BEFORE_SHA/HEAD_SHA (push). Returns null when the change set cannot be
 * resolved; callers treat null as fail-open so a checkout edge never skips a
 * required lane.
 * @param {string} root
 * @param {Record<string, string | undefined>} env
 * @returns {string[] | null}
 */
export function resolveChangedPaths(root, env = process.env) {
  const event = env.EVENT_NAME
  let range = null
  try {
    if (event === 'pull_request' || event === 'pull_request_target') {
      const baseRef = env.BASE_REF
      const baseSha = env.BASE_SHA
      const head = env.HEAD_SHA || 'HEAD'
      if (!baseSha) return null
      if (baseRef) {
        execFileSync('git', ['fetch', '--no-tags', '--depth=100', 'origin', baseRef], {
          cwd: root,
          stdio: 'pipe',
        })
        range = `FETCH_HEAD...${head}`
      } else {
        range = `${baseSha}...${head}`
      }
    } else if (event === 'push') {
      const before = env.BEFORE_SHA
      const head = env.HEAD_SHA || 'HEAD'
      if (!before || /^0+$/.test(before)) return null
      range = `${before}..${head}`
    } else {
      return null
    }
    const output = execFileSync('git', ['diff', '--name-only', range], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  } catch {
    return null
  }
}

/**
 * Report whether a task's configured path filter matches the change set.
 * Fail-open by contract: no filter, no resolvable diff, or an empty diff all
 * keep the lane running.
 * @param {string} task
 * @param {Map<string, string[]>} filters
 * @param {string[] | null} paths
 * @returns {boolean}
 */
export function taskAffected(task, filters, paths) {
  const globs = filters.get(task)
  if (!globs || globs.length === 0 || paths === null || paths.length === 0) return true
  const matchers = globs.map(globToRegExp)
  return paths.some((path) => matchers.some((matcher) => matcher.test(path)))
}
