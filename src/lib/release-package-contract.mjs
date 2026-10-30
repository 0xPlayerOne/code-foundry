// @ts-check

import { lockedWorkspaces } from './bun-lock.mjs'

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
 * This contract deliberately names one application-owned package layout. It
 * does not relax the public-root contract for arbitrary private roots or
 * workspaces.
 */
const ADEA_UI_ROOT_NAME = 'adea-ui'
const ADEA_UI_PACKAGE_NAME = '@adea-ai/ui'
const ADEA_UI_PACKAGE_PATH = 'packages/ui'
const ADEA_UI_WORKSPACES = ['apps/*', 'packages/*']
const ADEA_UI_RELEASE_PATHS = [
  '.release-please-manifest.json',
  'CHANGELOG.md',
  'bun.lock',
  'package.json',
  'packages/ui/package.json',
]
const ADEA_UI_LIFECYCLE_HOOKS = [
  'preinstall',
  'install',
  'postinstall',
  'preversion',
  'version',
  'postversion',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
  'prebuild',
  'postbuild',
  'prepack',
  'postpack',
  'prepublishOnly',
  'publish',
  'postpublish',
  'pretest',
  'posttest',
  'pretest:unit',
  'posttest:unit',
  'prepack:check',
  'postpack:check',
]

const ADEA_UI_BUILD_SCRIPT =
  'bun run cn:build && vite build && tsc -p tsconfig.json --emitDeclarationOnly'
const ADEA_UI_PACK_CHECK_SCRIPT = 'bun scripts/check-pack.ts && bun scripts/check-lib-exports.ts'
const ADEA_UI_ROOT_PACK_CHECK_SCRIPT = 'bun run --cwd packages/ui pack:check'

/** @param {unknown} value @returns {value is string} */
function semver(value) {
  return (
    typeof value === 'string' &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
  )
}

/** @param {unknown} value @returns {Record<string, any>|null} */
function jsonObject(value) {
  return object(value) ? value : null
}

/** @param {unknown} value */
function hasUnsafeLifecycle(value) {
  const scripts = jsonObject(value)
  if (!scripts) return value !== undefined
  return ADEA_UI_LIFECYCLE_HOOKS.some((hook) => Object.hasOwn(scripts, hook))
}

/** @param {unknown} configs */
function hasExactAdeaUiReleaseConfig(configs) {
  if (!Array.isArray(configs) || configs.length !== 1) return false
  const [config] = configs
  if (!object(config) || Object.keys(config).some((key) => !TOP_LEVEL_RELEASE_CONFIG_KEYS.has(key)))
    return false
  if (
    (config['release-type'] !== undefined && config['release-type'] !== 'node') ||
    config['include-component-in-tag'] !== false ||
    (config['manifest-file'] !== undefined &&
      config['manifest-file'] !== '.release-please-manifest.json') ||
    !Array.isArray(config['extra-files']) ||
    config['extra-files'].length !== 1
  ) {
    return false
  }
  const [extraFile] = config['extra-files']
  if (
    !object(extraFile) ||
    Object.keys(extraFile).length !== 3 ||
    extraFile.type !== 'json' ||
    extraFile.path !== 'packages/ui/package.json' ||
    extraFile.jsonpath !== '$.version'
  ) {
    return false
  }
  const packages = config.packages
  if (!object(packages) || Object.keys(packages).join('\n') !== '.') return false
  const rootConfig = packages['.']
  return (
    object(rootConfig) &&
    Object.keys(rootConfig).every((key) => ROOT_PACKAGE_CONFIG_KEYS.has(key)) &&
    rootConfig['package-name'] === ADEA_UI_PACKAGE_NAME &&
    rootConfig['release-type'] === 'node' &&
    (rootConfig['manifest-file'] === undefined ||
      rootConfig['manifest-file'] === '.release-please-manifest.json') &&
    rootConfig['extra-files'] === undefined
  )
}

