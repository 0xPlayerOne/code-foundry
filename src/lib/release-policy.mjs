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
 * Classify the relationship between main and staging using the final tree delta
 * when available. Historical commit paths can include equivalent workflow or
 * configuration changes that are no longer present in the branch delta, so the
 * final trees are the source of truth for reconciliation. When
 * directChangedPaths is supplied, unexpected paths in historical main-only
 * commits are ignored only when they are absent from the final tree delta
 * (their content is already identical in both branches); unexpected main-only
 * paths that still differ between the final trees fail closed. Without
 * directChangedPaths the historical check stays strict. Any staging-only
 * commit still triggers a replay path so no staging-only work can be silently
 * discarded.
 * @param {{
 *   mainSha: string,
 *   stagingSha: string,
 *   directChangedPaths?: string[],
 *   mainOnlyCommits?: Array<{ sha?: string, changedPaths?: string[] }>,
 *   stagingOnlyCommits?: Array<{ sha?: string, changedPaths?: string[] }>,
 *   allowed?: Set<string>,
 * }} input
 */
export function classifyReconciliation(input) {
  const {
    mainSha,
    stagingSha,
    directChangedPaths,
    mainOnlyCommits = [],
    stagingOnlyCommits = [],
    allowed = approvedReleaseFiles(),
  } = input
  if (!mainSha || !stagingSha) return { action: 'fail', reason: 'Missing branch SHA.' }
  if (mainSha === stagingSha) return { action: 'aligned', reason: 'Branches already point at the same commit.' }
  const hasIndeterminateMainCommit = mainOnlyCommits.some((commit) => typeof commit.sha !== 'string' || !Array.isArray(commit.changedPaths))
  if (hasIndeterminateMainCommit) return {
    action: 'fail',
    reason: 'Unable to inspect main-only commit metadata.',
  }
  const hasIndeterminateStagingCommit = stagingOnlyCommits.some((commit) => typeof commit.sha !== 'string' || !Array.isArray(commit.changedPaths))
  if (hasIndeterminateStagingCommit) return {
    action: 'fail',
    reason: 'Unable to inspect staging-only commit metadata.',
  }
  if (Array.isArray(directChangedPaths)) {
    const paths = [...new Set(directChangedPaths.map((path) => path.trim()).filter(Boolean))]
    const unexpected = unexpectedReleasePaths(paths, allowed)
    // Git may hide patch-equivalent commits when divergentCommits uses
    // --cherry-pick. If the final trees are identical and no non-equivalent
    // commits remain, classify the branches consistently as aligned.
    if (!paths.length && !mainOnlyCommits.length && !stagingOnlyCommits.length) {
      return { action: 'aligned', targetSha: mainSha, reason: 'Branches have different history but identical content.' }
    }
    const stagingOnlyReleaseOnly = stagingOnlyCommits.length > 0 && stagingOnlyCommits.every((commit) =>
      Array.isArray(commit.changedPaths) && commit.changedPaths.length > 0 && unexpectedReleasePaths(commit.changedPaths, allowed).length === 0,
    )
    if (!unexpected.length && !stagingOnlyReleaseOnly) {
      return {
        action: 'fast-forward',
        targetSha: mainSha,
        reason: paths.length
          ? 'Branches differ only by approved release metadata.'
          : 'Branches have different history but identical content.',
      }
    }
    if (!stagingOnlyCommits.length) {
      return {
        action: 'fast-forward',
        targetSha: mainSha,
        reason: 'main contains validated changes that staging must inherit.',
      }
    }
  }
  // Historical main-only commits may list paths whose content is already
  // identical in the final staging tree (for example an equivalent workflow
  // change). When the final tree delta is available, such paths are not
  // genuine content differences and are ignored unless they also appear in
  // the direct tree delta; without directChangedPaths the strict historical
  // check is preserved unchanged.
  const directTreePaths = Array.isArray(directChangedPaths)
    ? new Set(directChangedPaths.map((path) => path.trim()).filter(Boolean))
    : null
  const unexpectedMain = unexpectedReleasePaths(
    [...new Set(mainOnlyCommits.flatMap((commit) => commit.changedPaths || []))],
    allowed,
  ).filter((path) => directTreePaths === null || directTreePaths.has(path))
  // Without a final-tree comparison, retain the historical fail-closed
  // behavior. When the final delta is known, main is the validated release
  // source of truth: replay any staging-only work on top instead of deadlocking
  // every later release because a hotfix landed directly on main.
  if (unexpectedMain.length && directTreePaths === null) {
    return {
      action: 'fail',
      reason: 'main contains commits that are not release metadata.',
      unexpected: unexpectedMain,
    }
  }
  if (stagingOnlyCommits.length) {
    return {
      action: 'rebase-staging',
      targetSha: mainSha,
      mainOnly: mainOnlyCommits.map((commit) => commit.sha).filter(Boolean),
      stagingOnly: stagingOnlyCommits.map((commit) => commit.sha).filter(Boolean),
      reason: 'staging contains unpromoted commits; replay them onto main.',
    }
  }
  if (mainOnlyCommits.length) return { action: 'fast-forward', targetSha: mainSha, reason: 'main only added approved release metadata.' }
  return { action: 'aligned', targetSha: mainSha, reason: 'Branches have different history but identical content.' }
}

