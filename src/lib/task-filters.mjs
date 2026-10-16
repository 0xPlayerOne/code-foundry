// @ts-check

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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
/** @typedef {{ label: string, files: string[], read: (path: string) => string }} WorkspaceSource */
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
 *   removedPackages: string[],
 *   filterArgs: string[],
 * }} AffectedResult
 */

/** Unowned files that cannot change a build; any other unowned file selects all packages. */
const NON_BUILD_FILE = /^(?:(?:[^/]+\.(?:md|mdx|txt))|LICENSE[^/]*|NOTICE|\.gitignore|docs\/.*)$/i

const SAFE_REF = /^[A-Za-z0-9._/~^@{}-]+$/
const SAFE_PACKAGE_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/i
/** Workspace glob syntax this module cannot evaluate faithfully. */
const UNSUPPORTED_GLOB = /[{}[\]()+@\\]|^!!|\*\*[^/]|[^/]\*\*/

/** @param {string} ref @param {string} label */
function assertRef(ref, label) {
  if (!ref || ref.startsWith('-') || !SAFE_REF.test(ref))
    throw new Error(`invalid ${label} ref: ${ref}`)
}

/**
 * Workspace files as of a git ref (committed objects, not the working tree).
 * @param {string} root
 * @param {string} ref
 * @returns {WorkspaceSource}
 */
export function gitWorkspaceSource(root, ref) {
  assertRef(ref, 'workspace')
  const git = (/** @type {string[]} */ args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    })
  const files = git(['ls-tree', '-r', '-z', '--name-only', ref]).split('\0').filter(Boolean)
  return { label: ref, files, read: (path) => git(['show', `${ref}:${path}`]) }
}

/**
 * Workspace globs from package.json `workspaces` and pnpm-workspace.yaml.
 * Throws on syntax it cannot evaluate so callers fail closed.
 * @param {WorkspaceSource} source
 * @returns {string[]}
 */
