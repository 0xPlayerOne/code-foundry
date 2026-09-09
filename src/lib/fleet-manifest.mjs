// @ts-check

import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { listValue, readConfig } from './config.mjs'

/** @typedef {{repository: string, path: string, cohort: string, profile?: string, expected?: Record<string,string>, requiredCapabilities?: string[], validation: string[][], requiredChecks: string[], exception?: {reason: string, expires: string}}} FleetEntry */
/** @typedef {{schemaVersion: number, cohorts: string[], repositories: FleetEntry[]}} FleetManifest */
/** @typedef {{status: number|null, stdout: string, stderr: string}} CommandResult */
/** @typedef {(cwd: string, argv: string[]) => CommandResult} Runner */
/** @typedef {(options: {target: string, source: string, force: boolean, runtimeRef: string, configureHooks?: boolean}) => {changed: string[]}} Synchronize */

/** @type {Runner} */
export function executeFleetCommand(cwd, argv) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
  })
  if (result.error) throw result.error
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** @param {string} root */
export function hasFleetManifest(root) {
  return existsSync(join(root, 'code-foundry-fleet.json'))
}

/** @param {unknown} value @param {string} label @returns {string[]} */
function strings(value, label) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((item) => typeof item !== 'string' || !item.trim() || item.includes('\0'))
  )
    throw new Error(`${label} must be a non-empty string array`)
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`)
  return value
}

/** @param {string} root @param {string} path */
export function fleetPath(root, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path))
    throw new Error('Fleet paths must be relative to the manifest root')
  const base = realpathSync(root)
  const target = resolve(base, path)
  const rel = relative(base, target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`))
    throw new Error('Fleet repository path escapes or equals the root')
  let current = base
  for (const part of rel.split(sep)) {
    current = join(current, part)
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error('Fleet repository paths must not contain symlinks')
  }
  return target
}

/** @param {string} root @param {Date} [now] @returns {FleetManifest} */
export function readFleetManifest(root, now = new Date()) {
  const value = JSON.parse(readFileSync(join(root, 'code-foundry-fleet.json'), 'utf8'))
  if (value?.schemaVersion !== 1) throw new Error('Unsupported fleet manifest schema')
  const cohorts = strings(value.cohorts, 'cohorts')
  if (!Array.isArray(value.repositories) || !value.repositories.length)
    throw new Error('Fleet repositories must be a non-empty array')
  const repositories = new Set()
  const paths = new Set()
  for (const entry of value.repositories) {
    if (!entry || !/^[\w.-]+\/[\w.-]+$/.test(entry.repository ?? ''))
      throw new Error('Invalid fleet repository name')
    const path = fleetPath(root, entry.path)
    if (repositories.has(entry.repository.toLowerCase()) || paths.has(path))
      throw new Error('Duplicate fleet repository or path')
    repositories.add(entry.repository.toLowerCase())
    paths.add(path)
    if (!cohorts.includes(entry.cohort)) throw new Error(`Unknown cohort for ${entry.repository}`)
    if (entry.profile !== undefined && (typeof entry.profile !== 'string' || !entry.profile.trim()))
      throw new Error('profile must be a non-empty annotation')
    if (
      entry.expected !== undefined &&
      (!entry.expected ||
        Array.isArray(entry.expected) ||
        typeof entry.expected !== 'object' ||
        Object.values(entry.expected).some((item) => typeof item !== 'string'))
    )
      throw new Error('expected must map Code Foundry config keys to scalar strings')
    if (entry.requiredCapabilities !== undefined)
      strings(entry.requiredCapabilities, 'requiredCapabilities')
    if (!Array.isArray(entry.validation) || !entry.validation.length)
      throw new Error('Every repository requires explicit validation argv commands')
    for (const argv of entry.validation) {
      if (
        !Array.isArray(argv) ||
        !argv.length ||
        argv.some((arg) => typeof arg !== 'string' || !arg.length || arg.includes('\0'))
      )
        throw new Error('Validation commands must be non-empty argv arrays')
    }
    entry.requiredChecks = strings(entry.requiredChecks ?? ['Validation / Gate'], 'requiredChecks')
    if (entry.exception) {
      if (
        typeof entry.exception.reason !== 'string' ||
        !entry.exception.reason.trim() ||
        !/^\d{4}-\d{2}-\d{2}$/.test(entry.exception.expires ?? '')
      )
        throw new Error('Fleet exceptions require a reason and YYYY-MM-DD expiry')
      const expiry = new Date(`${entry.exception.expires}T23:59:59.999Z`)
      if (
        !Number.isFinite(expiry.getTime()) ||
        expiry.toISOString().slice(0, 10) !== entry.exception.expires ||
        expiry < now
      )
        throw new Error(`Expired or invalid exception for ${entry.repository}`)
    }
  }
  if (
    cohorts.some(
      (cohort) =>
        !value.repositories.some((/** @type {FleetEntry} */ entry) => entry.cohort === cohort)
    )
  )
    throw new Error('Every cohort must contain a repository')
  return { schemaVersion: 1, cohorts, repositories: value.repositories }
}

