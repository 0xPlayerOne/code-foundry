// @ts-check

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { readPackageVersion, syncRepository } from './sync.mjs'
import {
  discoverManifestRepositories,
  hasFleetManifest,
  upgradeManifestFleet,
} from '../lib/fleet-manifest.mjs'

/** @typedef {{ path: string, repository: string, runtimeRef: string, dirty: boolean, configured: boolean, gitWorkflow: string }} FleetRepository */

/** @param {string} root @returns {FleetRepository[]} */
export function discoverRepositories(root) {
  if (hasFleetManifest(root)) return discoverManifestRepositories(root)
  /** @type {FleetRepository[]} */
  const result = []
  const candidates = [root, ...children(root), ...children(join(root, 'NiftyLeague'))]
  for (const candidate of new Set(candidates)) {
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
      gitWorkflow: config.git_workflow ?? 'direct',
    })
  }
  return result.toSorted((a, b) => a.path.localeCompare(b.path))
}

/** @param {string} root @param {string} source @param {{ createPr?: boolean, dryRun?: boolean, force?: boolean, version: string, exclude?: string[] }} options */
export function upgradeFleet(root, source, options) {
  const sourceVersion = `v${readPackageVersion(source)}`
  const version = options.version ?? sourceVersion
  if (options.version && options.version !== sourceVersion) {
    throw new Error(
      `fleet upgrade target ${options.version} does not match the runtime source checkout (${sourceVersion}); refresh the code-foundry checkout to ${options.version} before upgrading so the rendered callers and the declared runtime agree.`
    )
  }
  if (hasFleetManifest(root))
    return upgradeManifestFleet(root, source, { ...options, version }, syncRepository)
  const repositories = discoverRepositories(root)
  const report = []
  for (const repository of repositories) {
    if (
      (options.exclude ?? []).some(
        (value) =>
          repository.path === value ||
          repository.repository === value ||
          repository.path.endsWith(`/${value}`)
      )
    ) {
      report.push({ path: repository.path, status: 'skipped', reason: 'excluded by fleet policy' })
      continue
    }
    if (!repository.configured) {
      report.push({
        path: repository.path,
        status: 'skipped',
        reason: 'missing .github/code-foundry.yml',
      })
      continue
    }
    if (repository.dirty && !options.force) {
      report.push({ path: repository.path, status: 'skipped', reason: 'working tree is dirty' })
      continue
    }
    if (!options.createPr || options.dryRun) {
      const result = syncRepository({
        target: repository.path,
        source,
        dryRun: options.dryRun,
        force: false,
      })
      report.push({
        path: repository.path,
        status: options.dryRun ? 'preview' : 'synced',
        changed: result.changed,
      })
      continue
    }
    if (!repository.repository) {
      report.push({
        path: repository.path,
        status: 'skipped',
        reason: 'origin is not a GitHub remote',
      })
      continue
    }
    report.push(upgradeRepository(repository, source, version))
  }
  console.log(JSON.stringify(report, null, 2))
  return report
}

