// @ts-check
import { upgradeFleet as upgrade } from './fleet-core.mjs'
import { readPackageVersion } from './sync.mjs'
import { guardedFleetUpgrade } from '../lib/fleet-eligibility.mjs'

export * from './fleet-core.mjs'

/** @param {string} root @param {string} source
 * @param {Parameters<typeof upgrade>[2]} options
 */
export function upgradeFleet(root, source, options) {
  const version = options.version ?? `v${readPackageVersion(source)}`
  return guardedFleetUpgrade(root, source, version, () => upgrade(root, source, options))
}