/** @param {string} lockText @param {string} expectedVersion */
function normalizeAdeaUiLockVersion(lockText, expectedVersion) {
  if (
    (lockText.match(/"packages\/ui"\s*:/g) ?? []).length !== 1 ||
    (lockText.match(/"name"\s*:\s*"@adea-ai\/ui"/g) ?? []).length !== 1
  ) {
    return null
  }
  const candidates = lockedWorkspaces(lockText).filter(
    (workspace) =>
      workspace.path === ADEA_UI_PACKAGE_PATH || workspace.name === ADEA_UI_PACKAGE_NAME
  )
  if (
    candidates.length !== 1 ||
    candidates[0].path !== ADEA_UI_PACKAGE_PATH ||
    candidates[0].name !== ADEA_UI_PACKAGE_NAME ||
    candidates[0].version !== expectedVersion
  ) {
    return null
  }
  const lines = lockText.split(/\r?\n/)
  const line = lines[candidates[0].line]
  const versionMatch = /^(\s*"version": ")([^"]+)(".*)$/.exec(line)
  if (!versionMatch || !semver(versionMatch[2])) return null
  lines[candidates[0].line] = `${versionMatch[1]}<workspace-version>${versionMatch[3]}`
  return lines.join(lockText.includes('\r\n') ? '\r\n' : '\n')
}

/**
 * @param {{rootPackageManifest:unknown, workspacePackageManifest:unknown, releaseManifest:unknown, releaseConfigs:unknown[], packageManager?:unknown, codeFoundryConfig:unknown, lockfileText:string|null, publisherWorkflowText:string|null}} input
 */
export function supportsAdeaUiWorkspaceReleaseContract(input) {
  const {
    rootPackageManifest,
    workspacePackageManifest,
    releaseManifest,
    releaseConfigs,
    packageManager,
    codeFoundryConfig,
    lockfileText,
    publisherWorkflowText,
  } = input
  const root = jsonObject(rootPackageManifest)
  const workspace = jsonObject(workspacePackageManifest)
  const manifest = jsonObject(releaseManifest)
  const foundry = jsonObject(codeFoundryConfig)
  const rootScripts = jsonObject(root?.scripts)
  const workspaceScripts = jsonObject(workspace?.scripts)
  if (
    !root ||
    !workspace ||
    !manifest ||
    !foundry ||
    !rootScripts ||
    !workspaceScripts ||
    !semver(root.version) ||
    !semver(workspace.version) ||
    root.name !== ADEA_UI_ROOT_NAME ||
    root.private !== true ||
    JSON.stringify(root.workspaces) !== JSON.stringify(ADEA_UI_WORKSPACES) ||
    root.version !== workspace.version ||
    workspace.name !== ADEA_UI_PACKAGE_NAME ||
    workspace.private === true ||
    (workspace.publishConfig?.access !== undefined &&
      workspace.publishConfig.access !== 'public') ||
    root.packageManager !== 'bun@1.4.4' ||
    packageManager !== 'bun' ||
    root.scripts['pack:check'] !== ADEA_UI_ROOT_PACK_CHECK_SCRIPT ||
    workspaceScripts.build !== ADEA_UI_BUILD_SCRIPT ||
    workspaceScripts['pack:check'] !== ADEA_UI_PACK_CHECK_SCRIPT ||
    manifest['.'] !== root.version ||
    Object.keys(manifest).join('\n') !== '.' ||
    foundry.release_qualification_receipts !== 'true' ||
    foundry.npm_publish !== 'false' ||
    hasUnsafeLifecycle(root.scripts) ||
    hasUnsafeLifecycle(workspace.scripts) ||
    !hasExactAdeaUiReleaseConfig(releaseConfigs) ||
    typeof lockfileText !== 'string' ||
    !hasQualifiedAdeaUiPublisher(publisherWorkflowText) ||
    normalizeAdeaUiLockVersion(lockfileText, workspace.version) === null
  ) {
    return false
  }
  return true
}

