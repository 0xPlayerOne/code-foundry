// @ts-check

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readConfig } from './config.mjs'
import { resolveMonorepoTool } from './profile.mjs'

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
 * BEFORE_SHA/HEAD_SHA (push). An orchestrator that already resolved the
 * change set once can inject it as a newline-delimited CHANGED_PATHS value;
 * an empty or missing value falls through to local resolution so a stale
 * injection can never widen a skip. Returns null when the change set cannot
 * be resolved; callers treat null as fail-open so a checkout edge never
 * skips a required lane.
 * @param {string} root
 * @param {Record<string, string | undefined>} env
 * @returns {string[] | null}
 */
export function resolveChangedPaths(root, env = process.env) {
  const injected = env.CHANGED_PATHS
  if (injected && injected.trim().length > 0) {
    return injected
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  }
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

/**
 * @typedef {{ name: string, dir: string, dependencies: string[] }} WorkspacePackage
 * `dir` is repo-relative with forward slashes; the workspace root is ''.
 */
/**
 * @typedef {{
 *   tool: 'turbo'|'vite-plus'|'none',
 *   base: string,
 *   head: string,
 *   all: boolean,
 *   conservative: boolean,
 *   reason: string,
 *   changedFiles: number,
 *   packages: string[],
 *   filterArgs: string[],
 * }} AffectedResult
 */

/** Root files whose change can alter every package's build or cache key. */
const GLOBAL_FILE =
  /^(?:package\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|pnpm-workspace\.yaml|turbo\.jsonc?|vite\.config\.[^/]+|tsconfig(?:\.[^/]*)?\.json|\.npmrc|bunfig\.toml|\.mise\.toml|mise\.lock)$/

const SAFE_REF = /^[A-Za-z0-9._/~^@{}-]+$/
const SAFE_PACKAGE_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/i

/** @param {string} ref @param {string} label */
function assertRef(ref, label) {
  if (!ref || ref.startsWith('-') || !SAFE_REF.test(ref))
    throw new Error(`invalid ${label} ref: ${ref}`)
}

/**
 * Workspace globs from package.json `workspaces` (array or `{ packages }`) and
 * pnpm-workspace.yaml `packages:`.
 * @param {string} root
 * @returns {string[]}
 */
export function workspaceGlobs(root) {
  /** @type {string[]} */
  const globs = []
  try {
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const workspaces = packageJson.workspaces
    const list = Array.isArray(workspaces) ? workspaces : workspaces?.packages
    if (Array.isArray(list)) globs.push(...list.filter((item) => typeof item === 'string'))
  } catch {
    // No readable package.json: no declared workspaces.
  }
  const pnpm = join(root, 'pnpm-workspace.yaml')
  if (existsSync(pnpm)) {
    let inPackages = false
    for (const line of readFileSync(pnpm, 'utf8').split(/\r?\n/)) {
      if (/^packages:\s*$/.test(line)) inPackages = true
      else if (/^\S/.test(line)) inPackages = false
      else if (inPackages) {
        const item = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/)
        if (item) globs.push(item[1])
      }
    }
  }
  return globs
}

/** @param {string} root @returns {string[]} repo-relative package directories */
function packageDirectories(root) {
  /** @type {string[]} */
  const found = []
  /** @param {string} directory */
  function visit(directory) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const child = directory ? `${directory}/${entry.name}` : entry.name
      if (existsSync(join(root, child, 'package.json'))) found.push(child)
      visit(child)
    }
  }
  visit('')
  return found
}

/**
 * Discover workspace packages, including the root package when it has a name.
 * @param {string} root
 * @returns {WorkspacePackage[]}
 */
export function listWorkspacePackages(root) {
  const globs = workspaceGlobs(root)
  const includes = globs.filter((glob) => !glob.startsWith('!')).map(globToRegExp)
  const excludes = globs
    .filter((glob) => glob.startsWith('!'))
    .map((glob) => globToRegExp(glob.slice(1)))
  const directories = packageDirectories(root).filter(
    (dir) => includes.some((re) => re.test(dir)) && !excludes.some((re) => re.test(dir))
  )

  /** @type {Array<{ name: string, dir: string, manifest: Record<string, any> }>} */
  const manifests = []
  /** @param {string} dir */
  const load = (dir) => {
    try {
      const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
      if (typeof manifest.name === 'string' && manifest.name) {
        manifests.push({ name: manifest.name, dir, manifest })
      } else if (dir === '') {
        manifests.push({ name: '//', dir, manifest })
      }
    } catch {
      // Malformed manifests are reported by doctor; skip them here.
    }
  }
  load('')
  for (const dir of directories) load(dir)

  const names = new Set(manifests.map((item) => item.name))
  return manifests.map(({ name, dir, manifest }) => ({
    name,
    dir,
    dependencies: [
      ...new Set(
        ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap(
          (table) =>
            Object.keys(manifest[table] ?? {}).filter((dep) => names.has(dep) && dep !== name)
        )
      ),
    ],
  }))
}

/**
 * Map changed files to affected packages: the owning package of each file plus
 * its transitive workspace dependents. A change to a global root file (lockfile,
 * root manifest, runner or TypeScript config) affects every package.
 * @param {WorkspacePackage[]} packages
 * @param {string[]} changedFiles Repo-relative, forward slashes.
 * @returns {{ all: boolean, packages: string[] }}
 */
