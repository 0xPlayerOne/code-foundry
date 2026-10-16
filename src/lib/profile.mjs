// @ts-check

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { configured, includesValue, readConfig } from './config.mjs'

const ignoredDirectories = new Set([
  '.git',
  '.code-foundry',
  '.kilo',
  '.mise',
  '.next',
  '.nuxt',
  '.venv',
  'node_modules',
  'target',
  'vendor',
])

/** @param {string} root @returns {string[]} */
function sourceFiles(root) {
  /** @type {string[]} */
  const files = []
  /** @param {string} directory */
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else files.push(path)
    }
  }
  visit(root)
  return files
}

/** @param {string} root @param {RegExp} pattern */
function hasSource(root, pattern) {
  return sourceFiles(root).some((file) => pattern.test(file))
}

/** @param {string} root */
export function detectLanguages(root) {
  const files = sourceFiles(root)
  /** @type {string[]} */
  const languages = []
  if (
    existsSync(join(root, 'package.json')) ||
    files.some((file) => /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/.test(file)) ||
    files.some((file) =>
      /(?:bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|package-lock\.json)$/.test(file)
    )
  )
    languages.push('typescript')
  if (existsSync(join(root, 'Cargo.toml')) || hasSource(root, /\.rs$/)) languages.push('rust')
  if (
    existsSync(join(root, 'pyproject.toml')) ||
    existsSync(join(root, 'requirements.txt')) ||
    existsSync(join(root, 'requirements-dev.txt')) ||
    hasSource(root, /\.py$/)
  )
    languages.push('python')
  if (files.some((file) => file.endsWith('.sol'))) languages.push('solidity')
  return languages.length ? languages : ['none']
}

/** @param {string} root */
export function detectPackageManager(root) {
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) return 'bun'
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(root, 'package-lock.json'))) return 'npm'
  if (existsSync(join(root, 'package.json'))) return 'bun'
  return 'none'
}

/** @param {string} root */
export function detectProfile(root) {
  if (existsSync(join(root, 'turbo.json')) || existsSync(join(root, 'pnpm-workspace.yaml')))
    return 'monorepo'
  if (existsSync(join(root, 'package.json'))) {
    try {
      const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      if (Array.isArray(packageJson.workspaces) || typeof packageJson.workspaces === 'object')
        return 'monorepo'
    } catch {
      // Doctor reports malformed package.json separately.
    }
  }
  if (
    existsSync(join(root, 'package.json')) ||
    existsSync(join(root, 'pyproject.toml')) ||
    existsSync(join(root, 'Cargo.toml'))
  )
    return 'application'
  return 'minimal'
}

/** @param {string} root */
export function resolveProfile(root) {
  const config = readConfig(join(root, '.github/code-foundry.yml'))
  const languages = configured(config.languages, 'auto')
  const profile = configured(config.profile, 'auto')
  const packageManager = configured(config.package_manager, 'auto')
  return {
    profile: profile === 'auto' ? detectProfile(root) : profile,
    languages: languages === 'auto' ? detectLanguages(root).join(',') : languages,
    package_manager: packageManager === 'auto' ? detectPackageManager(root) : packageManager,
    features: configured(config.features, 'all'),
    release_type: configured(config.release_type, detectReleaseType(root)),
    npm_publish: configured(config.npm_publish, 'false'),
    runner: configured(config.runner, 'ubuntu-latest'),
  }
}

/**
 * Recommend runners from detected workload cost. Slim is reserved for short
 * metadata/security/PR jobs; native toolchains and browser/contract tests use
 * the full runner.
 * @param {string} root
 */
export function recommendRunners(root) {
  const languages = detectLanguages(root)
  const heavy =
    languages.some((language) => ['rust', 'python', 'solidity'].includes(language)) ||
    hasBrowserProject(root)
  return {
    runner: heavy ? 'ubuntu-latest' : 'ubuntu-slim',
    // The CI lane carries the lint step: oxlint's allocator pool reserves
    // 4 GiB of virtual address space per worker and aborts on ubuntu-slim,
    // so the lint-bearing lane always pins a standard runner.
    ci_runner: 'ubuntu-latest',
    test_runner: heavy ? 'ubuntu-latest' : 'ubuntu-slim',
    unit_runner: heavy ? 'ubuntu-latest' : 'ubuntu-slim',
    performance_runner: 'ubuntu-latest',
    security_runner: 'ubuntu-slim',
    codeql_runner: 'ubuntu-latest',
    pr_runner: 'ubuntu-slim',
    release_runner: 'ubuntu-slim',
  }
}