/** @param {string} remote */
export function githubRemote(remote) {
  return (
    remote
      .trim()
      .match(/^(?:git@github\.com:|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1] ??
    ''
  )
}

/** @param {Runner} run @param {string} cwd @param {string[]} argv */
function checked(run, cwd, argv) {
  const result = run(cwd, argv)
  if (result.status !== 0)
    throw new Error(`${argv[0]} ${argv[1] ?? ''} failed (${result.status ?? 'signal'})`)
  return result.stdout.trim()
}

/** @param {Runner} run @param {string} path @param {string} branch */
function remoteBranchHead(run, path, branch) {
  const output = checked(run, path, [
    'git',
    'ls-remote',
    '--heads',
    'origin',
    `refs/heads/${branch}`,
  ])
  return output.split(/\s/)[0] ?? ''
}

/** @param {Record<string,string>} config @param {FleetEntry} entry */
export function configDrift(config, entry) {
  const drift = Object.entries(entry.expected ?? {}).flatMap(([key, expected]) =>
    config[key] === expected ? [] : [{ key, expected, observed: config[key] ?? null }]
  )
  const observed = listValue(config.required_capabilities ?? '')
  for (const capability of entry.requiredCapabilities ?? []) {
    if (!observed.includes(capability))
      drift.push({
        key: `required_capabilities:${capability}`,
        expected: 'declared',
        observed: 'missing',
      })
  }
  return drift
}

/** @param {string} path */
function canonicalPath(path) {
  try {
    return realpathSync(path)
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path))
    } catch {
      return resolve(path)
    }
  }
}

/** @param {FleetEntry} entry @param {{path: string}|undefined} item @param {string[]} excluded */
function isExcluded(entry, item, excluded) {
  return excluded.some(
    (name) =>
      name === entry.repository ||
      name === entry.path ||
      (isAbsolute(name) && canonicalPath(name) === item?.path)
  )
}