export { DEFAULT_RELEASE_FILES }

/**
 * Deterministic head branch for the automated synchronization pull request
 * used when branch policy rejects the direct reconcile push. The branch is
 * namespaced under code-foundry/ so it never collides with release-please or
 * user branches, and the name is a pure function of the reconciled refs so
 * reruns converge on the same branch and PR.
 * @param {string} sourceBase
 * @param {string} targetHead
 */
export function reconciliationPullRequestBranch(sourceBase, targetHead) {
  return `code-foundry/reconcile/${sourceBase}-to-${targetHead}`
}

/** @param {{ targetHead: string, sourceBase: string }} input */
export function reconciliationPullRequestTitle({ targetHead, sourceBase }) {
  return `chore(${targetHead}): reconcile release metadata from ${sourceBase}`
}

/**
 * Deterministic pull request body for the automated synchronization PR. The
 * body explains that this is generated reconciliation and preserves the
 * fail-closed contract: unexpected divergence, conflicts, authentication
 * errors, and ambiguous state are never pushed around branch protection.
 * @param {{
 *   sourceBase: string,
 *   targetHead: string,
 *   mainSha: string,
 *   stagingSha: string,
 *   targetSha: string,
 *   action: string,
 *   pushError?: string,
 * }} input
 */
export function buildReconciliationPullRequestBody(input) {
  const { sourceBase, targetHead, mainSha, stagingSha, targetSha, action, pushError = '' } = input
  const lines = [
    '## Automated release reconciliation',
    '',
    `This pull request was generated by Code Foundry release reconciliation. The protected \`${targetHead}\` branch rejected the exact-lease synchronization push that carries release metadata published on \`${sourceBase}\` (branch policy, ruleset, or required pull request review), so this pull request delivers the exact target tip through the normal review flow instead.`,
    '',
    `- Base \`${targetHead}\`: \`${stagingSha}\``,
    `- \`${sourceBase}\` tip: \`${mainSha}\``,
    `- Target tip in this branch: \`${targetSha}\``,
    `- Synchronization: \`${action}\``,
  ]
  const reason = pushError.replace(/\s+/g, ' ').trim()
  if (reason) lines.push(`- Direct push rejection: \`${reason}\``)
  lines.push(
    '',
    `Merging this pull request synchronizes \`${targetHead}\` with the exact target tip above; no other commits are introduced.`,
    '',
    `Code Foundry treats validated \`${sourceBase}\` as the shipped source of truth and preserves unpromoted \`${targetHead}\` work by replaying it on top. Indeterminate history, replay conflicts, authentication failures, and ambiguous or stale state fail the release job closed and are never pushed around branch protection. Later releases retry the direct push first; when branch policy still rejects it, this pull request is updated instead of duplicated.`,
  )
  return lines.join('\n')
}

/**
 * Select the single reusable automated synchronization pull request from the
 * open pull requests that use the deterministic reconciliation branch. Reuse
 * requires the exact generated target base and title; foreign or ambiguous
 * state fails closed so a generated PR is never reused or overwritten by
 * accident. targetBase is the PR base branch (the protected branch being
 * synchronized, e.g. staging), branch is the generated head branch, and
 * title is the exact generated title.
 * @param {Array<{number?: number, title?: string, headRefName?: string, baseRefName?: string}>} prs
 * @param {{ targetBase: string, branch: string, title: string }} input
 * @returns {{ create: boolean, reuse?: {number?: number, title?: string, headRefName?: string, headRefOid?: string, baseRefName?: string, url?: string}, error?: string }}
 */
export function selectReconciliationPullRequest(prs, input) {
  const { targetBase, branch, title } = input
  const owned = prs.filter((pr) => String(pr.headRefName ?? '') === branch)
  if (!owned.length) return { create: true }
  const reusable = owned.filter((pr) => String(pr.baseRefName ?? '') === targetBase && String(pr.title ?? '') === title)
  if (reusable.length === 1) return { create: false, reuse: reusable[0] }
  if (reusable.length > 1) {
    return { create: false, error: `Multiple open pull requests use the reconciliation branch ${branch}; refusing to pick one.` }
  }
  const foreign = owned
    .map((pr) => `#${pr.number ?? '?'} (base ${pr.baseRefName ?? '?'}, title ${JSON.stringify(pr.title ?? '')})`)
    .join(', ')
  return {
    create: false,
    error: `Open pull request ${foreign} uses the reconciliation branch ${branch} with an unexpected base or title; refusing to reuse or overwrite it.`,
  }
}
