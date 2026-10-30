// @ts-check

/** @param {unknown} value @returns {value is Record<string, any>} */
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const TOP_LEVEL_RELEASE_CONFIG_KEYS = new Set([
  '$schema',
  'bump-minor-pre-major',
  'changelog-sections',
  'extra-files',
  'group-pull-request-title-pattern',
  'include-component-in-tag',
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
  'package-name',
  'release-type',
])

// npm can run these hooks around the exact test, pack-check, or publish path.
// Keep release-time side effects outside the narrow receipt contract too.
const UNSUPPORTED_TEST_AND_PACK_HOOKS = [
  'pretest',
  'posttest',
  'pretest:unit',
  'posttest:unit',
  'prepack:check',
  'postpack:check',
  'publish',
  'postpublish',
]

/**
 * Reuse source-test evidence only for a public npm package released from the
 * repository root. Workspace and private-root layouts need package-specific
 * build and archive contracts, so they keep the full validation path.
 * @param {{packageManifest:unknown, releaseManifest:unknown, releaseConfigs:unknown[], packageManager?:unknown}} input
 */
export function supportsRootNpmReleaseContract(input) {
  const { packageManifest, releaseManifest, releaseConfigs, packageManager } = input
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
    if (
      config['extra-files'] !== undefined &&
      (!Array.isArray(config['extra-files']) || config['extra-files'].length !== 0)
    )
      return false
    if (
      config['include-component-in-tag'] !== undefined &&
      config['include-component-in-tag'] !== false
    )
      return false
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
        (rootConfig['package-name'] !== undefined &&
          rootConfig['package-name'] !== packageManifest.name) ||
        (rootConfig['release-type'] !== undefined && rootConfig['release-type'] !== 'node') ||
        (rootConfig['manifest-file'] !== undefined &&
          rootConfig['manifest-file'] !== '.release-please-manifest.json')
      ) {
        return false
      }
    }
  }

  const lifecycleScripts = packageManifest.scripts
  if (lifecycleScripts !== undefined && !object(lifecycleScripts)) return false
  if (object(lifecycleScripts)) {
    if (['prepare', 'prepack', 'postpack', 'prepublish'].some((name) => name in lifecycleScripts))
      return false
    if ('prepublishOnly' in lifecycleScripts) {
      const expectedBuild = ['bun', 'npm', 'pnpm', 'yarn'].includes(
        /** @type {string} */ (packageManager)
      )
        ? `${packageManager} run build`
        : null
      // This fixed hook is covered by the source audit's unit test command and
      // the release candidate pack qualification. Do not admit shell variants.
      const expectedTestAndPackCheck =
        lifecycleScripts.prepublishOnly === 'npm test && npm run pack:check' &&
        lifecycleScripts.test === 'node --test' &&
        lifecycleScripts['test:unit'] === 'node --test' &&
        lifecycleScripts['pack:check'] === 'npm pack --dry-run' &&
        !UNSUPPORTED_TEST_AND_PACK_HOOKS.some((name) => name in lifecycleScripts)
      const expectedBuildOnly =
        typeof lifecycleScripts.build === 'string' &&
        lifecycleScripts.prepublishOnly === expectedBuild
      if (!expectedBuildOnly && !expectedTestAndPackCheck) {
        return false
      }
    }
  }

  return true
}
