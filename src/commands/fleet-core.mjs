// @ts-check

import { readPackageVersion, syncRepository } from './sync.mjs'
import {
  discoverManifestRepositories,
  hasFleetManifest,
  upgradeManifestFleet,
} from '../lib/fleet-manifest.mjs'

/** @typedef {{ path: string, repository: string, runtimeRef: string, dirty: boolean, configured: boolean, gitWorkflow: string }} FleetRepository */

/** @param {string} root */
function requireFleetManifest(root) {
  if (!hasFleetManifest(root)) {
    throw new Error(
      'Missing code-foundry-fleet.json; fleet discovery requires an explicit manifest.'
    )
  }
}

/** @param {string} root @returns {FleetRepository[]} */
export function discoverRepositories(root) {
  requireFleetManifest(root)
  return discoverManifestRepositories(root)
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
  requireFleetManifest(root)
  return upgradeManifestFleet(root, source, { ...options, version }, syncRepository)
}