/** @param {string} root */
function hasBrowserProject(root) {
  return [
    'playwright.config.ts',
    'playwright.config.js',
    'cypress.config.ts',
    'cypress.config.js',
  ].some((file) => existsSync(join(root, file)))
}

/** @param {string} root */
function detectReleaseType(root) {
  if (existsSync(join(root, 'package.json'))) return 'node'
  if (existsSync(join(root, 'pyproject.toml'))) return 'python'
  if (existsSync(join(root, 'Cargo.toml'))) return 'rust'
  if (existsSync(join(root, 'version.txt'))) return 'simple'
  return 'none'
}

export { includesValue }

/**
 * Workspace task runner. `auto` (default) is Turbo when a turbo config exists,
 * else none; Vite+ needs an explicit `monorepo_tool: vite-plus`.
 */
export const MONOREPO_TOOLS = ['auto', 'turbo', 'vite-plus']

/** @typedef {'turbo'|'vite-plus'|'none'} ResolvedTool */
/** @typedef {{ configured: string, tool: ResolvedTool, reason: string, warnings: string[] }} ToolResolution */

/** @param {string} root @returns {Record<string, any> | null} */
function readPackageJson(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/** @param {string} root */
export function hasTurboConfig(root) {
  return existsSync(join(root, 'turbo.json')) || existsSync(join(root, 'turbo.jsonc'))
}

/**
 * Whether a shell command invokes the Vite+ task runner. `vp run ...` and the
 * `vpr` shorthand populate the task cache; plain `vp build` or `vp test` do
 * not, so they are intentionally not matched.
 * @param {string} command
 */
export function commandUsesVitePlus(command) {
  return /(?:^|[\s;&|(])(?:vp\s+(?:-C\s+\S+\s+)?run|vpr)(?:\s|$)/.test(command)
}

/** @param {string} command */
export function commandUsesTurbo(command) {
  return /\bturbo(?:\s|$)/.test(command)
}

/**
 * Evidence that a repository declares Vite+: the `vite-plus` package in any
 * dependency table or a script that runs `vp run` / `vpr`.
 * @param {string} root
 * @returns {{ declared: boolean, via: string[] }}
 */
export function detectVitePlus(root) {
  const packageJson = readPackageJson(root)
  /** @type {string[]} */
  const via = []
  if (!packageJson) return { declared: false, via }
  for (const table of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    if (
      packageJson[table] &&
      typeof packageJson[table] === 'object' &&
      packageJson[table]['vite-plus']
    )
      via.push(`${table}.vite-plus`)
  }
  const scripts =
    packageJson.scripts && typeof packageJson.scripts === 'object' ? packageJson.scripts : {}
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command === 'string' && commandUsesVitePlus(command)) via.push(`scripts.${name}`)
  }
  return { declared: via.length > 0, via }
}

/**
 * Resolve which task runner a repository uses. Never throws: invalid or
 * unsatisfied configuration falls back to the legacy behavior and is reported
 * in `warnings` so doctor can surface it.
 * @param {string} root
 * @param {Record<string, string>} [config] Defaults to .github/code-foundry.yml.
 * @returns {ToolResolution}
 */
export function resolveMonorepoTool(
  root,
  config = readConfig(join(root, '.github/code-foundry.yml'))
) {
  /** @type {string[]} */
  const warnings = []
  let selected = (config.monorepo_tool ?? '').trim() || 'auto'
  if (!MONOREPO_TOOLS.includes(selected)) {
    warnings.push(
      `unsupported monorepo_tool: ${selected}; use auto, turbo, or vite-plus. Falling back to auto.`
    )
    selected = 'auto'
  }
  const turbo = hasTurboConfig(root)

  if (selected === 'vite-plus') {
    const evidence = detectVitePlus(root)
    if (!evidence.declared)
      warnings.push(
        'monorepo_tool: vite-plus but neither a vite-plus dependency nor a `vp run` script was found in package.json.'
      )
    return {
      configured: selected,
      tool: 'vite-plus',
      reason: turbo
        ? 'monorepo_tool: vite-plus (turbo config present but ignored)'
        : 'monorepo_tool: vite-plus',
      warnings,
    }
  }
  if (selected === 'turbo') {
    if (!turbo) warnings.push('monorepo_tool: turbo but no turbo.json or turbo.jsonc was found.')
    return {
      configured: selected,
      tool: turbo ? 'turbo' : 'none',
      reason: 'monorepo_tool: turbo',
      warnings,
    }
  }
  return {
    configured: selected,
    tool: turbo ? 'turbo' : 'none',
    reason: turbo ? 'turbo config detected' : 'no task runner configured',
    warnings,
  }
}
