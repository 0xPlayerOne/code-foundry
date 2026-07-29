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
    files.some((file) => /(?:bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|package-lock\.json)$/.test(file))
  ) languages.push('typescript')
  if (existsSync(join(root, 'Cargo.toml')) || hasSource(root, /\.rs$/)) languages.push('rust')
  if (
    existsSync(join(root, 'pyproject.toml')) ||
    existsSync(join(root, 'requirements.txt')) ||
    existsSync(join(root, 'requirements-dev.txt')) ||
    hasSource(root, /\.py$/)
  ) languages.push('python')
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
  if (existsSync(join(root, 'turbo.json')) || existsSync(join(root, 'pnpm-workspace.yaml'))) return 'monorepo'
  if (existsSync(join(root, 'package.json'))) {
    try {
      const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      if (Array.isArray(packageJson.workspaces) || typeof packageJson.workspaces === 'object') return 'monorepo'
    } catch {
      // Doctor reports malformed package.json separately.
    }
  }
  if (existsSync(join(root, 'package.json')) || existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'Cargo.toml'))) return 'application'
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
  const heavy = languages.some((language) => ['rust', 'python', 'solidity'].includes(language)) || hasBrowserProject(root)
  return {
    runner: heavy ? 'ubuntu-latest' : 'ubuntu-slim',
    ci_runner: heavy ? 'ubuntu-latest' : 'ubuntu-slim',
    test_runner: heavy ? 'ubuntu-latest' : 'ubuntu-slim',
    unit_runner: heavy ? 'ubuntu-latest' : 'ubuntu-slim',
    security_runner: 'ubuntu-slim',
    codeql_runner: 'ubuntu-latest',
    pr_runner: 'ubuntu-slim',
    release_runner: 'ubuntu-slim',
  }
}

/** @param {string} root */
function hasBrowserProject(root) {
  return ['playwright.config.ts', 'playwright.config.js', 'cypress.config.ts', 'cypress.config.js'].some((file) => existsSync(join(root, file)))
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
