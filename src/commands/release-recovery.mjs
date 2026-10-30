// @ts-check

import { appendFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolveTagCommit, runGh } from './release-integrity.mjs'

/**
 * Validate the bounded target for a manual retry of a failed npm publication.
 * The caller must still qualify the immutable release archive on every
 * required Node version and publish only through qualified-publication.mjs.
 *
 * @param {{tag:string, version:string, release:unknown, sourceSha:string, currentSha:string, sourceIsAncestor:boolean}} input
 */
export function validateRecoveryTarget(input) {
  const { tag, version, release, sourceSha, currentSha, sourceIsAncestor } = input
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('Only the current stable package version can be recovered')
  if (tag !== `v${version}`) throw new Error('Recovery tag must match the current package version')
  if (!/^[a-f\d]{40}$/i.test(sourceSha) || !/^[a-f\d]{40}$/i.test(currentSha))
    throw new Error('Recovery requires exact source and current commit SHAs')
  if (!sourceIsAncestor)
    throw new Error('Release source must be contained in the trusted main checkout')

  const metadata = /** @type {Record<string, any>} */ (release)
  if (
    !metadata ||
    metadata.immutable !== true ||
    metadata.draft !== false ||
    metadata.prerelease !== false ||
    metadata.tag_name !== tag
  )
    throw new Error('Recovery requires the exact published immutable stable release')

  const asset = `code-foundry-${version}.tgz`
  const matches = Array.isArray(metadata.assets)
    ? metadata.assets.filter((/** @type {Record<string, any>} */ item) => item?.name === asset)
    : []
  if (matches.length !== 1 || matches[0]?.state !== 'uploaded' || !(matches[0]?.size > 0))
    throw new Error(
      'The immutable release must contain exactly one uploaded archive for this version'
    )

  return { tag, asset, sourceSha: sourceSha.toLowerCase(), version }
}

/**
 * Require a positive, exact npm 404 before attempting recovery. A timeout,
 * permissions failure, malformed response, or existing version all fail shut.
 * @param {{status:number|null, stderr:string, version:string}} input
 */
export function requireNpmVersionMissing(input) {
  if (!/^\d+\.\d+\.\d+$/.test(input.version))
    throw new Error('Expected an exact stable package version')
  if (input.status === 0) throw new Error('The npm version already exists; recovery is not allowed')
  const missing = `No match found for version ${input.version}`
  if (input.status !== 1 || !/\bE404\b/.test(input.stderr) || !input.stderr.includes(missing))
    throw new Error('Could not confirm the npm version is absent; registry state is unverified')
  return true
}

/**
 * Resolve and validate every external prerequisite before writing recovery outputs.
 *
 * @param {{repository:string,tag:string,currentSha:string,outputPath:string,packagePath?:string}} input
 * @param {{runGh?:(args:string[])=>{status:number|null,stdout:string,stderr?:string},resolveTagCommit?:(repository:string,tag:string)=>string,spawnSync?:(command:string,args:string[],options?:object)=>{status:number|null,stderr?:string,error?:Error}}} [adapters]
 */
export function verifyRecoveryTarget(input, adapters = {}) {
  const github = adapters.runGh ?? runGh
  const resolveTag =
    adapters.resolveTagCommit ?? ((repository, tag) => resolveTagCommit(repository, tag, github))
  const spawn = adapters.spawnSync ?? spawnSync
  const version = JSON.parse(readFileSync(input.packagePath ?? 'package.json', 'utf8')).version
  const sourceSha = resolveTag(input.repository, input.tag)
  const releaseResult = github([
    'api',
    '--hostname',
    'github.com',
    `repos/${input.repository}/releases/tags/${encodeURIComponent(input.tag)}`,
  ])
  if (releaseResult.status !== 0) throw new Error('Could not verify the requested GitHub release')
  let release
  try {
    release = JSON.parse(releaseResult.stdout)
  } catch {
    throw new Error('GitHub returned invalid release metadata')
  }
  const ancestor = spawn('git', ['merge-base', '--is-ancestor', sourceSha, input.currentSha])
  const target = validateRecoveryTarget({
    tag: input.tag,
    version,
    release,
    sourceSha,
    currentSha: input.currentSha,
    sourceIsAncestor: ancestor.status === 0,
  })
  const npm = spawn(
    'npm',
    [
      'view',
      `code-foundry@${version}`,
      'version',
      '--json',
      '--registry',
      'https://registry.npmjs.org',
    ],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 }
  )
  requireNpmVersionMissing({
    status: npm.status,
    stderr: typeof npm.stderr === 'string' ? npm.stderr : (npm.stderr?.toString() ?? ''),
    version,
  })
  appendFileSync(
    input.outputPath,
    `tag=${target.tag}\nasset=${target.asset}\nsource-sha=${target.sourceSha}\n`
  )
  return target
}

if (process.argv[2] === 'verify-target') {
  try {
    const [, , , repository, tag, currentSha, outputPath] = process.argv
    if (!repository || !tag || !currentSha || !outputPath)
      throw new Error(
        'Usage: release-recovery.mjs verify-target <repository> <tag> <current-sha> <output-path>'
      )
    const target = verifyRecoveryTarget({ repository, tag, currentSha, outputPath })
    console.log(`Recovery target verified: ${target.tag} at ${target.sourceSha}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Recovery target verification failed')
    process.exitCode = 1
  }
} else if (process.argv[2] !== undefined) {
  console.error('Unknown release recovery command')
  process.exitCode = 1
}
