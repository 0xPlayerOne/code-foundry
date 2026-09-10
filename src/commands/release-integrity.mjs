#!/usr/bin/env node
// @ts-check

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** @typedef {(argv: string[]) => {status: number|null, stdout: string}} Runner */

/** @type {Runner} */
export function runGh(argv) {
  const result = spawnSync('gh', argv, {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com' },
  })
  if (result.error) throw new Error(`GitHub CLI unavailable: ${result.error.name}`)
  return { status: result.status, stdout: result.stdout ?? '' }
}

/** @param {string} repository */
function validateRepository(repository) {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    repository.split('/').some((part) => ['.', '..'].includes(part))
  )
    throw new Error('repository must be an owner/name on github.com')
}

/** @param {string} tag */
function validateTag(tag) {
  const hasInvalidCharacter = tag
    ? [...tag].some((character) => {
        const codePoint = character.codePointAt(0)
        return (
          (codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f)) ||
          '~^:?*[\\'.includes(character)
        )
      })
    : false
  if (
    !tag ||
    tag.startsWith('-') ||
    hasInvalidCharacter ||
    tag.includes('..') ||
    tag.includes('@{')
  )
    throw new Error('Invalid release tag')
}

/** @param {Runner} run @param {string[]} argv */
function json(run, argv) {
  const result = run(argv)
  if (result.status !== 0)
    throw new Error(
      `GitHub verification command failed (${result.status ?? 'signal'}); state is unverified`
    )
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error('GitHub verification returned invalid JSON; state is unverified')
  }
}

/** @param {Runner} run @param {string} endpoint */
function api(run, endpoint) {
  return json(run, ['api', '--hostname', 'github.com', endpoint])
}

/** Read only. A permissions failure is unknown, never evidence of disabled settings.
 * @param {string} repository @param {Runner} [run]
 */
export function verifyImmutableSetting(repository, run = runGh) {
  validateRepository(repository)
  const result = api(run, `repos/${repository}/immutable-releases`)
  if (result?.enabled !== true) throw new Error('Release immutability is not confirmed enabled')
  return {
    schemaVersion: 1,
    kind: 'code-foundry-release-integrity',
    status: 'passed',
    repository,
    check: 'immutable-setting',
    enforcedByOwner: result.enforced_by_owner === true,
  }
}