/** @param {string} root @param {Runner} [run] */
export function discoverManifestRepositories(root, run = executeFleetCommand) {
  return readFleetManifest(root).repositories.map((entry) => {
    const path = fleetPath(root, entry.path)
    const configured = existsSync(join(path, '.github/code-foundry.yml'))
    const config = configured ? readConfig(join(path, '.github/code-foundry.yml')) : {}
    const git = existsSync(join(path, '.git'))
    let remote = ''
    let dirty = false
    let error = ''
    try {
      if (git) {
        remote = githubRemote(checked(run, path, ['git', 'remote', 'get-url', 'origin']))
        dirty = Boolean(checked(run, path, ['git', 'status', '--porcelain']))
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
    }
    return {
      path,
      repository: entry.repository,
      runtimeRef: config.runtime_ref ?? '',
      configured,
      dirty,
      gitWorkflow: config.git_workflow ?? 'direct',
      cohort: entry.cohort,
      profile: entry.profile ?? null,
      remote,
      drift: configDrift(config, entry),
      exception: entry.exception ?? null,
      status: entry.exception
        ? 'excepted'
        : error || !git || !configured || remote.toLowerCase() !== entry.repository.toLowerCase()
          ? 'blocked'
          : 'discovered',
      reason:
        error ||
        (!git
          ? 'missing checkout'
          : !configured
            ? 'missing configuration'
            : remote.toLowerCase() !== entry.repository.toLowerCase()
              ? 'origin does not match inventory'
              : dirty
                ? 'working tree is dirty'
                : ''),
    }
  })
}

/** @param {FleetEntry} entry @param {string} version @param {string} base */
export function rolloutIdentity(entry, version, base) {
  const id = createHash('sha256').update(JSON.stringify({ entry, version, base })).digest('hex')
  return {
    id,
    branch: `codex/code-foundry-upgrade-${version.replace(/^v/, '')}-${id.slice(0, 10)}`,
    marker: `<!-- code-foundry-rollout:${id} -->`,
  }
}

/** @param {any} pr @param {string[]} required */
export function verifiedPullRequest(pr, required) {
  if (
    pr?.state !== 'MERGED' ||
    pr.isCrossRepository !== false ||
    !/^[0-9a-f]{40}$/i.test(pr.headRefOid ?? '')
  )
    return false
  const checks = pr.statusCheckRollup
  if (!Array.isArray(checks) || !checks.length) return false
  /** @param {any} check */
  const state = (check) =>
    check.status === 'COMPLETED' ? check.conclusion : (check.state ?? check.status)
  if (checks.some((check) => !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(state(check))))
    return false
  return required.every((name) =>
    checks.some((check) => (check.name ?? check.context) === name && state(check) === 'SUCCESS')
  )
}

/** @param {string} text */
function scalarConfig(text) {
  return Object.fromEntries(
    text.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/)
      return match ? [[match[1], match[2].replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '')]] : []
    })
  )
}

/** @param {Runner} run @param {string} path @param {FleetEntry} entry @param {string} version @param {string} base */
function inspectRollout(run, path, entry, version, base) {
  const identity = rolloutIdentity(entry, version, base)
  const prs = JSON.parse(
    checked(run, path, [
      'gh',
      'pr',
      'list',
      '--repo',
      entry.repository,
      '--head',
      identity.branch,
      '--base',
      base,
      '--state',
      'all',
      '--limit',
      '100',
      '--json',
      'number,url,body,state,headRefName,headRefOid,baseRefName,isCrossRepository,isDraft,statusCheckRollup',
    ])
  )
  if (!Array.isArray(prs) || prs.length > 1)
    throw new Error('Ambiguous upgrade pull requests; reconcile them manually')
  const pr = prs[0]
  if (
    pr &&
    (!pr.body?.includes(identity.marker) ||
      pr.isCrossRepository !== false ||
      pr.headRefName !== identity.branch ||
      pr.baseRefName !== base)
  )
    throw new Error('Existing pull request does not match this rollout policy')
  if (pr?.state === 'OPEN') {
    const remoteHead = remoteBranchHead(run, path, identity.branch)
    if (!remoteHead || pr.headRefOid !== remoteHead)
      throw new Error('Existing pull request head no longer matches its remote branch')
  }
  let complete = verifiedPullRequest(pr, entry.requiredChecks)
  if (complete) {
    const response = JSON.parse(
      checked(run, path, [
        'gh',
        'api',
        `repos/${entry.repository}/contents/.github/code-foundry.yml?ref=${encodeURIComponent(base)}`,
      ])
    )
    if (response.encoding !== 'base64' || typeof response.content !== 'string')
      throw new Error('Unable to verify merged runtime configuration')
    const config = scalarConfig(Buffer.from(response.content, 'base64').toString('utf8'))
    complete = config.runtime_ref === version && configDrift(config, entry).length === 0
  }
  return { ...identity, pr, complete }
}