/** @param {FleetRepository} repository @param {string} source @param {string} version */
function upgradeRepository(repository, source, version) {
  const branch = `codex/code-foundry-upgrade-${version.replace(/^v/, '')}`
  const base = repository.gitWorkflow === 'staging-release' ? 'staging' : 'main'
  const temporary = mkdtempSync(join(tmpdir(), 'code-foundry-fleet-'))
  let attached = false
  try {
    const fetch = spawnSync('git', ['-C', repository.path, 'fetch', 'origin', base, '--quiet'], {
      encoding: 'utf8',
    })
    if (fetch.status !== 0)
      return {
        path: repository.path,
        status: 'skipped',
        reason: fetch.stderr.trim() || `unable to refresh ${base} baseline`,
      }
    const marker = `<!-- code-foundry-legacy-rollout:${repository.repository}:${version}:${base} -->`
    const commitMarker = `Code-Foundry-Legacy-Rollout: ${repository.repository}:${version}:${base}`
    const remoteBranch = spawnSync(
      'git',
      ['-C', repository.path, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
      { encoding: 'utf8' }
    )
    if (remoteBranch.status !== 0)
      return {
        path: repository.path,
        status: 'failed',
        branch,
        reason: remoteBranch.stderr.trim() || 'unable to inspect existing upgrade branch',
      }
    const remote = remoteBranch.stdout.trim().split(/\s/)[0] ?? ''
    const local = spawnSync(
      'git',
      ['-C', repository.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      { encoding: 'utf8' }
    )
    if (local.status !== 0 && local.status !== 1)
      return {
        path: repository.path,
        status: 'failed',
        branch,
        reason: 'unable to inspect existing local upgrade branch',
      }
    const existing = remote || (local.status === 0 ? local.stdout.trim() : '')
    if (remote) {
      const branchFetch = spawnSync(
        'git',
        ['-C', repository.path, 'fetch', 'origin', branch, '--quiet'],
        { encoding: 'utf8' }
      )
      if (branchFetch.status !== 0)
        return {
          path: repository.path,
          status: 'failed',
          branch,
          reason: branchFetch.stderr.trim() || 'unable to fetch existing upgrade branch',
        }
    }
    const baseline = spawnSync('git', ['-C', repository.path, 'rev-parse', `origin/${base}`], {
      encoding: 'utf8',
    })
    if (baseline.status !== 0)
      return {
        path: repository.path,
        status: 'skipped',
        reason: `remote ${base} branch is unavailable`,
      }
    if (existing) {
      const message = spawnSync(
        'git',
        ['-C', repository.path, 'show', '-s', '--format=%B', existing],
        { encoding: 'utf8' }
      )
      const tree = spawnSync('git', ['-C', repository.path, 'rev-parse', `${existing}^{tree}`], {
        encoding: 'utf8',
      })
      const parent = spawnSync('git', ['-C', repository.path, 'rev-parse', `${existing}^`], {
        encoding: 'utf8',
      })
      const subject = message.stdout.split(/\r?\n/, 1)[0]
      const managed =
        message.status === 0 &&
        tree.status === 0 &&
        message.stdout.includes(commitMarker) &&
        message.stdout.includes(`Code-Foundry-Tree: ${tree.stdout.trim()}`)
      const legacyManaged =
        subject === `chore(code-foundry): upgrade runtime to ${version}` &&
        parent.status === 0 &&
        parent.stdout.trim() === baseline.stdout.trim()
      if (!managed && !legacyManaged)
        return {
          path: repository.path,
          status: 'failed',
          branch,
          reason: 'Existing upgrade branch is not a managed rollout; reconcile it manually',
        }
    }
    const add = spawnSync(
      'git',
      [
        '-C',
        repository.path,
        'worktree',
        'add',
        '--detach',
        temporary,
        existing || baseline.stdout.trim(),
      ],
      { encoding: 'utf8' }
    )
    if (add.status !== 0)
      return {
        path: repository.path,
        status: 'skipped',
        reason: add.stderr.trim() || 'unable to create isolated worktree',
      }
    attached = true
    let validatedHead = existing
    if (!existing) {
      const result = syncRepository({
        target: temporary,
        source,
        force: false,
        runtimeRef: version,
      })
      const configFile = join(temporary, '.github/code-foundry.yml')
      if (existsSync(configFile)) {
        const current = readFileSync(configFile, 'utf8')
        const updated = current.match(/^runtime_ref:\s*.*$/m)
          ? current.replace(/^runtime_ref:\s*.*$/m, `runtime_ref: ${version}`)
          : `${current.trimEnd()}\nruntime_ref: ${version}\n`
        if (updated !== current) {
          writeFileSync(configFile, updated)
          if (!result.changed.includes('.github/code-foundry.yml'))
            result.changed.push('.github/code-foundry.yml')
        }
      }
      if (!result.changed.length) return { path: repository.path, status: 'unchanged', branch }
      const stage = spawnSync('git', ['-C', temporary, 'add', '--', ...result.changed], {
        encoding: 'utf8',
      })
      if (stage.status !== 0)
        return {
          path: repository.path,
          status: 'failed',
          branch,
          reason: stage.stderr.trim() || 'unable to stage generated upgrade files',
        }
      const staged = spawnSync('git', ['-C', temporary, 'diff', '--cached', '--name-only'], {
        encoding: 'utf8',
      })
      if (staged.status !== 0 || !staged.stdout.trim())
        return { path: repository.path, status: 'unchanged', branch }
      const tree = spawnSync('git', ['-C', temporary, 'write-tree'], { encoding: 'utf8' })
      if (tree.status !== 0)
        return {
          path: repository.path,
          status: 'failed',
          branch,
          reason: tree.stderr.trim() || 'unable to record generated upgrade tree',
        }
      const commit = spawnSync(
        'git',
        [
          '-C',
          temporary,
          '-c',
          'core.hooksPath=.githooks',
          'commit',
          '-m',
          `chore(code-foundry): upgrade runtime to ${version}`,
          '-m',
          `${commitMarker}\nCode-Foundry-Tree: ${tree.stdout.trim()}`,
        ],
        { encoding: 'utf8' }
      )
      if (commit.status !== 0)
        return {
          path: repository.path,
          status: 'failed',
          branch,
          reason: commit.stderr.trim() || 'commit failed',
        }
      const committedTree = spawnSync('git', ['-C', temporary, 'rev-parse', 'HEAD^{tree}'], {
        encoding: 'utf8',
      })
      if (committedTree.status !== 0 || committedTree.stdout.trim() !== tree.stdout.trim())
        return {
          path: repository.path,
          status: 'failed',
          branch,
          reason: 'Commit hook changed the generated upgrade tree',
        }
      const sha = spawnSync('git', ['-C', temporary, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
      if (sha.status !== 0)
        return {
          path: repository.path,
          status: 'failed',
          branch,
          reason: 'unable to inspect generated upgrade commit',
        }
      const update = spawnSync(
        'git',
        [
          '-C',
          repository.path,
          'update-ref',
          `refs/heads/${branch}`,
          sha.stdout.trim(),
          '0'.repeat(40),
        ],
        { encoding: 'utf8' }
      )
      if (update.status !== 0)
        return {
          path: repository.path,
          status: 'failed',
          branch,
          reason: update.stderr.trim() || 'unable to retain generated upgrade commit',
        }
      validatedHead = sha.stdout.trim()
    }
    if (remote && remote !== validatedHead)
      return {
        path: repository.path,
        status: 'failed',
        branch,
        reason: 'Upgrade branch changed during validation; refusing to create a pull request',
      }
    if (!remote) {
      const push = spawnSync(
        'git',
        ['-C', temporary, 'push', '-u', 'origin', `HEAD:refs/heads/${branch}`],
        { encoding: 'utf8' }
      )
      if (push.status !== 0)
        return {
          path: repository.path,
          status: 'failed',
          branch,
          reason: push.stderr.trim() || 'push failed',
        }
      const pushed = spawnSync(
        'git',
        ['-C', repository.path, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
        { encoding: 'utf8' }
      )
      if (pushed.status !== 0 || pushed.stdout.trim().split(/\s/)[0] !== validatedHead)
        return {
          path: repository.path,
          status: 'failed',
          branch,
          reason: 'Upgrade branch did not retain the validated commit',
        }
    }
    const listed = spawnSync(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        repository.repository,
        '--head',
        branch,
        '--base',
        base,
        '--state',
        'all',
        '--limit',
        '100',
        '--json',
        'url,body,state,headRefName,headRefOid,baseRefName,isCrossRepository,isDraft',
      ],
      { encoding: 'utf8' }
    )
    if (listed.status !== 0)
      return {
        path: repository.path,
        status: 'failed',
        branch,
        reason: listed.stderr.trim() || 'unable to inspect upgrade pull requests',
      }
    let pullRequests
    try {
      pullRequests = JSON.parse(listed.stdout)
    } catch {
      return {
        path: repository.path,
        status: 'failed',
        branch,
        reason: 'invalid pull request list',
      }
    }
    if (!Array.isArray(pullRequests) || pullRequests.length > 1)
      return {
        path: repository.path,
        status: 'failed',
        branch,
        reason: 'Ambiguous upgrade pull requests',
      }
    const existingPr = pullRequests[0]
    if (existingPr) {
      if (
        !existingPr.body?.includes(marker) ||
        existingPr.headRefName !== branch ||
        existingPr.baseRefName !== base ||
        existingPr.headRefOid !== validatedHead ||
        existingPr.isCrossRepository !== false
      )
        return {
          path: repository.path,
          status: 'failed',
          branch,
          reason: 'Existing pull request does not match this rollout policy',
        }
      return {
        path: repository.path,
        status: 'pr-existing',
        branch,
        pullRequest: existingPr.url,
        draft: existingPr.isDraft,
      }
    }
    const pr = spawnSync(
      'gh',
      [
        'pr',
        'create',
        '--draft',
        '--repo',
        repository.repository,
        '--base',
        base,
        '--head',
        branch,
        '--title',
        `chore(code-foundry): upgrade to ${version}`,
        '--body',
        `${marker}\n\nAutomated isolated Code Foundry runtime upgrade to ${version}.\n\nThe sync preserved protected repository-owned documents and custom workflows.`,
      ],
      { encoding: 'utf8' }
    )
    if (pr.status !== 0)
      return {
        path: repository.path,
        status: 'failed',
        branch,
        reason: pr.stderr.trim() || 'pull request creation failed',
      }
    const created = spawnSync(
      'gh',
      [
        'pr',
        'view',
        pr.stdout.trim(),
        '--repo',
        repository.repository,
        '--json',
        'headRefOid,headRefName,baseRefName,isCrossRepository,isDraft',
      ],
      { encoding: 'utf8' }
    )
    if (created.status !== 0)
      return {
        path: repository.path,
        status: 'failed',
        branch,
        reason: created.stderr.trim() || 'unable to verify created pull request',
      }
    let createdPr
    try {
      createdPr = JSON.parse(created.stdout)
    } catch {
      return {
        path: repository.path,
        status: 'failed',
        branch,
        reason: 'invalid created pull request',
      }
    }
    if (
      createdPr.headRefOid !== validatedHead ||
      createdPr.headRefName !== branch ||
      createdPr.baseRefName !== base ||
      createdPr.isCrossRepository !== false ||
      createdPr.isDraft !== true
    )
      return {
        path: repository.path,
        status: 'failed',
        branch,
        reason: 'Created pull request does not reference the validated draft rollout branch',
      }
    return {
      path: repository.path,
      status: existing ? 'pr-resumed' : 'pr-created',
      branch,
      pullRequest: pr.stdout.trim(),
    }
  } finally {
    if (attached) {
      const cleanup = spawnSync(
        'git',
        ['-C', repository.path, 'worktree', 'remove', '--force', temporary],
        { encoding: 'utf8' }
      )
      if (cleanup.status !== 0)
        console.error(`Preserved isolated worktree after cleanup failure: ${temporary}`)
      else rmSync(temporary, { recursive: true, force: true })
    } else rmSync(temporary, { recursive: true, force: true })
  }
}

/** @param {string} root @returns {string[]} */
function children(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          !['node_modules', 'target'].includes(entry.name)
      )
      .map((entry) => join(root, entry.name))
  } catch {
    return []
  }
}

/** @param {string} file @returns {Record<string, string>} */
function readConfig(file) {
  try {
    return Object.fromEntries(
      requireText(file)
        .split(/\r?\n/)
        .flatMap((line) => {
          const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/)
          return match
            ? [[match[1], match[2].replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '')]]
            : []
        })
    )
  } catch {
    return {}
  }
}

/** @param {string} file */
function requireText(file) {
  return readFileSync(file, 'utf8')
}

/** @param {string} root @param {string[]} args */
function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout?.trim() ?? ''
}

/** @param {string} remote */
function normalizeRemote(remote) {
  return remote
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
}