/** @param {string} root @param {string} file */
export function assetDigest(root, file) {
  if (!file || isAbsolute(file)) throw new Error('Asset paths must be repository-relative')
  const base = realpathSync(root)
  const path = resolve(base, file)
  const rel = relative(base, path)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`))
    throw new Error('Asset path escapes repository')
  let current = base
  for (const part of rel.split(sep)) {
    current = resolve(current, part)
    if (lstatSync(current).isSymbolicLink()) throw new Error('Release assets must not be symlinks')
  }
  if (!lstatSync(path).isFile()) throw new Error('Release asset must be a regular file')
  const content = readFileSync(path)
  if (!content.length) throw new Error('Release asset is empty')
  return {
    file: rel.split(sep).join('/'),
    name: basename(path),
    bytes: content.length,
    digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    path,
  }
}

/** @param {string} root @param {string[]} files */
export function assetManifest(root, files) {
  if (!files.length) throw new Error('At least one artifact is required')
  const assets = files.map((file) => assetDigest(root, file))
  if (new Set(assets.map((asset) => asset.file)).size !== assets.length)
    throw new Error('Duplicate artifact')
  if (assets.some((asset) => /[\r\n\\]/.test(asset.file)))
    throw new Error('Unsupported checksum filename')
  return {
    schemaVersion: 1,
    kind: 'code-foundry-asset-manifest',
    assets: assets.map(({ path: _path, ...asset }) => asset),
    checksums: assets.map((asset) => `${asset.digest.slice(7)}  ${asset.file}\n`).join(''),
  }
}

/** @param {Runner} run @param {string} repository @param {string} tag */
function tagCommit(run, repository, tag) {
  let object = api(run, `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`).object
  for (let depth = 0; object?.type === 'tag' && depth < 8; depth += 1) {
    if (!/^[0-9a-f]{40}$/i.test(object.sha ?? '')) throw new Error('Malformed annotated tag')
    object = api(run, `repos/${repository}/git/tags/${object.sha}`).object
  }
  if (object?.type !== 'commit' || !/^[0-9a-f]{40}$/i.test(object.sha ?? ''))
    throw new Error('Release tag does not resolve to a commit')
  return object.sha
}

/** Resolve a release tag without requiring the release itself to be published.
 * @param {string} repository @param {string} tag @param {Runner} [run]
 */
export function resolveTagCommit(repository, tag, run = runGh) {
  validateRepository(repository)
  validateTag(tag)
  return tagCommit(run, repository, tag)
}

/** GitHub CLI performs signature/attestation verification, not merely a metadata check.
 * @param {{repository: string, tag: string, root?: string, assets?: string[], expectedSha?: string}} options
 * @param {Runner} [run]
 */
export function verifyRelease(options, run = runGh) {
  const { repository, tag } = options
  validateRepository(repository)
  validateTag(tag)
  if (options.expectedSha && !/^[0-9a-f]{40}$/i.test(options.expectedSha))
    throw new Error('expected-sha must be a full commit SHA')
  const release = api(run, `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`)
  if (release?.immutable !== true || release.draft !== false || release.tag_name !== tag)
    throw new Error('Expected a published immutable release with the exact requested tag')
  json(run, ['release', 'verify', tag, '--repo', repository, '--format', 'json'])
  const sourceSha = tagCommit(run, repository, tag)
  if (options.expectedSha && options.expectedSha.toLowerCase() !== sourceSha.toLowerCase())
    throw new Error('Release tag does not match the expected source SHA')
  const assets = []
  for (const file of options.assets ?? []) {
    const asset = assetDigest(options.root ?? process.cwd(), file)
    json(run, [
      'release',
      'verify-asset',
      tag,
      asset.path,
      '--repo',
      repository,
      '--format',
      'json',
    ])
    // Rehash after signature verification so a replaced local file is not reported verified.
    if (assetDigest(options.root ?? process.cwd(), file).digest !== asset.digest)
      throw new Error('Local release asset changed during verification')
    assets.push({ file: asset.file, bytes: asset.bytes, digest: asset.digest, status: 'verified' })
  }
  return {
    schemaVersion: 1,
    kind: 'code-foundry-release-integrity',
    status: 'passed',
    check: 'release-attestation',
    repository,
    tag,
    sourceSha,
    immutable: true,
    assets,
  }
}

/** Sync pause used by the post-publication verifier while the release index
 * catches up with a just-published release.
 * @param {number} ms
 */
function sleepSync(ms) {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const RELEASE_VERIFICATION_ATTEMPTS = 3

/** @param {string[]} argv @param {Runner} [run] */
export function integrityCommand(argv, run = runGh) {
  const [command, ...args] = argv
  /** @type {Record<string, string>} */
  const values = {}
  const assets = []
  while (args.length) {
    const key = args.shift()
    if (!key || !['--repo', '--tag', '--root', '--asset', '--expected-sha'].includes(key))
      throw new Error(`Unknown argument: ${key}`)
    const value = args.shift()
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`)
    if (key === '--asset') assets.push(value)
    else {
      if (Object.hasOwn(values, key)) throw new Error(`Duplicate ${key}`)
      values[key] = value
    }
  }
  const allowed =
    command === 'settings'
      ? ['--repo']
      : command === 'manifest'
        ? ['--root']
        : ['--repo', '--tag', '--root', '--expected-sha']
  if (
    Object.keys(values).some((key) => !allowed.includes(key)) ||
    (command === 'settings' && assets.length)
  )
    throw new Error('An argument is not supported by this integrity command')
  if (command === 'settings') return verifyImmutableSetting(values['--repo'] ?? '', run)
  if (command === 'manifest') return assetManifest(values['--root'] ?? process.cwd(), assets)
  if (command === 'release') {
    const options = {
      repository: values['--repo'] ?? '',
      tag: values['--tag'] ?? '',
      root: values['--root'],
      expectedSha: values['--expected-sha'],
      assets,
    }
    // The lane fires the instant GitHub marks the release published, while the
    // releases-by-tag index can still lag behind. Retry through that window;
    // every strict check still runs on every attempt and the command fails
    // closed once the bounded window is exhausted.
    let lastError
    for (let attempt = 1; attempt <= RELEASE_VERIFICATION_ATTEMPTS; attempt += 1) {
      try {
        return verifyRelease(options, run)
      } catch (error) {
        lastError = error
        if (attempt < RELEASE_VERIFICATION_ATTEMPTS) sleepSync(2_000)
      }
    }
    throw lastError
  }
  throw new Error('Use release-integrity settings, release, or manifest')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    console.log(JSON.stringify(integrityCommand(process.argv.slice(2)), null, 2))
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          kind: 'code-foundry-release-integrity',
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        },
        null,
        2
      )
    )
    process.exitCode = 1
  }
}