export function affectedFromChangedFiles(packages, changedFiles) {
  const everything = packages.map((item) => item.name).toSorted()
  if (changedFiles.some((file) => GLOBAL_FILE.test(file)))
    return { all: true, packages: everything }

  const byDepth = packages.toSorted((a, b) => b.dir.length - a.dir.length)
  const direct = new Set()
  for (const file of changedFiles) {
    const owner = byDepth.find((item) => item.dir !== '' && file.startsWith(`${item.dir}/`))
    const resolved = owner ?? packages.find((item) => item.dir === '')
    if (resolved) direct.add(resolved.name)
  }

  const dependents = new Map()
  for (const item of packages)
    for (const dep of item.dependencies) {
      if (!dependents.has(dep)) dependents.set(dep, [])
      dependents.get(dep).push(item.name)
    }
  const affected = new Set(direct)
  const queue = [...direct]
  while (queue.length) {
    for (const next of dependents.get(queue.pop()) ?? []) {
      if (!affected.has(next)) {
        affected.add(next)
        queue.push(next)
      }
    }
  }
  return { all: false, packages: [...affected].toSorted() }
}

/**
 * Arguments for `vp run` that select the given packages. The workspace root
 * package has no name filter; Vite+ selects it with `-w`.
 * @param {WorkspacePackage[]} packages
 * @param {string[]} names
 */
export function vitePlusFilterArgs(packages, names) {
  /** @type {string[]} */
  const args = []
  for (const name of names) {
    const item = packages.find((candidate) => candidate.name === name)
    if (item?.dir === '') args.push('-w')
    else if (SAFE_PACKAGE_NAME.test(name)) args.push('--filter', name)
    else throw new Error(`unsafe package name for --filter: ${name}`)
  }
  return args
}

/**
 * @param {string} root @param {string} base @param {string} head
 * @returns {string[]}
 */
function gitChangedFiles(root, base, head) {
  assertRef(base, 'base')
  assertRef(head, 'head')
  const output = execFileSync(
    'git',
    ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`, '--'],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }
  )
  return output.split('\0').filter(Boolean)
}

/**
 * @param {string} root @param {string} base @param {string} head
 * @param {(command: string, args: string[], cwd: string) => string} run
 * @returns {string[]} affected package names
 */
function turboAffected(root, base, head, run) {
  assertRef(base, 'base')
  assertRef(head, 'head')
  const local = join(root, 'node_modules/.bin/turbo')
  const output = run(
    existsSync(local) ? local : 'turbo',
    ['query', 'affected', '--packages', `--base=${base}`, `--head=${head}`, '--no-update-notifier'],
    root
  )
  const result = JSON.parse(output)
  const items = result?.data?.affectedPackages?.items ?? result?.data?.affectedTasks?.items
  if (!Array.isArray(items)) throw new Error('Turbo affected query returned no package/task items')
  return [
    ...new Set(
      items
        .map(
          (/** @type {any} */ item) =>
            item?.name ?? item?.package?.name ?? String(item?.fullName ?? '').split('#')[0]
        )
        .filter(Boolean)
    ),
  ].toSorted()
}

/** @type {(command: string, args: string[], cwd: string) => string} */
const defaultRun = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })

/**
 * Select the packages affected between two refs using the repository's task
 * runner. Turbo asks `turbo query affected`; Vite+ has no equivalent query, so
 * the change set comes from git and the workspace dependency graph. Whenever
 * affectedness cannot be proven the result is conservative (`all: true`), so a
 * caller that skips unaffected packages never skips a changed one.
 * @param {string} root
 * @param {{ base: string, head: string, tool?: string, run?: (command: string, args: string[], cwd: string) => string }} options
 * @returns {AffectedResult}
 */
export function affectedPackages(root, options) {
  const config = readConfig(join(root, '.github/code-foundry.yml'))
  const requested = options.tool && options.tool !== 'auto' ? options.tool : undefined
  const resolution = resolveMonorepoTool(
    root,
    requested ? { ...config, monorepo_tool: requested } : config
  )
  const packages = listWorkspacePackages(root)
  const everything = packages.map((item) => item.name).toSorted()
  const { base, head } = options

  /** @param {Partial<AffectedResult> & { reason: string }} partial @returns {AffectedResult} */
  const result = (partial) => ({
    tool: resolution.tool,
    base,
    head,
    all: false,
    conservative: false,
    changedFiles: 0,
    packages: [],
    filterArgs: [],
    ...partial,
  })
  /** @param {string} reason */
  const conservative = (reason) =>
    result({
      all: true,
      conservative: true,
      reason,
      packages: everything,
    })

  if (resolution.tool === 'none')
    return conservative(
      `no task runner configured (${resolution.reason}); treating all packages as affected`
    )

  try {
    if (resolution.tool === 'turbo') {
      const names = turboAffected(root, base, head, options.run ?? defaultRun)
      return result({
        reason: 'turbo query affected',
        packages: names,
        all: everything.length > 0 && names.length === everything.length,
      })
    }
    const files = gitChangedFiles(root, base, head)
    const selection = affectedFromChangedFiles(packages, files)
    return result({
      reason: selection.all ? 'global workspace file changed' : 'git diff and workspace graph',
      changedFiles: files.length,
      all: selection.all,
      packages: selection.packages,
      // An empty selection must stay empty: callers skip the run instead of
      // passing no filters, which would run every package.
      filterArgs: selection.all ? [] : vitePlusFilterArgs(packages, selection.packages),
    })
  } catch (error) {
    return conservative(
      `affected selection failed (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); treating all packages as affected`
    )
  }
}
