// @ts-check

/** @param {unknown} value @returns {value is Record<string, any>} */
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const TOP_LEVEL_RELEASE_CONFIG_KEYS = new Set([
  '$schema',
  'bump-minor-pre-major',
  'changelog-sections',
  'group-pull-request-title-pattern',
  'manifest-file',
  'packages',
  'pull-request-title-pattern',
  'release-type',
])

const ROOT_PACKAGE_CONFIG_KEYS = new Set([
  'draft',
  'force-tag-creation',
  'include-component-in-tag',
  'manifest-file',
  'release-type',
])

/**
 * Reuse source-test evidence only for a public npm package released from the
 * repository root. Workspace and private-root layouts need package-specific
 * build and archive contracts, so they keep the full validation path.
 * @param {{packageManifest:unknown, releaseManifest:unknown, releaseConfigs:unknown[]}} input
 */
export function supportsRootNpmReleaseContract(input) {
  const { packageManifest, releaseManifest, releaseConfigs } = input
  if (
    !object(packageManifest) ||
    packageManifest.private === true ||
    typeof packageManifest.name !== 'string' ||
    packageManifest.name.length === 0 ||
    typeof packageManifest.version !== 'string' ||
    packageManifest.version.length === 0 ||
    Object.hasOwn(packageManifest, 'workspaces') ||
    !object(releaseManifest) ||
    Object.keys(releaseManifest).join('\n') !== '.' ||
    releaseManifest['.'] !== packageManifest.version ||
    !Array.isArray(releaseConfigs) ||
    releaseConfigs.length === 0
  ) {
    return false
  }

  for (const config of releaseConfigs) {
    if (!object(config)) return false
    if (Object.keys(config).some((key) => !TOP_LEVEL_RELEASE_CONFIG_KEYS.has(key))) return false
    if (config['extra-files'] !== undefined) return false
    if (
      config['manifest-file'] !== undefined &&
      config['manifest-file'] !== '.release-please-manifest.json'
    ) {
      return false
    }
    if (config['release-type'] !== undefined && config['release-type'] !== 'node') return false
    if (config.packages !== undefined) {
      if (!object(config.packages) || Object.keys(config.packages).join('\n') !== '.') return false
      const rootConfig = config.packages['.']
      if (
        !object(rootConfig) ||
        Object.keys(rootConfig).some((key) => !ROOT_PACKAGE_CONFIG_KEYS.has(key)) ||
        rootConfig['extra-files'] !== undefined ||
        (rootConfig['release-type'] !== undefined && rootConfig['release-type'] !== 'node') ||
        (rootConfig['manifest-file'] !== undefined &&
          rootConfig['manifest-file'] !== '.release-please-manifest.json')
      ) {
        return false
      }
    }
  }

  const lifecycleScripts = packageManifest.scripts
  if (
    object(lifecycleScripts) &&
    ['prepare', 'prepack', 'postpack', 'prepublishOnly'].some(
      (name) => typeof lifecycleScripts[name] === 'string'
    )
  ) {
    return false
  }

  return true
}
