// @ts-check

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isReleasePleaseHead } from './validation-policy.mjs'

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
 * Detect release-only divergence after a rebased staging promotion. A normal
 * main-ancestor relationship must always remain promotable, even when the new
 * staging commit happens to touch only release metadata.
 * @param {{ mainIsAncestor: boolean, directChangedPaths?: string[], allowed?: Set<string> }} input
 */
export function classifyPromotion(input) {
  const {
    mainIsAncestor,
    directChangedPaths = [],
    allowed = approvedReleaseFiles(),
  } = input
  const paths = [...new Set(directChangedPaths.map((path) => path.trim()).filter(Boolean))]
  const unexpected = unexpectedReleasePaths(paths, allowed)
  return {
    releaseOnly: !mainIsAncestor && paths.length > 0 && unexpected.length === 0,
    unexpected,
  }
}

/** @param {{ releasePleaseToken?: string, githubToken?: string }} input */
export function selectReleaseCredential(input) {
  if (input.releasePleaseToken) return { token: input.releasePleaseToken, source: 'release-please-token', autoMerge: true }
  if (input.githubToken) return { token: input.githubToken, source: 'github-token', autoMerge: false }
  return { token: '', source: 'missing', autoMerge: false }
}

/** @param {Array<{number?: number, title?: string, headRefName?: string}>} prs */
export function selectGeneratedReleasePrs(prs) {
  return prs.filter((pr) => /^chore\(main\): release /.test(pr.title ?? '') && String(pr.headRefName ?? '').startsWith('release-please--branches--main'))
}

/**
 * Validate all generated release PR diffs before any merge is attempted.
 * @param {Array<{number?: number, title?: string, headRefName?: string}>} prs
 * @param {Map<number, string[]>} changedPathsByPr
 * @param {Set<string>} allowed
 */
export function validateReleasePullRequests(prs, changedPathsByPr, allowed) {
  const errors = []
  const generated = selectGeneratedReleasePrs(prs)
  if (!generated.length) errors.push('Release Please reported a PR, but no generated release PR was found.')
  for (const pr of generated) {
    const number = Number(pr.number)
    const paths = changedPathsByPr.get(number)
    if (!Array.isArray(paths) || !paths.length) {
      errors.push(`Generated release PR #${number} has no changed files or its diff is malformed.`)
      continue
    }
    const unexpected = unexpectedReleasePaths(paths, allowed)
    if (unexpected.length) errors.push(`Generated release PR #${number} contains unexpected paths: ${unexpected.join(', ')}`)
  }
  return { valid: errors.length === 0, generated, errors }
}

/** Files that must change for a generated release PR to count as a version bump. */
const VERSION_METADATA_FILES = new Set([
  '.release-please-manifest.json',
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'version.txt',
])

/**
 * Strict diff and version policy for the release validation tier. The head
 * must carry the exact approved Release Please prefix, come from the same
 * repository, change at least one path, change no unexpected paths, and bump
 * at least one version-metadata file (or a declared extra file).
 * @param {{ headRef?: string, headRepo?: string, repository?: string, changedPaths?: string[], config?: Record<string, unknown> }} input
 * @returns {{ valid: boolean, errors: string[], changedPaths: string[] }}
 */
export function validateGeneratedReleaseDiff(input) {
  const { headRef = '', headRepo = '', repository = '', changedPaths = [], config = {} } = input
  /** @type {string[]} */
  const errors = []
  if (!isReleasePleaseHead(headRef)) {
    errors.push(`Head branch ${headRef || '(missing)'} is not a generated Release Please branch.`)
  }
  if (!repository || !headRepo) {
    errors.push('Generated release validation requires both the head and base repository identities.')
  } else if (headRepo !== repository) {
    errors.push(`Head repository ${headRepo} is not ${repository}; generated release validation requires a same-repository pull request.`)
  }
  const paths = [...new Set(changedPaths.map((path) => String(path).trim()).filter(Boolean))]
  if (!paths.length) errors.push('Generated release pull request has no changed files.')
  const unexpected = unexpectedReleasePaths(paths, approvedReleaseFiles(config))
  if (unexpected.length) errors.push(`Generated release pull request contains unexpected paths: ${unexpected.join(', ')}`)
  const versionMetadata = new Set(VERSION_METADATA_FILES)
  addExtraFiles(versionMetadata, config['extra-files'])
  const packages = config.packages
  if (packages && typeof packages === 'object' && !Array.isArray(packages)) {
    for (const [directory, value] of Object.entries(packages)) {
      const prefix = directory === '.' ? '' : directory.replace(/\/$/, '')
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        addExtraFiles(versionMetadata, value['extra-files'], prefix)
      }
    }
  }
  if (!paths.some((path) => versionMetadata.has(path))) {
    errors.push('Generated release pull request changes no version metadata.')
  }
  return { valid: errors.length === 0, errors, changedPaths: paths }
}

/**
 * Build a non-destructive release recovery plan from independent release
 * metadata sources.
 * @param {{ tags: string[], releases: Array<{tagName?: string}>, releasePrs: Array<{number?: number,title?: string}>, packageVersions: string[] }} input
 */
export function buildReleaseRecoveryPlan(input) {
  const tags = [...new Set(input.tags.filter((tag) => /^v?\d+\.\d+\.\d+/.test(tag)))]
  /** @type {string[]} */
  const releaseTags = [...new Set(input.releases.map((release) => release.tagName).filter((tag) => typeof tag === 'string'))]
  const tagSet = new Set(tags)
  const releaseSet = new Set(releaseTags)
  const missingGitHubReleases = tags.filter((tag) => !releaseSet.has(tag) && !releaseSet.has(tag.replace(/^v/, '')))
  const orphanGitHubReleases = releaseTags.filter((tag) => !tagSet.has(tag) && !tagSet.has(tag.replace(/^v/, '')))
  const latestTag = [...tags].sort(compareVersions).at(-1) ?? ''
  const latestPackageVersion = [...input.packageVersions].sort(compareVersions).at(-1) ?? ''
  return {
    latestTag,
    latestPackageVersion,
    missingGitHubReleases,
    orphanGitHubReleases,
    pendingReleasePullRequests: input.releasePrs,
    packageVersionMismatch: Boolean(latestTag && latestPackageVersion && normalizeVersion(latestTag) !== normalizeVersion(latestPackageVersion)),
    actions: [
      ...missingGitHubReleases.map((tag) => `create GitHub release metadata for ${tag}`),
      ...(latestTag && latestPackageVersion && normalizeVersion(latestTag) !== normalizeVersion(latestPackageVersion) ? [`review package/tag mismatch (${latestPackageVersion} vs ${latestTag})`] : []),
    ],
  }
}

/** @param {string} value */
function normalizeVersion(value) { return value.replace(/^v/, '').split('-')[0] }

/** @param {string} a @param {string} b */
function compareVersions(a, b) {
  const left = normalizeVersion(a).split('.').map(Number)
  const right = normalizeVersion(b).split('.').map(Number)
  for (let index = 0; index < 3; index += 1) if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) - (right[index] ?? 0)
  return a.localeCompare(b)
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
  if (!mainChangedPaths.length && !stagingChangedPaths.length) {
    return { action: 'aligned', targetSha: mainSha, reason: 'Branches have different history but identical content.' }
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
