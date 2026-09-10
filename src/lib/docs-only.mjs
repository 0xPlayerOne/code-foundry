// @ts-check

import { execFileSync } from 'node:child_process'

/** Docs-only allowlist: markdown, docs/, and license roots. Code, lockfiles,
 * workflows, configuration, and packaging always keep the audit tier. */
const DOCS_ONLY_PATTERNS = [/\.md$/i, /^docs\//, /^LICENSE/i]

/** @param {string} path */
export function isDocsOnlyPath(path) {
  return DOCS_ONLY_PATTERNS.some((pattern) => pattern.test(path))
}

/**
 * Report whether a pull request changes docs only. Fail-closed: any git
 * failure, unresolvable base, or non-docs path keeps the audit tier.
 * @param {string} root
 * @param {string} baseRef
 */
export function docsOnlyPullRequest(root, baseRef) {
  try {
    execFileSync('git', ['fetch', '--no-tags', '--depth=100', 'origin', baseRef], {
      cwd: root,
      stdio: 'pipe',
    })
    const output = execFileSync('git', ['diff', '--name-only', 'FETCH_HEAD...HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const paths = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    return paths.length > 0 && paths.every(isDocsOnlyPath)
  } catch {
    return false
  }
}