/** @param {Runner} run @param {string} path @param {string[]} files */
function candidateFingerprint(run, path, files) {
  // A validation command can commit its changes and leave an empty diff. Bind the
  // fingerprint to HEAD as well so resumed candidates cannot publish that commit.
  const hash = createHash('sha256')
    .update(checked(run, path, ['git', 'rev-parse', '--verify', 'HEAD']))
    .update('\0')
    .update(checked(run, path, ['git', 'diff', '--binary', 'HEAD']))
  // Sorting a copy preserves the caller's tracked file order.
  // oxlint-disable-next-line unicorn/no-array-sort
  for (const file of [...files].sort()) {
    const target = join(path, file)
    hash.update(file).update(existsSync(target) ? readFileSync(target) : '<deleted>')
  }
  return hash.digest('hex')
}

/** @param {Runner} run @param {string} worktree @param {FleetEntry} entry @param {string[]} files */
function validateCandidate(run, worktree, entry, files) {
  const before = candidateFingerprint(run, worktree, files)
  const commands = []
  for (const argv of entry.validation) {
    const result = run(worktree, argv)
    commands.push({ argv, status: result.status })
    if (result.status !== 0)
      throw new Error(
        `Consumer validation failed: ${argv[0]} ${argv[1] ?? ''} (${result.status ?? 'signal'})`
      )
  }
  if (candidateFingerprint(run, worktree, files) !== before)
    throw new Error('Validation modified the candidate source; use read-only check commands')
  return commands
}

