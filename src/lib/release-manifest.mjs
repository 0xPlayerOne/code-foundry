// @ts-check

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ignored = new Set(['.git', '.code-foundry', '.venv', 'node_modules', 'target', 'vendor', 'dist', 'build', '.next', '.kilo', '.turbo', '.cache', '.vercel', '.output', '.nuxt', '.svelte-kit', '.parcel-cache', 'out', 'coverage'])

/** @typedef {{ directory: string, manifest: string, releaseType: 'node'|'python'|'rust', packageName?: string, extraFiles: string[] }} ReleasePackage */

/** @param {string} root @returns {ReleasePackage[]} */
export function detectReleasePackages(root) {
  /** @type {ReleasePackage[]} */
  const packages = []
  walk(root, (file) => {
    const name = file.split('/').pop()
    const directory = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.'
    if (name === 'package.json') {
      const parsed = readJson(join(root, file))
      packages.push({ directory, manifest: file, releaseType: 'node', packageName: typeof parsed?.name === 'string' ? parsed.name : undefined, extraFiles: detectExtraFiles(root, directory) })
    } else if (name === 'Cargo.toml') {
      packages.push({ directory, manifest: file, releaseType: 'rust', packageName: tomlPackageName(join(root, file)), extraFiles: detectExtraFiles(root, directory) })
    } else if (name === 'pyproject.toml') {
      packages.push({ directory, manifest: file, releaseType: 'python', packageName: pyprojectName(join(root, file)), extraFiles: detectExtraFiles(root, directory) })
    }
  })
  return packages.sort((a, b) => a.directory.localeCompare(b.directory))
}

/**
 * Merge automatic package and extra-file detection into a Release Please
 * configuration without discarding repository-owned settings.
 * @param {string} root
 * @param {Record<string, any>} existing
 */
export function buildReleaseConfig(root, existing = {}) {
  const packages = detectReleasePackages(root)
  const result = { ...existing }
  if (!packages.length) return result
  // An explicit packages map is repository policy. Do not silently turn
  // version-synchronized subprojects or vendored manifests into releases.
  if (Object.prototype.hasOwnProperty.call(existing, 'packages')) return result
  if (packages.length === 1 && packages[0].directory === '.') {
    result['release-type'] ??= packages[0].releaseType
    /** @type {any[]} */
    const extra = Array.isArray(result['extra-files']) ? result['extra-files'] : []
    result['extra-files'] = extra
    for (const file of packages[0].extraFiles) {
      if (!extra.some((entry) => (typeof entry === 'string' ? entry : entry?.path) === file)) extra.push(file)
    }
    return result
  }
  /** @type {Record<string, any>} */
  const configuredPackages = { ...(result.packages ?? {}) }
  for (const entry of packages) {
    const current = { ...(configuredPackages[entry.directory] ?? {}) }
    current['release-type'] ??= entry.releaseType
    if (entry.packageName) current['package-name'] ??= entry.packageName
    /** @type {any[]} */
    const extra = Array.isArray(current['extra-files']) ? [...current['extra-files']] : []
    for (const file of entry.extraFiles) if (!extra.some((item) => (typeof item === 'string' ? item : item?.path) === file)) extra.push(file)
    if (extra.length) current['extra-files'] = extra
    configuredPackages[entry.directory] = current
  }
  result.packages = configuredPackages
  delete result['release-type']
  return result
}

/**
 * Build the initial Release Please manifest from current package versions.
 * Returns null when the config does not enable manifest mode (legacy configs
 * without `packages`/`release-type` run in simple mode and need no manifest).
 * @param {string} root
 * @param {Record<string, any>} config
 * @returns {Record<string, string>|null}
 */
export function buildReleaseManifest(root, config = {}) {
  const packages = config.packages && typeof config.packages === 'object' && !Array.isArray(config.packages)
    ? config.packages
    : config['release-type'] ? { '.': {} } : null
  if (!packages || !Object.keys(packages).length) return null
  /** @type {Record<string, string>} */
  const manifest = {}
  for (const directory of Object.keys(packages)) {
    manifest[directory] = readDirectoryVersion(join(root, directory === '.' ? '' : directory))
  }
  return manifest
}

/** @param {string} directory @returns {string} */
function readDirectoryVersion(directory) {
  const packagePath = join(directory, 'package.json')
  if (existsSync(packagePath)) {
    try {
      const parsed = JSON.parse(readFileSync(packagePath, 'utf8'))
      if (typeof parsed?.version === 'string' && parsed.version) return parsed.version
    } catch { /* fall through to other manifests */ }
  }
  for (const file of ['pyproject.toml', 'Cargo.toml']) {
    const path = join(directory, file)
    if (!existsSync(path)) continue
    const match = readFileSync(path, 'utf8').match(/^version\s*=\s*["']([^"']+)["']/m)
    if (match?.[1]) return match[1]
  }
  return '0.0.0'
}

/** @param {string} root @param {Record<string, any>} config @returns {string[]} */
export function validateReleaseConfig(root, config) {
  const detected = detectReleasePackages(root)
  if (!detected.length) return []
  const configured = config.packages && typeof config.packages === 'object' ? config.packages : null
  if (detected.length > 1 && !configured) return ['mixed-language or multi-package repositories require release-please packages configuration']
  if (!configured) return []
  const errors = []
  for (const entry of detected) {
    const item = configured[entry.directory]
    if (!item) errors.push(`release-please packages is missing ${entry.directory}`)
    else if (item['release-type'] !== entry.releaseType) errors.push(`${entry.directory} release-type should be ${entry.releaseType}`)
  }
  return errors
}

/** @param {string} root @param {(file: string) => void} visit */
function walk(root, visit) {
  /** @param {string} directory */
  function descend(directory) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (entry.isDirectory() && ignored.has(entry.name)) continue
      const path = directory ? `${directory}/${entry.name}` : entry.name
      if (entry.isDirectory()) descend(path)
      else visit(path)
    }
  }
  descend('')
}

/** @param {string} root @param {string} directory @returns {string[]} */
function detectExtraFiles(root, directory) {
  const candidates = ['version.txt', 'VERSION', '.version', 'version.json', 'src/version.ts', 'src/version.js', 'src/version.py', 'src/version.rs']
  return candidates
    .map((file) => directory === '.' ? file : `${directory}/${file}`)
    .filter((file) => existsSync(join(root, file)))
    .map((file) => directory === '.' ? file : file.slice(directory.length + 1))
}

/** @param {string} file @returns {any} */
function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) }
  catch { return {} }
}

/** @param {string} file @returns {string|undefined} */
function tomlPackageName(file) {
  const match = readFileSync(file, 'utf8').match(/^name\s*=\s*["']([^"']+)["']/m)
  return match?.[1]
}

/** @param {string} file @returns {string|undefined} */
function pyprojectName(file) {
  const match = readFileSync(file, 'utf8').match(/^(?:name|name\s*)\s*=\s*["']([^"']+)["']/m)
  return match?.[1]
}