export function workspaceGlobs(source) {
  /** @type {string[]} */
  const globs = []
  if (source.files.includes('package.json')) {
    let manifest
    try {
      manifest = JSON.parse(source.read('package.json'))
    } catch {
      throw new Error(`malformed package.json at ${source.label}`)
    }
    const workspaces = manifest.workspaces
    const list = Array.isArray(workspaces) ? workspaces : workspaces?.packages
    if (workspaces !== undefined && !Array.isArray(list))
      throw new Error('unsupported workspaces declaration in package.json')
    if (Array.isArray(list)) {
      for (const item of list) {
        if (typeof item !== 'string') throw new Error('non-string workspace glob in package.json')
        globs.push(item)
      }
    }
  }
  if (source.files.includes('pnpm-workspace.yaml')) {
    let inPackages = false
    for (const line of source.read('pnpm-workspace.yaml').split(/\r?\n/)) {
      if (/^packages:\s*$/.test(line)) inPackages = true
      else if (/^packages:\s*\S/.test(line)) {
        // Flow style: packages: ['apps/*', 'packages/*']
        const flow = line.match(/^packages:\s*\[(.*)\]\s*(?:#.*)?$/)
        if (!flow) throw new Error('unsupported packages declaration in pnpm-workspace.yaml')
        for (const part of flow[1].split(',')) {
          const entry = part.trim()
          if (!entry) continue
          const item = entry.match(/^(['"]?)([^'"]+)\1$/)
          if (!item) throw new Error(`unsupported pnpm-workspace.yaml entry: ${entry}`)
          globs.push(item[2])
        }
      } else if (/^\S/.test(line)) inPackages = false
      else if (inPackages) {
        if (/^\s*(?:#.*)?$/.test(line)) continue
        const item = line.match(/^\s*-\s*(['"]?)([^'"#]+?)\1\s*(?:#.*)?$/)
        if (!item) throw new Error(`unsupported pnpm-workspace.yaml entry: ${line.trim()}`)
        globs.push(item[2])
      }
    }
  }
  for (const glob of globs) {
    const body = glob.startsWith('!') ? glob.slice(1) : glob
    if (!body || UNSUPPORTED_GLOB.test(body)) throw new Error(`unsupported workspace glob: ${glob}`)
  }
  return globs
}

/**
 * Workspace packages including the root. Throws when a member cannot be read or named.
 * @param {WorkspaceSource} source
 * @returns {WorkspacePackage[]}
 */
export function listWorkspacePackages(source) {
  const globs = workspaceGlobs(source)
  const includes = globs.filter((glob) => !glob.startsWith('!')).map(globToRegExp)
  const excludes = globs
    .filter((glob) => glob.startsWith('!'))
    .map((glob) => globToRegExp(glob.slice(1)))
  const directories = source.files
    .filter((file) => file.endsWith('/package.json') && !file.split('/').includes('node_modules'))
    .map((file) => file.slice(0, -'/package.json'.length))
    .filter((dir) => includes.some((re) => re.test(dir)) && !excludes.some((re) => re.test(dir)))

  /** @type {Array<{ name: string, dir: string, manifest: Record<string, any> }>} */
  const manifests = []
  /** @param {string} dir @param {boolean} isRoot */
  const load = (dir, isRoot) => {
    const path = dir ? `${dir}/package.json` : 'package.json'
    let manifest
    try {
      manifest = JSON.parse(source.read(path))
    } catch {
      throw new Error(`malformed manifest ${path} at ${source.label}`)
    }
    if (typeof manifest.name === 'string' && manifest.name) {
      manifests.push({ name: manifest.name, dir, manifest })
    } else if (isRoot) {
      manifests.push({ name: '//', dir, manifest })
    } else {
      throw new Error(`workspace package ${path} has no name`)
    }
  }
  if (source.files.includes('package.json')) load('', true)
  for (const dir of directories) load(dir, false)

  const seen = new Set()
  for (const item of manifests) {
    if (seen.has(item.name)) throw new Error(`duplicate workspace package name: ${item.name}`)
    seen.add(item.name)
  }
  return manifests.map(({ name, dir, manifest }) => ({
    name,
    dir,
    dependencies: [
      ...new Set(
        ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap(
          (table) =>
            Object.keys(manifest[table] ?? {}).filter((dep) => seen.has(dep) && dep !== name)
        )
      ),
    ],
  }))
}

/**
 * Changed files to affected packages across base and head graphs, so deleted,
 * renamed, and re-wired packages keep their dependents. Unowned build files
 * select every package. Dependents follow the union of all graphs' edges.
 * @param {WorkspacePackage[][]} graphs Head graph first.
 * @param {string[]} changedFiles Repo-relative, forward slashes.
 * @returns {{ all: boolean, packages: string[], reason: string }}
 */
export function affectedFromChangedFiles(graphs, changedFiles) {
  const everything = [...new Set(graphs.flat().map((item) => item.name))].toSorted()
  const direct = new Set()
  for (const file of changedFiles) {
    const owners = new Set()
    for (const graph of graphs) {
      const owner = graph
        .filter((item) => item.dir !== '' && file.startsWith(`${item.dir}/`))
        .toSorted((a, b) => b.dir.length - a.dir.length)[0]
      if (owner) owners.add(owner.name)
    }
    if (owners.size > 0) {
      for (const name of owners) direct.add(name)
    } else if (!NON_BUILD_FILE.test(file)) {
      return { all: true, packages: everything, reason: `shared or unowned file changed: ${file}` }
    }
  }

  const dependents = new Map()
  for (const item of graphs.flat())
    for (const dep of item.dependencies) {
      if (!dependents.has(dep)) dependents.set(dep, new Set())
      dependents.get(dep).add(item.name)
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
  return { all: false, packages: [...affected].toSorted(), reason: 'git diff and workspace graphs' }
}

/**
 * `vp run` arguments selecting the given packages (the root is `-w`).
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

/** @param {unknown} error */
const describe = (error) => (error instanceof Error ? error.message.split('\n')[0] : String(error))

/**
 * Packages affected between two refs. Turbo uses `turbo query affected`; Vite+
 * has no such query, so git and the workspace graphs at both refs decide.
 * Anything unprovable is conservative (`all: true`).
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
    removedPackages: [],
    filterArgs: [],
    ...partial,
  })
  /** @param {string} reason @param {string[]} [names] */
  const conservative = (reason, names = []) =>
    result({ all: true, conservative: true, reason, packages: names })

  if (resolution.tool === 'none')
    return conservative(
      `no task runner configured (${resolution.reason}); treating all packages as affected`
    )

  if (resolution.tool === 'turbo') {
    // Turbo owns its own graph; this module's workspace parsing is never a
    // prerequisite for the Turbo path.
    try {
      return result({
        reason: 'turbo query affected',
        packages: turboAffected(root, base, head, options.run ?? defaultRun),
      })
    } catch (error) {
      return conservative(
        `affected selection failed (${describe(error)}); treating all packages as affected`
      )
    }
  }

  /** @type {string[]} */
  let headNames = []
  try {
    assertRef(base, 'base')
    assertRef(head, 'head')
    const headPackages = listWorkspacePackages(gitWorkspaceSource(root, head))
    headNames = headPackages.map((item) => item.name).toSorted()
    const basePackages = listWorkspacePackages(gitWorkspaceSource(root, base))
    const files = gitChangedFiles(root, base, head)
    const selection = affectedFromChangedFiles([headPackages, basePackages], files)
    const existing = selection.packages.filter((name) => headNames.includes(name))
    const removed = selection.packages.filter((name) => !headNames.includes(name))
    return result({
      reason: selection.reason,
      changedFiles: files.length,
      all: selection.all,
      packages: selection.all ? headNames : existing,
      removedPackages: selection.all ? [] : removed,
      // An empty selection must stay empty: callers skip the run instead of
      // passing no filters, which would run every package.
      filterArgs: selection.all ? [] : vitePlusFilterArgs(headPackages, existing),
    })
  } catch (error) {
    return conservative(
      `affected selection failed (${describe(error)}); treating all packages as affected`,
      headNames
    )
  }
}