/** @param {Runner} run @param {Synchronize} sync @param {string} path @param {string} source @param {FleetEntry} entry @param {string} version @param {string} base @param {ReturnType<typeof rolloutIdentity>} identity */
function upgradeCandidate(run, sync, path, source, entry, version, base, identity) {
  const temporary = mkdtempSync(join(tmpdir(), 'foundry-rollout-'))
  const worktree = join(temporary, 'repo')
  let attached = false
  try {
    checked(run, path, ['git', 'fetch', 'origin', base, '--quiet'])
    const remote = remoteBranchHead(run, path, identity.branch)
    const local = run(path, [
      'git',
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${identity.branch}`,
    ])
    if (local.status !== 0 && local.status !== 1)
      throw new Error('Unable to inspect existing local upgrade branch')
    const existing = remote || (local.status === 0 ? local.stdout.trim() : '')
    const baseline = checked(run, path, ['git', 'rev-parse', `origin/${base}`])
    if (remote) checked(run, path, ['git', 'fetch', 'origin', identity.branch, '--quiet'])
    if (existing) {
      const message = checked(run, path, ['git', 'show', '-s', '--format=%B', existing])
      const tree = checked(run, path, ['git', 'rev-parse', `${existing}^{tree}`])
      if (
        !message.includes(`Code-Foundry-Rollout: ${identity.id}`) ||
        !message.includes(`Code-Foundry-Tree: ${tree}`)
      )
        throw new Error(
          'Existing branch does not match its recorded rollout/tree identity; refusing to overwrite it'
        )
    }
    checked(run, path, ['git', 'worktree', 'add', '--detach', worktree, existing || baseline])
    attached = true
    /** @type {string[]} */
    let changed = []
    let validatedHead = existing
    if (!existing) {
      changed = sync({
        target: worktree,
        source,
        force: false,
        runtimeRef: version,
        configureHooks: false,
      }).changed
      const hook = join(worktree, '.githooks/pre-commit')
      if (existsSync(hook)) chmodSync(hook, 0o755)
      const file = join(worktree, '.github/code-foundry.yml')
      const text = readFileSync(file, 'utf8')
      const updated = /^runtime_ref:.*$/m.test(text)
        ? text.replace(/^runtime_ref:.*$/m, `runtime_ref: ${version}`)
        : `${text.trimEnd()}\nruntime_ref: ${version}\n`
      if (text !== updated) {
        writeFileSync(file, updated)
        changed.push('.github/code-foundry.yml')
      }
    }
    changed = [...new Set(changed)]
    for (const file of changed) {
      const rel = relative(worktree, resolve(worktree, file))
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(file))
        throw new Error('Sync returned a path outside the isolated worktree')
    }
    const config = readConfig(join(worktree, '.github/code-foundry.yml'))
    if (config.runtime_ref !== version || configDrift(config, entry).length)
      throw new Error('Candidate configuration does not match the declared fleet policy')
    const validation = validateCandidate(run, worktree, entry, changed)
    if (!existing) {
      if (!changed.length)
        return {
          status: 'unchanged',
          validation,
          reason: 'No upgrade diff; no managed PR evidence exists to unlock later cohorts',
        }
      checked(run, worktree, ['git', 'add', '--', ...changed])
      if (!checked(run, worktree, ['git', 'diff', '--cached', '--name-only']))
        return { status: 'unchanged', validation }
      const tree = checked(run, worktree, ['git', 'write-tree'])
      checked(run, worktree, [
        'git',
        '-c',
        'core.hooksPath=.githooks',
        'commit',
        '-m',
        `chore(code-foundry): upgrade runtime to ${version}`,
        '-m',
        `Code-Foundry-Rollout: ${identity.id}\nCode-Foundry-Tree: ${tree}`,
      ])
      if (checked(run, worktree, ['git', 'rev-parse', 'HEAD^{tree}']) !== tree)
        throw new Error('Commit hooks changed the validated tree; refusing to publish it')
      const sha = checked(run, worktree, ['git', 'rev-parse', 'HEAD'])
      checked(run, path, [
        'git',
        'update-ref',
        `refs/heads/${identity.branch}`,
        sha,
        '0'.repeat(40),
      ])
      validatedHead = sha
    } else {
      validatedHead = checked(run, worktree, ['git', 'rev-parse', 'HEAD'])
    }
    if (remote && remoteBranchHead(run, path, identity.branch) !== validatedHead)
      throw new Error('Upgrade branch changed during validation; refusing to create a pull request')
    if (!remote) {
      checked(run, worktree, ['git', 'push', 'origin', `HEAD:refs/heads/${identity.branch}`])
      if (remoteBranchHead(run, path, identity.branch) !== validatedHead)
        throw new Error('Upgrade branch did not retain the validated commit')
    }
    const body = `${identity.marker}\n\nIsolated Code Foundry upgrade to ${version}.\n\nLocal consumer validation passed (${validation.length} commands). Review the declared policy and run the required GitHub checks before marking ready. No automated readiness or merge is requested.`
    const pullRequest = checked(run, path, [
      'gh',
      'pr',
      'create',
      '--repo',
      entry.repository,
      '--head',
      identity.branch,
      '--base',
      base,
      '--draft',
      '--title',
      `chore(code-foundry): upgrade to ${version}`,
      '--body',
      body,
    ])
    const created = JSON.parse(
      checked(run, path, [
        'gh',
        'pr',
        'view',
        pullRequest,
        '--repo',
        entry.repository,
        '--json',
        'headRefOid,headRefName,baseRefName,isCrossRepository',
      ])
    )
    if (
      created.headRefOid !== validatedHead ||
      created.headRefName !== identity.branch ||
      created.baseRefName !== base ||
      created.isCrossRepository !== false
    )
      throw new Error('Created pull request does not reference the validated rollout branch')
    return {
      status: existing ? 'pr-resumed' : 'pr-created',
      branch: identity.branch,
      pullRequest,
      validation,
    }
  } finally {
    if (attached) {
      const cleanup = run(path, ['git', 'worktree', 'remove', '--force', worktree])
      if (cleanup.status !== 0)
        console.error(`Preserved isolated worktree after cleanup failure: ${worktree}`)
      else rmSync(temporary, { recursive: true, force: true })
    } else rmSync(temporary, { recursive: true, force: true })
  }
}

/**
 * The first incomplete cohort is the only cohort allowed to create PRs. Earlier
 * cohorts must have merged managed PRs, successful required checks, and matching
 * current base-branch configuration. Unknown/failed state never unlocks rollout.
 * @param {string} root @param {string} source
 * @param {{createPr?: boolean, dryRun?: boolean, force?: boolean, version: string, exclude?: string[]}} options
 * @param {Synchronize} sync @param {Runner} [run]
 */
export function upgradeManifestFleet(root, source, options, sync, run = executeFleetCommand) {
  if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(options.version))
    throw new Error('Fleet target must be an exact version')
  if (!options.dryRun && !options.createPr)
    throw new Error(
      'Manifest rollouts require --create-pr or --dry-run; in-place fleet mutation is disabled'
    )
  const manifest = readFleetManifest(root)
  const inventory = discoverManifestRepositories(root, run)
  /** @type {any[]} */
  const report = []
  let active = false
  let stopped = false
  for (const cohort of manifest.cohorts) {
    const entries = manifest.repositories.filter((entry) => entry.cohort === cohort)
    let completed = 0
    for (const entry of entries) {
      const item = inventory.find((repo) => repo.repository === entry.repository)
      if (!item) throw new Error('Inventory changed during rollout')
      const record = { repository: entry.repository, cohort, path: item.path }
      const excluded = isExcluded(entry, item, options.exclude ?? [])
      if (entry.exception || excluded) {
        report.push({
          ...record,
          status: 'excepted',
          reason: entry.exception?.reason ?? 'excluded by command',
        })
        continue
      }
      if (stopped || active) {
        report.push({ ...record, status: 'blocked', reason: 'earlier cohort is incomplete' })
        continue
      }
      if (item.status === 'blocked' || item.dirty) {
        report.push({ ...record, status: 'failed', reason: item.reason || 'invalid inventory' })
        stopped = true
        continue
      }
      if (options.dryRun) {
        report.push({ ...record, status: 'preview', version: options.version, drift: item.drift })
        continue
      }
      try {
        const base = item.gitWorkflow === 'staging-release' ? 'staging' : 'main'
        const rollout = inspectRollout(run, item.path, entry, options.version, base)
        if (rollout.complete) {
          completed += 1
          report.push({ ...record, status: 'verified-merged', pullRequest: rollout.pr.url })
          continue
        }
        if (rollout.pr) {
          if (rollout.pr.state !== 'OPEN')
            throw new Error(
              'Existing rollout PR closed or merged without valid gate/configuration evidence'
            )
          report.push({
            ...record,
            status: 'pr-existing',
            pullRequest: rollout.pr.url,
            draft: rollout.pr.isDraft,
          })
          continue
        }
        report.push({
          ...record,
          ...upgradeCandidate(run, sync, item.path, source, entry, options.version, base, rollout),
        })
      } catch (error) {
        report.push({
          ...record,
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        })
        stopped = true
      }
    }
    const expected = entries.filter((entry) => {
      const item = inventory.find((repo) => repo.repository === entry.repository)
      return !entry.exception && !isExcluded(entry, item, options.exclude ?? [])
    }).length
    if (!options.dryRun && (completed !== expected || expected === 0)) active = true
  }
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        version: options.version,
        status: stopped ? 'failed' : options.dryRun ? 'preview' : active ? 'pending' : 'complete',
        repositories: report,
      },
      null,
      2
    )
  )
  if (stopped) process.exitCode = 1
  return report
}