/** @param {unknown} value */
function hasQualifiedAdeaUiPublisher(value) {
  if (typeof value !== 'string') return false
  const needs = [
    '      - prepare',
    '      - packed-conversation',
    '      - packed-layout',
    '      - packed-layout-renderer',
    '      - packed-appearance',
    '      - packed-modal-dialog',
    '      - packed-native-select',
  ]
  const publishJob = value.match(/  publish:\n[\s\S]*?(?=\n  [a-zA-Z_-]+:|\n?$)/)?.[0]
  return (
    value.includes('run: bun run pack:check') &&
    value.includes('run: node scripts/prepare-packed-ui.mjs "$RUNNER_TEMP/prepared-ui"') &&
    value.includes(
      "if (manifest.name !== '@adea-ai/ui' || manifest.version !== process.env.EXPECTED_VERSION)"
    ) &&
    value.includes('if (sha256 !== process.env.EXPECTED_SHA256 || manifest.sha256 !== sha256)') &&
    value.includes(
      'if (integrity !== process.env.EXPECTED_INTEGRITY || manifest.integrity !== integrity)'
    ) &&
    (
      value.match(
        /^\s*run: npm publish "\$RUNNER_TEMP\/prepared-ui\/package\.tgz" --access public --provenance\s*$/gm
      ) ?? []
    ).length === 1 &&
    publishJob !== undefined &&
    needs.every((line) => publishJob.includes(line))
  )
}

/** @param {string} content */
function parseJsonText(content) {
  try {
    return JSON.parse(content)
  } catch {
    return null
  }
}

/** @param {unknown} value @returns {string} */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** @param {unknown} before @param {unknown} after */
function sameExceptVersion(before, after) {
  const left = jsonObject(before)
  const right = jsonObject(after)
  if (!left || !right || !semver(left.version) || !semver(right.version)) return false
  const { version: _beforeVersion, ...beforeFields } = left
  const { version: _afterVersion, ...afterFields } = right
  return stableJson(beforeFields) === stableJson(afterFields)
}

/**
 * Prove that this workspace Release Please PR changes only the linked UI
 * versions, the single Bun workspace version, and generated changelog prose.
 * @param {{baseFiles:Map<string,string>, headFiles:Map<string,string>, changedPaths:string[], modeChanges?:string}} input
 */
export function validateAdeaUiWorkspaceReleaseDiff(input) {
  const { baseFiles, headFiles, changedPaths, modeChanges = '' } = input
  const failures = []
  if (
    changedPaths.length !== ADEA_UI_RELEASE_PATHS.length ||
    new Set(changedPaths).size !== ADEA_UI_RELEASE_PATHS.length ||
    ADEA_UI_RELEASE_PATHS.some((path) => !changedPaths.includes(path))
  ) {
    failures.push('workspace release must change exactly the approved five Release Please files')
  }
  if (modeChanges.trim()) failures.push('workspace release must not change file modes')
  if (ADEA_UI_RELEASE_PATHS.some((path) => !baseFiles.has(path) || !headFiles.has(path))) {
    failures.push('workspace release metadata is incomplete')
  }
  if (failures.length) return { valid: false, failures }

  const beforeRoot = parseJsonText(baseFiles.get('package.json') ?? '')
  const afterRoot = parseJsonText(headFiles.get('package.json') ?? '')
  const beforePackage = parseJsonText(baseFiles.get('packages/ui/package.json') ?? '')
  const afterPackage = parseJsonText(headFiles.get('packages/ui/package.json') ?? '')
  const beforeManifest = parseJsonText(baseFiles.get('.release-please-manifest.json') ?? '')
  const afterManifest = parseJsonText(headFiles.get('.release-please-manifest.json') ?? '')
  const beforeLock = normalizeAdeaUiLockVersion(
    baseFiles.get('bun.lock') ?? '',
    beforePackage?.version
  )
  const afterLock = normalizeAdeaUiLockVersion(
    headFiles.get('bun.lock') ?? '',
    afterPackage?.version
  )
  /** @param {unknown} value @param {unknown} version */
  const validManifest = (value, version) =>
    object(value) && Object.keys(value).join('\n') === '.' && value['.'] === version
  if (
    !sameExceptVersion(beforeRoot, afterRoot) ||
    !sameExceptVersion(beforePackage, afterPackage) ||
    beforeRoot?.version !== beforePackage?.version ||
    afterRoot?.version !== afterPackage?.version ||
    beforeRoot?.version === afterRoot?.version ||
    !validManifest(beforeManifest, beforeRoot?.version) ||
    !validManifest(afterManifest, afterRoot?.version) ||
    beforeLock === null ||
    afterLock === null ||
    beforeLock !== afterLock
  ) {
    failures.push(
      'workspace release changed more than the linked package versions, manifest, changelog, or exact lock workspace version'
    )
  }
  return { valid: failures.length === 0, failures }
}

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
