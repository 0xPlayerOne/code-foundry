// @ts-check

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_RELEASE_FILES = new Set([
  '.release-please-manifest.json',
  'CHANGELOG.md',
  'Cargo.lock',
  'Cargo.toml',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'package.json',
  'pnpm-lock.yaml',
  'pyproject.toml',
  'uv.lock',
  'version.txt',
  'yarn.lock',
])

/** @param {string} root @returns {Record<string, unknown>} */
export function readReleaseConfig(root) {
  const file = join(root, 'release-please-config.json')
  if (!existsSync(file)) return {}
  try { return JSON.parse(readFileSync(file, 'utf8')) }
  catch { return {} }
}

/**
 * Return the release files allowed to change during an automated reconciliation.
 * Package manifests are scoped beneath their Release Please package directory.
 * @param {Record<string, unknown>} config
 * @returns {Set<string>}
 */
export function approvedReleaseFiles(config = {}) {
  const allowed = new Set(DEFAULT_RELEASE_FILES)
  addExtraFiles(allowed, config['extra-files'])
  const packages = config.packages
  if (packages && typeof packages === 'object' && !Array.isArray(packages)) {
    for (const [directory, value] of Object.entries(packages)) {
      const prefix = directory === '.' ? '' : directory.replace(/\/$/, '')
      for (const file of DEFAULT_RELEASE_FILES) addPath(allowed, prefix, file)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        addExtraFiles(allowed, value['extra-files'], prefix)
      }
    }
  }
  return allowed
}

/** @param {Set<string>} allowed @param {unknown} entries @param {string} [prefix] */
function addExtraFiles(allowed, entries, prefix = '') {
  if (!Array.isArray(entries)) return
  for (const entry of entries) {
    const path = typeof entry === 'string' ? entry : entry && typeof entry === 'object' && 'path' in entry ? entry.path : ''
    if (typeof path === 'string' && path) addPath(allowed, prefix, path)
  }
}

/** @param {Set<string>} allowed @param {string} prefix @param {string} path */
function addPath(allowed, prefix, path) {
  const clean = path.replace(/^\.\//, '').replace(/\\/g, '/')
  allowed.add(prefix ? `${prefix}/${clean}` : clean)
}

/** @param {string[]} paths @param {Set<string>} allowed @returns {string[]} */
export function unexpectedReleasePaths(paths, allowed) {
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))]
    .filter((path) => !allowed.has(path))
}

/**
 * Classify the relationship between main and staging. A fast-forward is safe
 * only when main is the ancestor of staging or staging is the ancestor of main
 * and the intervening main files are release metadata.
 * @param {{ mainSha: string, stagingSha: string, mergeBaseSha?: string, mainChangedPaths?: string[], stagingChangedPaths?: string[], allowed?: Set<string> }} input
 */
export function classifyReconciliation(input) {
  const {
    mainSha,
    stagingSha,
    mergeBaseSha = '',
    mainChangedPaths = [],
    stagingChangedPaths = [],
    allowed = approvedReleaseFiles(),
  } = input
  if (!mainSha || !stagingSha) return { action: 'fail', reason: 'Missing branch SHA.' }
  if (mainSha === stagingSha) return { action: 'aligned', reason: 'Branches already point at the same commit.' }
  if (mainSha === mergeBaseSha) {
    return { action: 'none', reason: 'staging contains commits that are not on main; no release-only reconciliation is needed.' }
  }
  const unexpectedMain = unexpectedReleasePaths(mainChangedPaths, allowed)
  const unexpectedStaging = unexpectedReleasePaths(stagingChangedPaths, allowed)
  if (unexpectedMain.length || unexpectedStaging.length) {
    return {
      action: 'fail',
      reason: 'Branch divergence includes repository code or configuration.',
      unexpected: [...new Set([...unexpectedMain, ...unexpectedStaging])],
    }
  }
  if (stagingSha === mergeBaseSha) {
    return { action: 'fast-forward', targetSha: mainSha, reason: 'main only added approved release metadata.' }
  }
  return { action: 'pull-request', targetSha: mainSha, reason: 'Branches diverged, but only approved release metadata changed.' }
}

export { DEFAULT_RELEASE_FILES }
