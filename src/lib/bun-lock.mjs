// @ts-check

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Release Please's Node updater bumps every workspace `package.json` but has no
 * updater for `bun.lock`, which records each workspace's version. A release
 * commit therefore leaves the lock naming the previous version of every
 * workspace. These helpers read and rewrite only those recorded versions; the
 * rest of the lock is never touched.
 */

const WORKSPACES_START = /^ {2}"workspaces": \{\s*$/
const WORKSPACES_END = /^ {2}\},?\s*$/
const ENTRY_START = /^ {4}"([^"]*)": \{\s*$/
const ENTRY_END = /^ {4}\},?\s*$/
const NAME_LINE = /^ {6}"name": "([^"]*)",?\s*$/
const VERSION_LINE = /^( {6}"version": ")([^"]*)(".*)$/

/**
 * @typedef {{ path: string, name: string, version: string, line: number }} LockedWorkspace
 */

/**
 * The workspace versions a `bun.lock` records, with the line each sits on.
 * Workspaces without a `version` line (the root, private packages without a
 * version) are not listed: bun omits the key when the manifest has none.
 * @param {string} text
 * @returns {LockedWorkspace[]}
 */
export function lockedWorkspaces(text) {
  const lines = text.split(/\r?\n/)
  /** @type {LockedWorkspace[]} */
  const found = []
  let inWorkspaces = false
  let entry = ''
  let name = ''
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!inWorkspaces) {
      if (WORKSPACES_START.test(line)) inWorkspaces = true
      continue
    }
    if (!entry) {
      if (WORKSPACES_END.test(line)) break
      const start = ENTRY_START.exec(line)
      if (start) {
        entry = start[1]
        name = ''
      }
      continue
    }
    if (ENTRY_END.test(line)) {
      entry = ''
      continue
    }
    const nameLine = NAME_LINE.exec(line)
    if (nameLine) {
      name = nameLine[1]
      continue
    }
    const versionLine = VERSION_LINE.exec(line)
    if (versionLine) found.push({ path: entry, name, version: versionLine[2], line: index })
  }
  return found
}

/**
 * @param {string} root
 * @param {string} workspacePath
 * @returns {string | undefined}
 */
function manifestVersion(root, workspacePath) {
  const file = join(root, workspacePath, 'package.json')
  if (!existsSync(file)) return undefined
  try {
    const version = JSON.parse(readFileSync(file, 'utf8')).version
    return typeof version === 'string' && version ? version : undefined
  } catch {
    return undefined
  }
}

/**
 * Locked workspace versions that differ from their manifest.
 * @param {string} root
 * @returns {Array<LockedWorkspace & { manifest: string }>}
 */
export function bunLockVersionDrift(root) {
  const lockPath = join(root, 'bun.lock')
  if (!existsSync(lockPath)) return []
  /** @type {Array<LockedWorkspace & { manifest: string }>} */
  const drift = []
  for (const workspace of lockedWorkspaces(readFileSync(lockPath, 'utf8'))) {
    const manifest = manifestVersion(root, workspace.path)
    if (manifest !== undefined && manifest !== workspace.version)
      drift.push({ ...workspace, manifest })
  }
  return drift
}

/**
 * Release-gate errors for a stale `bun.lock`.
 * @param {string} root
 * @returns {string[]}
 */
export function validateBunLockVersions(root) {
  const drift = bunLockVersionDrift(root)
  if (!drift.length) return []
  const shown = drift
    .slice(0, 3)
    .map(
      (entry) =>
        `${entry.path || '.'} (${entry.name || 'unnamed'}) is ${entry.version} in bun.lock but ${entry.manifest} in package.json`
    )
  const more = drift.length > shown.length ? ` (+${drift.length - shown.length} more)` : ''
  return [
    `bun.lock records ${drift.length} workspace version(s) that differ from package.json: ${shown.join('; ')}${more}. Run code-foundry release sync-lock.`,
  ]
}

/**
 * Rewrite stale workspace versions in `bun.lock` to match their manifests.
 * Only the `version` value of a drifted workspace changes.
 * @param {string} root
 * @param {{ dryRun?: boolean }} [options]
 * @returns {Array<{ path: string, name: string, from: string, to: string }>}
 */
export function syncBunLockWorkspaceVersions(root, options = {}) {
  const drift = bunLockVersionDrift(root)
  if (!drift.length) return []
  const lockPath = join(root, 'bun.lock')
  const text = readFileSync(lockPath, 'utf8')
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  for (const entry of drift) {
    const match = VERSION_LINE.exec(lines[entry.line])
    if (!match) continue
    lines[entry.line] = `${match[1]}${entry.manifest}${match[3]}`
  }
  if (!options.dryRun) writeFileSync(lockPath, lines.join(newline))
  return drift.map((entry) => ({
    path: entry.path,
    name: entry.name,
    from: entry.version,
    to: entry.manifest,
  }))
}
