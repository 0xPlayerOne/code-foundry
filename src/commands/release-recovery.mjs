// @ts-check

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
