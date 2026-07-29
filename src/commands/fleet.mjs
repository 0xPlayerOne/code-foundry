// @ts-check

import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { syncRepository } from './sync.mjs'

/** @typedef {{ path: string, repository: string, runtimeRef: string, dirty: boolean, configured: boolean }} FleetRepository */

/** @param {string} root @returns {FleetRepository[]} */
export function discoverRepositories(root) {
  /** @type {FleetRepository[]} */
  const result = []
  const candidates = [root, ...children(root), ...children(join(root, 'NiftyLeague'))]
  for (const candidate of [...new Set(candidates)]) {
    if (!existsSync(join(candidate, '.git'))) continue
    const configured = existsSync(join(candidate, '.github/code-foundry.yml'))
    const config = readConfig(join(candidate, '.github/code-foundry.yml'))
    const remote = git(candidate, ['remote', 'get-url', 'origin'])
    result.push({
      path: candidate,
      repository: normalizeRemote(remote),
      runtimeRef: config.runtime_ref ?? '',
      dirty: Boolean(git(candidate, ['status', '--porcelain'])),
      configured,
    })
  }
  return result.sort((a, b) => a.path.localeCompare(b.path))
}

/** @param {string} root @param {string} source @param {{ createPr?: boolean, dryRun?: boolean, force?: boolean, version: string, exclude?: string[] }} options */
export function upgradeFleet(root, source, options) {
  const repositories = discoverRepositories(root)
  const report = []
  for (const repository of repositories) {
    if ((options.exclude ?? []).some((value) => repository.path === value || repository.repository === value || repository.path.endsWith(`/${value}`))) {
      report.push({ path: repository.path, status: 'skipped', reason: 'excluded by fleet policy' })
      continue
    }
    if (!repository.configured) {
      report.push({ path: repository.path, status: 'skipped', reason: 'missing .github/code-foundry.yml' })
      continue
    }
    if (repository.dirty && !options.force) {
      report.push({ path: repository.path, status: 'skipped', reason: 'working tree is dirty' })
      continue
    }
    if (!options.createPr || options.dryRun) {
      const result = syncRepository({ target: repository.path, source, dryRun: options.dryRun, force: false })
      report.push({ path: repository.path, status: options.dryRun ? 'preview' : 'synced', changed: result.changed })
      continue
    }
    if (!repository.repository) {
      report.push({ path: repository.path, status: 'skipped', reason: 'origin is not a GitHub remote' })
      continue
    }
    report.push(upgradeRepository(repository, source, options.version))
  }
  console.log(JSON.stringify(report, null, 2))
  return report
}

/** @param {FleetRepository} repository @param {string} source @param {string} version */
function upgradeRepository(repository, source, version) {
  const branch = `codex/code-foundry-upgrade-${version.replace(/^v/, '')}`
  const temporary = mkdtempSync(join(tmpdir(), 'code-foundry-fleet-'))
  try {
    const add = spawnSync('git', ['-C', repository.path, 'worktree', 'add', '-b', branch, temporary, 'HEAD'], { encoding: 'utf8' })
    if (add.status !== 0) return { path: repository.path, status: 'skipped', reason: add.stderr.trim() || 'unable to create isolated worktree' }
    const result = syncRepository({ target: temporary, source, force: false })
    if (!result.changed.length) return { path: repository.path, status: 'unchanged', branch }
    spawnSync('git', ['-C', temporary, 'add', '-A'], { stdio: 'ignore' })
    const commit = spawnSync('git', ['-C', temporary, 'commit', '-m', `chore(code-foundry): upgrade runtime to ${version}`], { encoding: 'utf8' })
    if (commit.status !== 0) return { path: repository.path, status: 'failed', reason: commit.stderr.trim() || 'commit failed' }
    const push = spawnSync('git', ['-C', temporary, 'push', '-u', 'origin', branch], { encoding: 'utf8' })
    if (push.status !== 0) return { path: repository.path, status: 'failed', reason: push.stderr.trim() || 'push failed' }
    const pr = spawnSync('gh', ['pr', 'create', '--repo', repository.repository, '--base', 'staging', '--head', branch, '--title', `chore(code-foundry): upgrade to ${version}`, '--body', `Automated isolated Code Foundry runtime upgrade to ${version}.\n\nThe sync preserved protected repository-owned documents and custom workflows.`], { encoding: 'utf8' })
    return pr.status === 0
      ? { path: repository.path, status: 'pr-created', branch, pullRequest: pr.stdout.trim() }
      : { path: repository.path, status: 'failed', branch, reason: pr.stderr.trim() || 'pull request creation failed' }
  } finally {
    spawnSync('git', ['-C', repository.path, 'worktree', 'remove', '--force', temporary], { stdio: 'ignore' })
  }
}

/** @param {string} root @returns {string[]} */
function children(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !['node_modules', 'target'].includes(entry.name))
      .map((entry) => join(root, entry.name))
  } catch { return [] }
}

/** @param {string} file @returns {Record<string, string>} */
function readConfig(file) {
  try {
    return Object.fromEntries(requireText(file).split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/)
      return match ? [[match[1], match[2].replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '')]] : []
    }))
  } catch { return {} }
}

/** @param {string} file */
function requireText(file) {
  return readFileSync(file, 'utf8')
}

/** @param {string} root @param {string[]} args */
function git(root, args) { return spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout?.trim() ?? '' }

/** @param {string} remote */
function normalizeRemote(remote) { return remote.replace(/^git@github\.com:/, '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '') }
