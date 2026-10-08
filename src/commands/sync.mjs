// @ts-check

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  detectLanguages,
  detectPackageManager,
  detectProfile,
  recommendRunners,
} from '../lib/profile.mjs'
import {
  configured,
  gitWorkflow,
  includesValue,
  isStagingRelease,
  readConfig,
} from '../lib/config.mjs'
import { buildReleaseConfig, buildReleaseManifest } from '../lib/release-manifest.mjs'
import { customWorkflowFiles, overlayPolicy } from '../lib/overlay.mjs'
import {
  inspectQueueCaller,
  mergeQueueEnabled,
  queueRuntimeRef,
  renderMergeQueueCaller,
  syncQueueCaller,
} from '../lib/merge-queue.mjs'

const standardFiles = [
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  'release-please-config.json',
  'docs/EXTENSIONS.md',
  '.githooks/pre-commit',
  'AGENTS.md',
  'LICENSE',
  'NOTICE',
  'ruff.toml',
  '.oxfmtrc.json',
  '.oxlintrc.json',
  '.github/CODEOWNERS',
  '.github/CODE_OF_CONDUCT.md',
  '.github/CONTRIBUTING.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/SECURITY.md',
  '.github/dependabot.yml',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/workflows/validation.yml',
  '.github/workflows/validation-audit.yml',
  '.github/workflows/draft-control.yml',
  '.github/workflows/draft-enforcement.yml',
  '.github/workflows/draft-pr.yml',
  '.github/workflows/release-pr.yml',
  '.github/workflows/release.yml',
  '.github/workflows/release-integrity.yml',
  '.github/workflows/opencode-security.yml',
]

/**
 * Legacy event callers that the tiered validation caller replaces. Sync
 * removes them only when they are recognized as Code Foundry-generated;
 * custom workflows are always preserved byte-for-byte.
 */
const LEGACY_GENERATED_CALLERS = ['ci', 'test', 'security', 'codeql']

const protectedFiles = new Set([
  'AGENTS.md',
  '.github/CODE_OF_CONDUCT.md',
  '.github/CONTRIBUTING.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/SECURITY.md',
  'NOTICE',
])

const configAwarePolicyFiles = new Set([
  'AGENTS.md',
  '.github/CONTRIBUTING.md',
  '.github/SECURITY.md',
])

/** @type {Record<string, string>} */
const licenseFiles = {
  'gpl-3.0-or-later': 'GPL-3.0-or-later.txt',
  'agpl-3.0-or-later': 'AGPL-3.0-or-later.txt',
  'apache-2.0': 'APACHE-2.0.txt',
  mit: 'MIT.txt',
}

const legacyFiles = [
  '.github/code-foundry.yml.example',
  '.github/template.yml',
  '.github/template.yml.example',
  '.github/scripts/bootstrap.sh',
  '.github/scripts/changed-files.sh',
  '.github/scripts/ci.sh',
  '.github/scripts/codeql-languages.sh',
  '.github/scripts/doctor.sh',
  '.github/scripts/format-fast-path.sh',
  '.github/scripts/init-repo.sh',
  '.github/scripts/pre-commit.sh',
  '.github/scripts/profile.sh',
  '.github/scripts/security.sh',
  '.github/scripts/sitecustomize.py',
  '.github/scripts/sync-codeowners.sh',
  '.github/scripts/sync-protection.sh',
  '.github/scripts/sync-template.sh',
  '.github/scripts/turbo-cache-probe.sh',
  '.github/licenses/MIT.txt',
  '.github/licenses/GPL-3.0-or-later.txt',
  '.github/licenses/AGPL-3.0-or-later.txt',
]

/** @typedef {{ target: string, source: string, dryRun?: boolean, force?: boolean, init?: boolean, runtimeRef?: string, configureHooks?: boolean }} SyncOptions */

/** @param {SyncOptions} options */
function synchronize(options) {
  const target = resolve(options.target)
  const source = resolve(options.source)
  const selfRepository = target === source
  const dryRun = options.dryRun ?? false
  const force = options.force ?? false
  const configPath = join(target, '.github/code-foundry.yml')
  const existingConfig = readConfig(configPath)
  const changed = []
  if (!Object.keys(existingConfig).length && !options.init)
    throw new Error('Missing .github/code-foundry.yml; run init first.')
  validateReleaseBatchingConfig(existingConfig)
  if (
    existingConfig.release_batching_schedule &&
    existingConfig.release_batching_prerelease !== 'false'
  ) {
    const releasePath = join(target, 'release-please-config.json')
    if (existsSync(releasePath)) {
      const packages = JSON.parse(readFileSync(releasePath, 'utf8')).packages
      if (packages && (Object.keys(packages).length !== 1 || !packages['.'])) {
        throw new Error(
          'Unsupported release_batching_schedule: batched publication requires a single root Release Please package.'
        )
      }
    }
  }
  const defaults = createDefaultConfig(target, source, existingConfig.git_workflow)
  let config = { ...defaults, ...existingConfig }
  const workflow = gitWorkflow(config.git_workflow)
  if (!['direct', 'staging-release'].includes(workflow)) {
    throw new Error(`Unsupported git_workflow: ${workflow}; use direct or staging-release.`)
  }
  const draftProtection = configured(config.draft_protection, 'true')
  if (!['true', 'false'].includes(draftProtection)) {
    throw new Error(`Unsupported draft_protection: ${draftProtection}; use true or false.`)
  }
  // Validate the dependency-update bot policy before any sync writes so a
  // typo fails fast instead of leaving a half-switched updater behind.
  const dependencyUpdater = configured(config.dependency_updater, 'dependabot')
  if (!['renovate', 'dependabot', 'none'].includes(dependencyUpdater)) {
    throw new Error(
      `Unsupported dependency_updater: ${dependencyUpdater}; use renovate, dependabot, or none.`
    )
  }
  const obsoleteConfigKeys = [
    'opencode_security',
    ...(workflow === 'direct' ? ['staging_validation_mode'] : []),
  ]
  for (const key of obsoleteConfigKeys) delete config[key]
  // Resolve and validate the license policy before any sync writes occur
  // (including config/default additions) so an unsupported policy fails
  // fast without leaving partially generated files behind.
  const license = configured(
    config.license,
    existsSync(join(target, 'LICENSE')) ? 'preserve' : 'gpl-3.0-or-later'
  )
  const licenseFile = licenseFiles[license]
  if (license !== 'preserve' && license !== 'none' && !licenseFile) {
    const supported = [...Object.keys(licenseFiles), 'preserve', 'none'].join(', ')
    throw new Error(`Unsupported license: ${license}; use ${supported}.`)
  }
  if (!Object.keys(existingConfig).length) {
    changed.push('.github/code-foundry.yml')
    writeOrReport(configPath, renderConfig(config), dryRun)
  } else {
    const missing = Object.keys(defaults).filter((key) => !(key in existingConfig))
    const original = readFileSync(configPath, 'utf8')
    const normalized = removeConfigKeys(original, obsoleteConfigKeys).trimEnd()
    if (missing.length || normalized !== original.trimEnd()) {
      changed.push('.github/code-foundry.yml')
      const additions = missing.map((key) => renderConfigLine(key, defaults[key])).join('\n')
      writeOrReport(configPath, `${normalized}${additions ? `\n${additions}` : ''}\n`, dryRun)
    }
  }

  const languages = configured(config.languages, detectLanguages(target).join(','))
  const features = configured(config.features, 'all')
  const runtimeRepository = configured(config.runtime_repository, '0xPlayerOne/code-foundry')
  const sourceRuntimeRef = `v${readPackageVersion(source)}`
  // An explicit runtime ref (fleet upgrade) is authoritative: the rendered
  // callers and the config pin must agree with it, otherwise an upgrade would
  // declare one runtime while shipping another.
  const targetRuntimeRef = options.runtimeRef ?? sourceRuntimeRef
  let runtimeRef = options.runtimeRef ?? configured(config.runtime_ref, sourceRuntimeRef)
  const toolchain = configured(config.toolchain, 'auto')
  const overlays = overlayPolicy(target, config)
  const rustCodeql = validateRustCodeqlConfig(config)
  if (!['auto', 'native', 'mise'].includes(toolchain)) {
    throw new Error(`Unsupported toolchain: ${toolchain}; use auto, native, or mise.`)
  }
  const stagingValidationMode = configured(config.staging_validation_mode, 'fast')
  if (workflow === 'staging-release' && !['fast', 'audit'].includes(stagingValidationMode)) {
    throw new Error(
      `Unsupported staging_validation_mode: ${stagingValidationMode}; use fast or audit.`
    )
  }
  const mergeStrategy = configured(config.merge_strategy, 'rebase')
  if (workflow === 'direct' && mergeStrategy !== 'squash') {
    throw new Error(
      `Unsupported merge_strategy: ${mergeStrategy}; the direct topology requires squash for feature pull requests.`
    )
  }
  if (workflow === 'staging-release' && mergeStrategy !== 'rebase') {
    throw new Error(
      `Unsupported merge_strategy: ${mergeStrategy}; the staging-release topology requires rebase for staging to main promotions.`
    )
  }
  const releaseMergeStrategy = configured(config.release_merge_strategy, '')
  if (includesValue(features, 'release')) {
    // Staging-release reconciliations depend on rebase promotions and rebase
    // release commits; the direct topology has no reconciliation step, so it
    // may also squash Release Please version PRs (a single-commit release PR
    // squashes to the identical tree, and release-please recommends squash).
    const allowedReleaseStrategies = workflow === 'staging-release' ? ['rebase'] : ['squash']
    if (!allowedReleaseStrategies.includes(releaseMergeStrategy)) {
      throw new Error(
        `Unsupported release_merge_strategy: ${releaseMergeStrategy || '(unset)'}; release automation requires ${workflow === 'staging-release' ? 'rebase' : 'squash'} for Release Please version pull requests and never defaults to merge.`
      )
    }
  }
  // Keep normal semver pins current during consumer syncs while preserving
  // intentional refs such as `main`, `staging`, or a custom immutable SHA. An
  // explicit runtime ref (fleet upgrade) is authoritative and overrides even
  // those so the rendered callers and the config pin land on the same runtime.
  // The runtime source itself is excluded from automatic pin advancement so a
  // self-referencing config cannot create a release loop.
  if (
    existingConfig.runtime_ref &&
    existingConfig.runtime_ref !== targetRuntimeRef &&
    (options.runtimeRef !== undefined ||
      (!selfRepository && /^v\d+\.\d+\.\d+$/.test(existingConfig.runtime_ref)))
  ) {
    runtimeRef = targetRuntimeRef
    const current = readFileSync(configPath, 'utf8')
    const updated = current.replace(/^runtime_ref:\s*.*$/m, `runtime_ref: ${targetRuntimeRef}`)
    if (updated !== current) {
      changed.push('.github/code-foundry.yml')
      writeOrReport(configPath, updated, dryRun)
    }
  }

  for (const file of standardFiles) {
    if (!shouldInclude(file, languages, features, config)) continue
    const sourceFile = sourcePath(source, file)
    if (!existsSync(sourceFile)) throw new Error(`Template file missing: ${file}`)
    const destination = join(target, file)
    if (
      (file === 'LICENSE' || file === 'NOTICE') &&
      license === 'preserve' &&
      existsSync(destination)
    )
      continue
    if ((file === 'LICENSE' || file === 'NOTICE') && license === 'none') continue
    // An explicit license policy makes the license block below the single
    // owner of LICENSE; copying the runtime's own root LICENSE here would
    // fight it and break idempotence on the next sync.
    if (file === 'LICENSE' && license !== 'preserve' && license !== 'none') continue
    if (file === '.github/CODEOWNERS' && existsSync(destination)) continue
    let content = readFileSync(sourceFile)
    if (file === 'release-please-config.json') {
      content = Buffer.from(renderReleaseConfig(target, sourceFile, config))
    }
    if (file.endsWith('.yml') && file.startsWith('.github/workflows/')) {
      content = Buffer.from(
        renderWorkflow(
          content.toString('utf8'),
          config,
          runtimeRepository,
          runtimeRef,
          rustCodeql,
          file,
          selfRepository
        )
      )
    }
    if (file === '.github/workflows/release.yml') {
      // The batch-soak promoter rides on the release caller's sync: rendered
      // from release_batching_soak_hours, and removed when the key is gone so
      // a disabled soak stops scheduling promotions.
      const promoter = renderPromoteStable(config)
      const promoterPath = join(target, '.github/workflows/promote-stable.yml')
      if (promoter) writeOrReport(promoterPath, promoter, dryRun)
      else if (existsSync(promoterPath) && !dryRun) rmSync(promoterPath)
      // The dev channel rides along the same way: rendered from
      // release_batching_dev_channel, removed when the key is gone so a
      // disabled channel stops tagging dev builds on every push.
      const devChannel = renderDevChannel(config)
      const devChannelPath = join(target, '.github/workflows/dev-channel.yml')
      if (devChannel) writeOrReport(devChannelPath, devChannel, dryRun)
      else if (existsSync(devChannelPath) && !dryRun) rmSync(devChannelPath)
    }
    if (file === '.github/dependabot.yml') {
      content = Buffer.from(renderDependabot(content.toString('utf8'), config, languages))
    }
    if (['AGENTS.md', '.github/CONTRIBUTING.md', '.github/SECURITY.md'].includes(file)) {
      content = Buffer.from(renderContributionDocs(content.toString('utf8'), file, config))
    }
    if (file === '.gitignore' && existsSync(destination)) {
      content = Buffer.from(
        mergeGitignore(content.toString('utf8'), readFileSync(destination, 'utf8'))
      )
    }
    if (file === '.oxfmtrc.json' && existsSync(destination)) {
      content = Buffer.from(
        mergeIgnorePatternsConfig(content.toString('utf8'), readFileSync(destination, 'utf8'))
      )
    }
    if (file === '.oxlintrc.json' && existsSync(destination)) {
      content = Buffer.from(
        mergeIgnorePatternsConfig(content.toString('utf8'), readFileSync(destination, 'utf8'))
      )
    }
    if (!force && protectedFiles.has(file) && existsSync(destination)) {
      const existing = readFileSync(destination, 'utf8')
      if (isLegacyManagedDoc(file, existing)) {
        // Ancient scaffolds predate managed blocks entirely; fall through to
        // the full overwrite so they migrate to the marked layout.
      } else if (configAwarePolicyFiles.has(file)) {
        // Refresh managed blocks in place and keep every unmarked line. A
        // whole-file overwrite here would silently delete repository-owned
        // sections of the policy documents (issue #667).
        const merged = refreshManagedPolicyDocument(existing, content.toString('utf8'))
        if (merged !== existing) {
          changed.push(file)
          writeOrReport(destination, merged, dryRun)
        }
        continue
      } else {
        continue
      }
    }
    if (!existsSync(destination) || !buffersEqual(content, readFileSync(destination))) {
      changed.push(file)
      writeOrReport(destination, content, dryRun)
    }
  }

  for (const stem of LEGACY_GENERATED_CALLERS) {
    const destination = join(target, `.github/workflows/${stem}.yml`)
    if (!existsSync(destination)) continue
    if (isGeneratedEventCaller(readFileSync(destination, 'utf8'), stem, runtimeRepository)) {
      changed.push(`.github/workflows/${stem}.yml`)
      if (dryRun)
        console.log(`Would remove generated legacy caller ${stem}.yml; validation.yml replaces it.`)
      else rmSync(destination, { force: true })
    } else {
      console.log(`Preserved ${stem}.yml: not recognized as a Code Foundry-generated caller.`)
    }
  }

  // `dependency_updater` owns the dependency-update bot contract, and an
  // explicit value wins over the features gate above: a repository that
  // leaves Dependabot must not keep a previously rendered dependabot.yml,
  // and a Renovate repository gets a config only when it does not already
  // own one (repository-owned renovate.json is never modified).
  if (dependencyUpdater !== 'dependabot') {
    const destination = join(target, '.github/dependabot.yml')
    if (existsSync(destination)) {
      changed.push('.github/dependabot.yml')
      if (dryRun)
        console.log(
          `Would remove .github/dependabot.yml; dependency_updater selects ${dependencyUpdater}.`
        )
      else rmSync(destination, { force: true })
    }
  }
  if (dependencyUpdater === 'renovate') {
    const destination = join(target, 'renovate.json')
    if (!existsSync(destination)) {
      const template = join(source, 'src/templates/renovate.json')
      if (!existsSync(template))
        throw new Error('Template file missing: src/templates/renovate.json')
      changed.push('renovate.json')
      writeOrReport(destination, readFileSync(template), dryRun)
    }
  }

  // Preserved (repository-owned) workflows may reference the runtime directly,
  // for example a hand-maintained Cloudflare preview caller. Advance their
  // plain semver pins to the synced runtime ref so a stale hand-added pin
  // cannot keep an old runtime alive after a fleet upgrade. Intentional refs
  // (branch names, immutable SHAs) and other repositories' actions are left
  // untouched, mirroring the config pin policy above.
  if (!selfRepository && /^v\d+\.\d+\.\d+$/.test(runtimeRef)) {
    const standard = new Set(standardFiles)
    const workflowsDir = join(target, '.github/workflows')
    if (existsSync(workflowsDir)) {
      const runtimePin = new RegExp(
        `(uses:\\s*${escapeRegExp(runtimeRepository)}/\\.github/(?:workflows|actions)/[^\\s@]+)@v\\d+\\.\\d+\\.\\d+`,
        'g'
      )
      for (const entry of readdirSync(workflowsDir).toSorted()) {
        if (!entry.endsWith('.yml') || standard.has(`.github/workflows/${entry}`)) continue
        const destination = join(workflowsDir, entry)
        const original = readFileSync(destination, 'utf8')
        const updated = original.replace(runtimePin, `$1@${runtimeRef}`)
        if (updated !== original) {
          changed.push(`.github/workflows/${entry}`)
          if (dryRun)
            console.log(
              `Would refresh the runtime pin in .github/workflows/${entry} to ${runtimeRef}.`
            )
          else writeOrReport(destination, updated, dryRun)
        }
      }
    }
  }

  // A repository that no longer opts into the staging-release topology must
  // not keep a generated staging promotion caller that would otherwise
  // linger dormant (it triggers on pushes to a branch that does not exist).
  if (!isStagingRelease(config.git_workflow)) {
    const promotion = join(target, '.github/workflows/release-pr.yml')
    if (
      existsSync(promotion) &&
      isGeneratedEventCaller(readFileSync(promotion, 'utf8'), 'release-pr', runtimeRepository)
    ) {
      changed.push('.github/workflows/release-pr.yml')
      if (dryRun)
        console.log(
          'Would remove generated release-pr caller; the direct topology targets pull requests at main.'
        )
      else rmSync(promotion, { force: true })
    }
  }

  const releaseManifest = buildReleaseManifest(
    target,
    mergeReleaseConfig(target, sourcePath(source, 'release-please-config.json'))
  )
  if (releaseManifest) {
    const manifestPath = join(target, '.release-please-manifest.json')
    /** @type {Record<string, string>} */
    let existingManifest = {}
    if (existsSync(manifestPath)) {
      try {
        existingManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      } catch {
        existingManifest = {}
      }
    }
    /** @type {Record<string, string>} */
    const mergedManifest = {}
    for (const directory of [
      ...new Set([...Object.keys(releaseManifest), ...Object.keys(existingManifest)]),
    ].toSorted()) {
      mergedManifest[directory] = existingManifest[directory] ?? releaseManifest[directory]
    }
    const content = `${JSON.stringify(mergedManifest, null, 2)}\n`
    if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== content) {
      changed.push('.release-please-manifest.json')
      writeOrReport(manifestPath, content, dryRun)
    }
  }

  if (license !== 'preserve' && license !== 'none') {
    const sourceLicense = join(source, '.github/licenses', licenseFile)
    if (!existsSync(sourceLicense)) throw new Error(`License template missing: ${sourceLicense}`)
    const licenseContent = readFileSync(sourceLicense)
    if (
      !existsSync(join(target, 'LICENSE')) ||
      !buffersEqual(licenseContent, readFileSync(join(target, 'LICENSE')))
    ) {
      changed.push('LICENSE')
      writeOrReport(join(target, 'LICENSE'), licenseContent, dryRun)
    }
    if (!existsSync(join(target, 'NOTICE')))
      writeOrReport(join(target, 'NOTICE'), readFileSync(join(source, 'NOTICE')), dryRun)
  }

  for (const file of legacyFiles) {
    const destination = join(target, file)
    if (existsSync(destination)) {
      changed.push(file)
      if (dryRun) console.log(`Would remove ${file}`)
      else rmSync(destination, { force: true })
    }
  }
  for (const file of ['ruff.toml', '.oxfmtrc.json', '.oxlintrc.json']) {
    const relevant =
      file === 'ruff.toml'
        ? includesValue(languages, 'python')
        : includesValue(languages, 'typescript')
    if (!relevant && existsSync(join(target, file))) {
      changed.push(file)
      if (dryRun) console.log(`Would remove irrelevant language configuration ${file}`)
      else rmSync(join(target, file), { force: true })
    }
  }
  if (includesValue(languages, 'typescript')) {
    // The Oxfmt baseline supersedes .prettierrc/.prettierignore. Entries the
    // consumer added beyond the baseline survive the migration inside the
    // .oxfmtrc.json ignorePatterns list.
    const customPatterns = []
    const legacyIgnore = join(target, '.prettierignore')
    if (existsSync(legacyIgnore)) {
      const baselineEntries = new Set(['CHANGELOG.md', '.github/.code-foundry', '.github/actions/'])
      for (const line of readFileSync(legacyIgnore, 'utf8').split(/\r?\n/)) {
        const entry = line.trim()
        if (!entry || entry.startsWith('#') || baselineEntries.has(entry)) continue
        customPatterns.push(entry)
      }
      changed.push('.prettierignore')
      if (dryRun) console.log('Would remove superseded .prettierignore')
      else rmSync(legacyIgnore, { force: true })
    }
    const legacyConfig = join(target, '.prettierrc')
    if (existsSync(legacyConfig)) {
      changed.push('.prettierrc')
      if (dryRun) console.log('Would remove superseded .prettierrc')
      else rmSync(legacyConfig, { force: true })
    }
    ensureOxfmtIgnorePatterns(
      target,
      ['.github/.code-foundry', '.github/actions/', ...customPatterns],
      changed,
      dryRun
    )
  } else {
    for (const file of ['.prettierrc', '.prettierignore']) {
      if (existsSync(join(target, file))) {
        changed.push(file)
        if (dryRun) console.log(`Would remove irrelevant language configuration ${file}`)
        else rmSync(join(target, file), { force: true })
      }
    }
  }
  if (
    !dryRun &&
    options.configureHooks !== false &&
    existsSync(join(target, '.githooks/pre-commit'))
  ) {
    chmodSync(join(target, '.githooks/pre-commit'), 0o755)
    // core.hooksPath names a single directory, so pointing it at .githooks
    // would silence every machine-level hook behind it (secret guards,
    // git-lfs, signing). Record what is being replaced so the generated
    // hooks can chain back to it, then delegate the hook names this
    // repository does not own.
    const previousHooksPath = gitOutput(target, ['config', '--get', 'core.hooksPath'])
    if (previousHooksPath && previousHooksPath !== '.githooks') {
      git(target, ['config', 'code-foundry.previousHooksPath', previousHooksPath])
    }
    git(target, ['config', 'core.hooksPath', '.githooks'])
    syncMachineHookDelegates(target, previousHooksPath)
  }
  console.log(`${changed.length} baseline file(s) differ.`)
  if (overlays.custom_workflows === 'preserve') {
    const custom = customWorkflowFiles(target, standardFiles)
    if (custom.length) console.log(`Preserved ${custom.length} repository-owned workflow(s).`)
  }
  return { changed, config }
}

/** @param {Parameters<typeof synchronize>[0]} options */
export function syncRepository(options) {
  const target = resolve(options.target)
  const source = resolve(options.source)
  const existing = readConfig(join(target, '.github/code-foundry.yml'))
  const enabled = mergeQueueEnabled(existing.merge_queue)
  const ref = queueRuntimeRef(existing.runtime_ref, readPackageVersion(source), options.runtimeRef)
  // Reject malformed opt-in settings or a user-owned destination before the
  // original synchronizer changes any files. It remains the owner of defaults.
  if (enabled) {
    const preflight = renderMergeQueueCaller(
      {
        ...existing,
        runtime_repository: configured(existing.runtime_repository, '0xPlayerOne/code-foundry'),
      },
      ref
    )
    inspectQueueCaller(target, preflight)
  } else inspectQueueCaller(target, null)
  const result = synchronize(options)
  const content = enabled
    ? renderMergeQueueCaller(
        {
          ...result.config,
          runtime_repository: configured(
            result.config.runtime_repository,
            '0xPlayerOne/code-foundry'
          ),
        },
        ref
      )
    : null
  const changed = syncQueueCaller(target, content, options.dryRun ?? false)
  return { ...result, changed: [...new Set([...result.changed, ...changed])] }
}

/**
 * Baseline keys that are safe to merge into a repository's release config.
 * Package and release-type policy is detected from the repository itself and
 * must never leak from the runtime template.
 */
const RELEASE_BASELINE_KEYS = [
  '$schema',
  'bump-minor-pre-major',
  'changelog-sections',
  'include-component-in-tag',
  'pull-request-title-pattern',
  'group-pull-request-title-pattern',
]

const RELEASE_ENFORCED_KEYS = ['pull-request-title-pattern', 'group-pull-request-title-pattern']

/** @param {string} target @param {string} sourceFile @returns {Record<string, any>} */
function mergeReleaseConfig(target, sourceFile) {
  /** @type {Record<string, any>} */
  let baseline = {}
  try {
    baseline = JSON.parse(readFileSync(sourceFile, 'utf8'))
  } catch {
    baseline = {}
  }
  const safeBaseline = Object.fromEntries(
    RELEASE_BASELINE_KEYS.filter((key) => key in baseline).map((key) => [key, baseline[key]])
  )
  const destination = join(target, 'release-please-config.json')
  let existing = baseline
  if (existsSync(destination)) {
    try {
      existing = JSON.parse(readFileSync(destination, 'utf8'))
    } catch {
      existing = baseline
    }
  }
  const merged = { ...safeBaseline, ...existing }
  for (const key of RELEASE_ENFORCED_KEYS) {
    if (key in baseline) merged[key] = baseline[key]
  }
  return buildReleaseConfig(target, merged)
}

/** @param {string} target @param {string} sourceFile @param {Record<string, string>} config @returns {string} */
function renderReleaseConfig(target, sourceFile, config) {
  const merged = mergeReleaseConfig(target, sourceFile)
  if (
    config.release_batching_schedule &&
    configured(config.release_batching_prerelease, 'true') === 'true'
  ) {
    // Stage privately so publication can set visibility atomically. A polling
    // flagger cannot prevent clients seeing an initially stable release.
    merged.draft = true
    merged['force-tag-creation'] = true
    for (const value of Object.values(merged.packages ?? {})) {
      value.draft = true
      value['force-tag-creation'] = true
    }
  } else {
    const caller = join(target, '.github/workflows/release.yml')
    const previouslyBatched =
      existsSync(caller) &&
      readFileSync(caller, 'utf8').includes(
        "prerelease: ${{ github.event_name != 'workflow_dispatch' }}"
      )
    if (previouslyBatched) {
      merged.draft = false
      for (const value of Object.values(merged.packages ?? {})) value.draft = false
    }
  }
  return `${JSON.stringify(merged, null, 2)}\n`
}

/** @param {string} file @param {string} languages @param {string} features @param {Record<string, string>} config */
function shouldInclude(file, languages, features, config) {
  if (file === 'ruff.toml') return includesValue(languages, 'python')
  if (file === '.oxfmtrc.json' || file === '.oxlintrc.json')
    return includesValue(languages, 'typescript')
  if (file === '.github/dependabot.yml')
    return (
      configured(config.dependency_updater, 'dependabot') === 'dependabot' &&
      includesValue(features, 'dependabot')
    )
  // The OpenCode Security caller is installed in every repository so the
  // OPENCODE_SECURITY repository variable can opt a repository in (or out)
  // without a configuration change. The detect job keeps the scan off unless
  // the configuration or the variable enables it and the API key exists.
  if (file === '.github/workflows/opencode-security.yml') return true
  if (file === '.github/workflows/release-integrity.yml') return true
  const workflow = file.match(/^\.github\/workflows\/([^/]+)\.yml$/)?.[1]
  if (workflow === 'draft-control' || workflow === 'draft-enforcement') {
    return (
      includesValue(features, 'validation') ||
      LEGACY_GENERATED_CALLERS.some((legacy) => includesValue(features, legacy))
    )
  }
  // The staging promotion caller only exists in the staging-release topology;
  // direct repositories open feature branches into main and need no promotion.
  if (workflow === 'release-pr' && !isStagingRelease(config.git_workflow)) return false
  // The tiered validation caller supersedes the legacy ci/test/security/codeql
  // event callers, so legacy feature names keep selecting it.
  if (workflow === 'validation' || workflow === 'validation-audit') {
    return (
      includesValue(features, 'validation') ||
      LEGACY_GENERATED_CALLERS.some((legacy) => includesValue(features, legacy))
    )
  }
  return !workflow || includesValue(features, workflow)
}

/** @param {string} source @param {string} file */
function sourcePath(source, file) {
  if (file === '.gitignore') {
    const rootTemplate = join(source, file)
    return existsSync(rootTemplate) ? rootTemplate : join(source, 'src/templates/gitignore')
  }
  if (file.startsWith('.github/workflows/')) {
    if (file === '.github/workflows/validation-audit.yml') {
      return join(source, 'src/templates/workflows/validation-audit.yml')
    }
    const name = file.slice('.github/workflows/'.length, -4)
    return join(source, '.github/workflows', `${name}_self-ci.yml`)
  }
  return join(source, file)
}

/**
 * The batch-soak promoter for repositories with `release_batching_soak_hours`.
 * Repo-agnostic by construction: every call goes through `$GITHUB_REPOSITORY`.
 * The newest pre-release published after the last stable flips to stable once
 * the batch's oldest member has been public for the soak; skipped intermediates
 * are folded into the promoted release's notes. `__SOAK_HOURS__` is replaced
 * with the configured value at render time.
 */
const PROMOTE_STABLE_TEMPLATE = `# Generated by Code Foundry sync from release_batching_soak_hours; rerun sync after changing or removing the key.

name: Promote stable

on:
  schedule:
    # Daily, shortly after the release window settles. The soak, not the cron,
    # decides when a batch is ready.
    - cron: '53 12 * * *'
  workflow_dispatch:
    inputs:
      version:
        description: Promote this specific version now (for example 0.75.1). Leave empty to follow the soak rule.
        required: false
        type: string
      force:
        description: Promote the newest pre-release regardless of the soak.
        required: false
        type: boolean
        default: false

permissions:
  contents: write
  actions: read

concurrency:
  group: promote-stable
  cancel-in-progress: false

jobs:
  promote:
    name: Apply the promotion policy
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Evaluate the batch and promote the tip
        env:
          GH_TOKEN: \${{ github.token }}
          SOAK_HOURS: '__SOAK_HOURS__'
          QUALIFICATION_WORKFLOW: '__QUALIFICATION_WORKFLOW__'
          VERSION: \${{ inputs.version }}
          FORCE: \${{ inputs.force }}
          STABLE_PROMOTION_HELD: \${{ vars.STABLE_PROMOTION_HELD }}
        run: |
          set -euo pipefail
          repo="$GITHUB_REPOSITORY"
          summary="$GITHUB_STEP_SUMMARY"

          # Force bypasses hold and soak, but never asset qualification.
          require_qualification() {
            [ -z "$QUALIFICATION_WORKFLOW" ] && return 0
            local candidate_sha conclusion
            candidate_sha="$(gh api "repos/$repo/commits/$1" --jq '.sha')" || return 1
            [ -n "$candidate_sha" ] && [ "$candidate_sha" != "null" ] || return 1
            conclusion="$(gh run list --repo "$repo" --workflow "$QUALIFICATION_WORKFLOW" --event release --commit "$candidate_sha" --limit 1 --json conclusion --jq '.[0].conclusion // "missing"')" || return 1
            if [ "$conclusion" != "success" ]; then
              echo "Asset qualification for $1 is $conclusion; holding stable promotion." | tee -a "$summary"
              return 1
            fi
          }

          # The repository variable applies equally to scheduled and manual runs.
          if [ "$STABLE_PROMOTION_HELD" = "true" ] && [ "$FORCE" != "true" ]; then
            echo "Stable promotion is held." | tee -a "$summary"
            exit 0
          fi

          if [ -n "$VERSION" ]; then
            if ! [[ "$VERSION" =~ ^[0-9]+[.][0-9]+[.][0-9]+$ ]]; then
              echo "::error::version must be a plain semantic version" >&2
              exit 1
            fi
            if ! require_qualification "v$VERSION"; then
              echo "Qualification unavailable or unsuccessful; holding v$VERSION." | tee -a "$summary"
              exit 0
            fi
            gh release edit "v$VERSION" --repo "$repo" --prerelease=false --latest
            echo "Promoted v$VERSION to stable by name." | tee -a "$summary"
            exit 0
          fi

          releases="$(mktemp)"
          trap 'rm -f "$releases"' EXIT
          gh api --paginate --slurp "repos/$repo/releases?per_page=100" | jq 'add' > "$releases"

          # The last promoted stable anchors the candidate batch.
          last_stable_published="$(jq -r '
            [ .[] | select(.draft == false and .prerelease == false)
              | select(.tag_name | test("^v[0-9]+[.][0-9]+[.][0-9]+$")) ]
            | sort_by(.published_at) | .[-1].published_at // "null"
          ' "$releases")"
          echo "Last stable published: $last_stable_published"

          # The batch: every non-draft pre-release published since then, with
          # the plain release tag shape (dev builds carry a -dev suffix and
          # live on their own channel forever; they are never promoted).
          batch="$(jq -r --arg last_stable_published "$last_stable_published" '
            [ .[]
              | select(.draft == false and .prerelease == true)
              | select(.tag_name | test("^v[0-9]+[.][0-9]+[.][0-9]+$"))
              | select($last_stable_published == "null" or .published_at > $last_stable_published)
              | { tag: .tag_name, published_at: .published_at, body: .body } ]
            | sort_by(.published_at)
          ' "$releases")"

          oldest="$(jq -r '.[0].published_at // "empty"' <<<"$batch")"
          if [ "$oldest" = "empty" ]; then
            echo "No pre-release batch is waiting; nothing to promote." | tee -a "$summary"
            exit 0
          fi

          oldest_epoch="$(date -d "$oldest" +%s)"
          now_epoch="$(date -u +%s)"
          age_hours=$(( (now_epoch - oldest_epoch) / 3600 ))
          tip="$(jq -r '.[-1].tag' <<<"$batch")"

          if [ "$age_hours" -lt "$SOAK_HOURS" ] && [ "$FORCE" != "true" ]; then
            echo "The batch has soaked \${age_hours}h of \${SOAK_HOURS}h; holding. Tip: $tip" | tee -a "$summary"
            exit 0
          fi

          if ! require_qualification "$tip"; then
            echo "Qualification unavailable or unsuccessful; holding $tip." | tee -a "$summary"
            exit 0
          fi

          # Stitch the batch's notes oldest→newest so the stable release
          # documents everything stable users are getting, not just the tip.
          jq -r '.[] | "## " + .tag + "\\n\\n" + (.body // "")' <<<"$batch" > batch-notes.md
          gh release edit "$tip" --repo "$repo" --prerelease=false --latest --notes-file batch-notes.md
          count="$(jq 'length' <<<"$batch")"
          echo "Promoted $tip to stable: the batch of $count had soaked \${age_hours}h." | tee -a "$summary"
`

/** @param {Record<string, string>} config */
function validateReleaseBatchingConfig(config) {
  const schedule = String(config.release_batching_schedule ?? '').trim()
  if (schedule) {
    const limits = [
      [0, 59],
      [0, 23],
      [1, 31],
      [1, 12],
      [0, 6],
    ]
    const fields = schedule.split(/\s+/)
    const valid =
      fields.length === 5 &&
      fields.every((field, index) => {
        const [min, max] = limits[index]
        return field.split(',').every((part) => {
          const match = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/)
          if (!match || (match[2] && (Number(match[2]) < 1 || Number(match[2]) > max))) return false
          if (match[1] === '*') return true
          const [start, end = start] = match[1].split('-').map(Number)
          return start >= min && end <= max && start <= end
        })
      })
    if (!valid)
      throw new Error(
        `Unsupported release_batching_schedule: ${schedule}; use a five-field numeric cron expression.`
      )
  }
  if (
    config.release_batching_prerelease &&
    !['true', 'false'].includes(config.release_batching_prerelease)
  ) {
    throw new Error(
      `Unsupported release_batching_prerelease: ${config.release_batching_prerelease}; use true or false.`
    )
  }
  if (config.release_batching_qualification_workflow) {
    if (
      !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(config.release_batching_qualification_workflow) ||
      !config.release_batching_soak_hours
    ) {
      throw new Error(
        'Unsupported release_batching_qualification_workflow: use a workflow filename with a batching soak.'
      )
    }
  }
  if (config.release_batching_soak_hours) {
    const hours = Number(config.release_batching_soak_hours)
    if (!Number.isInteger(hours) || hours < 1 || hours > 336) {
      throw new Error(
        `Unsupported release_batching_soak_hours: ${config.release_batching_soak_hours}; use an integer between 1 and 336.`
      )
    }
    if (!schedule || config.release_batching_prerelease === 'false') {
      throw new Error(
        'Unsupported release_batching_soak_hours: configure a batching schedule with prerelease publication.'
      )
    }
  }
  if (
    config.release_batching_dev_channel &&
    !['true', 'false'].includes(config.release_batching_dev_channel)
  ) {
    throw new Error(
      `Unsupported release_batching_dev_channel: ${config.release_batching_dev_channel}; use true or false.`
    )
  }
  if (configured(config.release_batching_dev_channel, 'false') === 'true') {
    if (
      !config.release_batching_dev_workflow ||
      !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(config.release_batching_dev_workflow)
    ) {
      throw new Error(
        'Unsupported release_batching_dev_workflow: use the filename of the workflow_dispatch asset lane the dev build should dispatch.'
      )
    }
  }
  if (config.release_batching_dev_workflow && config.release_batching_dev_channel !== 'true') {
    throw new Error(
      'Unsupported release_batching_dev_workflow: requires release_batching_dev_channel: true.'
    )
  }
}

/** Render the batch-soak promoter for a repository, or null when the
 * repository has not configured a soak.
 *
 * @param {Record<string, string>} config
 * @returns {string | null}
 */
export function renderPromoteStable(config) {
  const soakHours = Number(config.release_batching_soak_hours ?? '')
  if (!Number.isInteger(soakHours) || soakHours < 1 || soakHours > 336) return null
  return PROMOTE_STABLE_TEMPLATE.replaceAll('__SOAK_HOURS__', String(soakHours)).replaceAll(
    '__QUALIFICATION_WORKFLOW__',
    config.release_batching_qualification_workflow ?? ''
  )
}

/**
 * The dev channel for repositories with `release_batching_dev_channel`. Every
 * push to main tags a `v<stable>-dev.<run>` pre-release on top of the newest
 * stable and dispatches the repository's own asset lane with a `version`
 * input; the oldest dev builds are pruned so the channel stays bounded. Dev
 * builds are never promoted: the batch-soak promoter's batch selector already
 * excludes `-dev.` tags, so the channel lives beside stable forever.
 * `__DEV_WORKFLOW__` is replaced with the configured asset lane at render
 * time; the lane stays app-provided because packaging differs per app.
 */
const DEV_CHANNEL_TEMPLATE = `# Generated by Code Foundry sync from release_batching_dev_channel; rerun sync after changing or removing the key.

name: Publish dev channel

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      version:
        description: Publish this dev version now (for example v0.75.1-dev.42). Leave empty to derive it from the newest stable.
        required: false
        type: string

permissions:
  contents: write
  actions: write

concurrency:
  group: dev-channel
  cancel-in-progress: false

jobs:
  publish:
    name: Tag the dev build and dispatch the asset lane
    # Auto dev builds pause with the shared billing pause; the manual dispatch
    # (the repair path) still runs.
    if: github.event_name == 'workflow_dispatch' || vars.CI_BILLING_PAUSED != 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Publish the dev prerelease and dispatch the asset lane
        env:
          GH_TOKEN: \${{ github.token }}
          DEV_WORKFLOW: '__DEV_WORKFLOW__'
          REQUESTED: \${{ inputs.version }}
        run: |
          set -euo pipefail
          repo="$GITHUB_REPOSITORY"
          if [ -n "$REQUESTED" ]; then
            tag="$REQUESTED"
          else
            stable="$(gh api --paginate --slurp "repos/$repo/releases?per_page=100" | jq -r '
              [ .[] | select(.draft == false and .prerelease == false)
                | select(.tag_name | test("^v[0-9]+[.][0-9]+[.][0-9]+$")) ]
              | sort_by(.published_at) | .[-1].tag_name // empty')"
            if [ -z "$stable" ]; then
              echo "No stable release exists yet; a dev channel needs a stable baseline." | tee "$GITHUB_STEP_SUMMARY"
              exit 0
            fi
            tag="\${stable}-dev.\${GITHUB_RUN_NUMBER}"
          fi
          if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
            echo "$tag already exists; nothing to do." | tee "$GITHUB_STEP_SUMMARY"
            exit 0
          fi
          gh release create "$tag" --repo "$repo" --prerelease --target "$GITHUB_SHA" \
            --title "$tag" --notes "Dev build of \${GITHUB_SHA::7}; a dev-channel build is never promoted to stable."
          gh workflow run "$DEV_WORKFLOW" --repo "$repo" --ref main -f version="$tag"
          echo "Dispatched $DEV_WORKFLOW for $tag." | tee "$GITHUB_STEP_SUMMARY"

          # Keep the channel bounded: the newest dev builds stay, the rest go.
          gh api --paginate --slurp "repos/$repo/releases?per_page=100" | jq -r '
            [ .[] | select(.draft == false and .prerelease == true)
              | select(.tag_name | test("^v[0-9]+[.][0-9]+[.][0-9]+-dev[.][0-9]+$")) ]
            | sort_by(.created_at) | reverse | .[3:] | .[].tag_name' | while read -r stale; do
            echo "Pruning $stale."
            gh release delete "$stale" --repo "$repo" --yes --cleanup-tag
          done
`

/**
 * Render the dev channel workflow for a repository, or null when the
 * repository has not opted in.
 *
 * @param {Record<string, string>} config
 * @returns {string | null}
 */
export function renderDevChannel(config) {
  if (configured(config.release_batching_dev_channel, 'false') !== 'true') return null
  return DEV_CHANNEL_TEMPLATE.replaceAll(
    '__DEV_WORKFLOW__',
    config.release_batching_dev_workflow ?? ''
  )
}

/**
 * @param {string} content
 * @param {Record<string,string>} config
 * @param {string} repository
 * @param {string} ref
 * @param {{ shards: string, threads: string, maxParallel: string }} rustCodeql
 * @param {string} file
 * @param {boolean} selfRepository
 */
function renderWorkflow(content, config, repository, ref, rustCodeql, file, selfRepository) {
  const localPrefix = 'uses: ./.github/workflows/'
  const remotePrefix = `uses: ${repository}/.github/workflows/`
  let rendered = content.replaceAll(localPrefix, remotePrefix)
  // An explicitly unavailable CodeQL capability selects an orchestrator that
  // omits the job entirely, so GitHub does not register a misleading skipped
  // check on every pull request or an unused main-push run. `auto` retains
  // runtime capability detection.
  if (configured(config.codeql, 'auto') === 'false') {
    rendered = rendered.replaceAll(
      `${remotePrefix}validation.yml`,
      `${remotePrefix}validation-no-codeql.yml`
    )
    rendered = removeWorkflowBlock(rendered, 'default-branch-codeql')
    // Only the validation caller's default-branch trigger is tied to CodeQL.
    // Draft-PR, release, and other callers still need their own push triggers.
    if (file === '.github/workflows/validation.yml')
      rendered = removeWorkflowBlock(rendered, 'push')
  }
  // Billing-lane orchestrator: repositories whose Actions minutes are billed
  // can opt into the merged-lane variant, which keeps the same coverage and
  // gate vocabulary but shares one runner across the sub-minute lanes so
  // whole-minute rounding stops dominating the invoice. The `codeql` input
  // replaces the two-orchestrator split, so this mapping runs after the
  // CodeQL selection above and preserves its push-trigger pruning.
  if (configured(config.billing_lanes, 'false') === 'true') {
    rendered = rendered.replaceAll(
      `${remotePrefix}validation-no-codeql.yml`,
      `${remotePrefix}validation-billing.yml`
    )
    rendered = rendered.replaceAll(
      `${remotePrefix}validation.yml`,
      `${remotePrefix}validation-billing.yml`
    )
    rendered = rendered.replace(
      new RegExp(`(${escapeRegExp(remotePrefix)}validation-billing\\.yml\\n    with:\\n)`),
      // The `codeql` input is boolean-typed: GitHub rejects a quoted string
      // at workflow load with a startup_failure, so emit YAML booleans.
      `$1      codeql: ${configured(config.codeql, 'auto') === 'false' ? 'false' : 'true'}\n`
    )
  }
  rendered = rendered.replace(
    new RegExp(`${escapeRegExp(remotePrefix)}([^\\s@]+)`, 'g'),
    `$&@${ref}`
  )
  // Pin every runtime reference in the rendered caller: the orchestrator input
  // in the `with:` block and the mode job's runtime checkout. Self templates
  // use ${{ github.sha }} and are only rewritten when rendered for consumers.
  rendered = rendered.replace(/^(\s+runtime-ref:)\s+.*$/gm, `$1 ${ref}`)
  rendered = rendered.replace(/^(\s+ref:)\s+\$\{\{\s*github\.sha\s*\}\}\s*$/gm, `$1 ${ref}`)
  rendered = rendered.replace(/^(\s+runtime-repository:)\s+.*$/gm, `$1 ${repository}`)
  rendered = rendered.replace(
    new RegExp(`^(\\s+repository:)\\s+0xPlayerOne\\/code-foundry\\s*$`, 'gm'),
    `$1 ${repository}`
  )
  /** @type {Record<string, string|undefined>} */
  const runners = {
    ci: config.ci_runner ?? config.runner,
    test: config.test_runner ?? config.runner,
    security: config.security_runner ?? config.runner,
    codeql: config.codeql_runner ?? config.runner,
    'draft-pr': config.pr_runner ?? config.runner,
    'release-pr': config.pr_runner ?? config.runner,
    release: config.release_runner ?? config.runner,
  }
  const workflow = file.match(/^\.github\/workflows\/([^/]+)\.yml$/)?.[1]
  if (workflow === 'release' && !selfRepository) {
    rendered = rendered.replace(
      /^(\s+runtime-ref:)\s+.*$/m,
      `$1 ${ref}\n      git-workflow: ${isStagingRelease(config.git_workflow) ? 'staging-release' : 'direct'}`
    )
  }
  // Generated PR callers protect drafts by default. Consumers that intentionally
  // run gates while a PR is still draft can opt out in code-foundry.yml.
  if (configured(config.draft_protection, 'true') === 'false') {
    rendered = rendered.replaceAll(' && github.event.pull_request.draft == false', '')
  }
  // E2E sharding fans the managed E2E job into one runner per shard; shards
  // stay isolated because each job owns a runner-local test database. Fail
  // closed on a malformed count rather than silently rendering a single shard.
  const e2eShards =
    config.e2e_shards === undefined || config.e2e_shards === '' ? 1 : Number(config.e2e_shards)
  if (!Number.isInteger(e2eShards) || e2eShards < 1 || e2eShards > 8) {
    throw new Error(`Unsupported e2e_shards: ${config.e2e_shards}; use an integer between 1 and 8.`)
  }
  if (e2eShards > 1 && file === '.github/workflows/validation.yml') {
    rendered = rendered.replace(
      /^(\s+e2e-shard-list:)\s+.*$/gm,
      `$1 ${Array.from({ length: e2eShards }, (_, index) => index + 1).join(',')}`
    )
    rendered = rendered.replace(/^(\s+e2e-total-shards:)\s+.*$/gm, `$1 ${e2eShards}`)
  }
  // Consumer release callers are generic package release workflows. The
  // installed-consumer qualification harness is specific to Code Foundry's
  // own package and must remain in the self workflow rather than being
  // rendered into every consumer's release caller.
  if (workflow === 'release' && !selfRepository) {
    // The self caller owns qualification, immutability preflight, draft
    // recovery, staging, and qualified publication. Consumer callers must
    // retain the ordinary reusable Release Please path instead of inheriting
    // self-only jobs whose outputs and environments do not exist for them.
    for (const job of ['qualification', 'preflight', 'recovery', 'stage', 'publish'])
      rendered = removeWorkflowBlock(rendered, job)
    rendered = rendered.replace(/^    needs: \[preflight\]\n/m, '')
    rendered = rendered.replace(/^      config-file: \.github\/release-please-foundry\.json\n/m, '')
    rendered = rendered.replace(/^      defer-publication: true\n/m, '')
    rendered = rendered.replace(
      /^    if: github\.ref == 'refs\/heads\/main' && \(vars\.CI_BILLING_PAUSED != 'true' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\['release-while-paused'\] == true\)\)\n/m,
      "    if: vars.CI_BILLING_PAUSED != 'true' || (github.event_name == 'workflow_dispatch' && inputs['release-while-paused'] == true)\n"
    )
    rendered = rendered.replace(
      /^    if: github\.ref == 'refs\/heads\/main' && \(vars\.CI_BILLING_PAUSED != 'true' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\['release-while-paused'\] == true\)\)\n/m,
      "    if: vars.CI_BILLING_PAUSED != 'true' || (github.event_name == 'workflow_dispatch' && inputs['release-while-paused'] == true)\n"
    )
    // Gate ordinary pushes while allowing the release squash and manual hotfixes.
    const batchingSchedule = String(config.release_batching_schedule ?? '').trim()
    if (batchingSchedule) {
      rendered = rendered.replace(
        '  workflow_dispatch:',
        `  schedule:\n    - cron: '${batchingSchedule}'\n  workflow_dispatch:`
      )
      rendered = rendered.replace(
        "    if: vars.CI_BILLING_PAUSED != 'true' || (github.event_name == 'workflow_dispatch' && inputs['release-while-paused'] == true)\n",
        "    if: >-\n      (vars.CI_BILLING_PAUSED != 'true' || (github.event_name == 'workflow_dispatch' && inputs['release-while-paused'] == true)) && (github.event_name != 'push' || startsWith(github.event.head_commit.message, 'chore(main): release '))\n"
      )
      if (configured(config.release_batching_prerelease, 'true') === 'true') {
        rendered = rendered.replace(
          '      git-workflow:',
          "      prerelease: ${{ github.event_name != 'workflow_dispatch' }}\n      git-workflow:"
        )
      }
    }
    rendered = rendered.replace(
      /(\n    secrets:\n      CODE_FOUNDRY_TOKEN: \$\{\{ secrets\.CODE_FOUNDRY_TOKEN \}\}\n)/,
      '$1      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\n'
    )
  }
  // The staging-release topology validates and scans pull requests against
  // both main and the integration branch; direct repositories only ever
  // target main, so their callers trigger on main alone.
  if (!isStagingRelease(config.git_workflow)) {
    rendered = rendered.replace(/^(\s+branches:)\s*\[main,\s*staging\]\s*$/gm, `$1 [main]`)
    // Direct repositories have no staging branch or release reconciliation,
    // so their generated release caller must not expose the legacy deploy-key
    // secret. Keep it in the staging-release template for repositories that
    // still explicitly select that topology.
    if (workflow === 'release') {
      rendered = rendered.replace(
        /^\s+STAGING_DEPLOY_KEY:\s+\$\{\{\s*secrets\.STAGING_DEPLOY_KEY\s*\}\}\s*\n/m,
        ''
      )
    }
  } else if (workflow === 'release' && !rendered.includes('STAGING_DEPLOY_KEY')) {
    rendered = rendered.replace(
      /^(\s+)CODE_FOUNDRY_TOKEN:\s+\$\{\{\s*secrets\.CODE_FOUNDRY_TOKEN\s*\}\}\s*$/m,
      '$&\n$1STAGING_DEPLOY_KEY: ${{ secrets.STAGING_DEPLOY_KEY }}'
    )
  }
  if (workflow === 'draft-pr') {
    // The draft PR caller states the PR base explicitly so the shared
    // reusable workflow creates pull requests against the repository's
    // configured integration branch (staging) or main (direct).
    rendered = rendered.replace(
      /^(\s+base:)\s+.*$/m,
      `$1 ${isStagingRelease(config.git_workflow) ? 'staging' : 'main'}`
    )
  }
  const runner = workflow ? runners[workflow] : undefined
  if (runner) rendered = rendered.replace(/^(\s+runner:)\s+.*$/m, `$1 ${runner}`)
  if (workflow === 'test' && config.unit_runner) {
    rendered = rendered.replace(/^(\s+unit-runner:)\s+.*$/m, `$1 ${config.unit_runner}`)
  }
  if (workflow === 'validation' || workflow === 'validation-audit') {
    // The mode classifier is a normal runner job in the caller rather than a
    // reusable-workflow input. Keep it on the configured default runner so
    // consumers that cannot use ubuntu-slim do not fail before validation.
    if (config.runner) {
      rendered = rendered.replace(/^(\s+runs-on:)\s+.*$/m, `$1 ${config.runner}`)
    }
    /** @type {Record<string, string|undefined>} */
    const runnerInputs = {
      'ci-runner': config.ci_runner ?? config.runner,
      'test-runner': config.test_runner ?? config.runner,
      'security-runner': config.security_runner ?? config.runner,
      'codeql-runner': config.codeql_runner ?? config.runner,
      'unit-runner': config.unit_runner,
      'performance-runner': config.performance_runner ?? config.test_runner ?? config.runner,
      'eval-runner': config.eval_runner ?? config.runner,
    }
    for (const [input, value] of Object.entries(runnerInputs)) {
      if (!value) continue
      rendered = rendered.replace(new RegExp(`^(\\s+${input}:)\\s+.*$`, 'm'), `$1 ${value}`)
    }
    // Every Rust CodeQL lane in the caller must carry the configured shard
    // list. A SARIF category is derived from the shard string, so a caller that
    // renders the configuration into the pull-request lane while a second lane
    // keeps the template literal makes the two lanes report disjoint
    // categories. The default-branch baseline then never matches the pull
    // request, and the code-scanning gate stalls every merge while every
    // required check passes. Shards partition one scan, so the same list is
    // correct in both lanes: `["all"]` stays a single pass, and a real shard
    // list splits the same work in both places.
    rendered = rendered.replace(/^(\s+rust-shards:)\s+.*$/gm, `$1 '${rustCodeql.shards}'`)
    rendered = rendered.replace(/^(\s+rust-threads:)\s+.*$/gm, `$1 '${rustCodeql.threads}'`)
    rendered = rendered.replace(/^(\s+rust-max-parallel:)\s+.*$/gm, `$1 ${rustCodeql.maxParallel}`)
  }
  if (workflow === 'codeql') {
    rendered = rendered.replace(/^(\s+rust-shards:)\s+.*$/gm, `$1 '${rustCodeql.shards}'`)
    rendered = rendered.replace(/^(\s+rust-threads:)\s+.*$/gm, `$1 '${rustCodeql.threads}'`)
    rendered = rendered.replace(/^(\s+rust-max-parallel:)\s+.*$/gm, `$1 ${rustCodeql.maxParallel}`)
  }
  if (workflow === 'opencode-security') {
    const model = configured(config.opencode_security_model, '').trim()
    if (model) rendered = rendered.replace(/^(\s+model:)\s+.*$/m, `$1 ${model}`)
  }
  return rendered
}

/**
 * Remove a root-level YAML block by id while preserving the surrounding file.
 * This is used for workflow jobs and triggers whose feature is disabled by
 * configuration.
 * @param {string} content
 * @param {string} blockId
 * @returns {string}
 */
function removeWorkflowBlock(content, blockId) {
  const lines = content.split('\n')
  const start = lines.findIndex((line) => line === `  ${blockId}:`)
  if (start === -1) return content
  let end = start + 1
  while (end < lines.length && !/^  [A-Za-z0-9_-]+:\s*$/.test(lines[end])) end += 1
  lines.splice(start, end - start)
  if (content.endsWith('\n') && lines.at(-1) !== '') lines.push('')
  return lines.join('\n')
}

/**
 * Dependabot updates land on the repository's integration branch. Direct
 * repositories have no staging branch, so every update targets main. The
 * JavaScript ecosystem block ships as `bun` (the fleet default) and is
 * retargeted to `npm` for consumers whose `package_manager` is npm; Cargo,
 * the JavaScript block, and pip updates are emitted only when Rust,
 * TypeScript, or Python is part of the configured language set,
 * respectively; weekly updater runs fail when an ecosystem has no manifests
 * to read, so unconfigured ecosystems are dropped instead of left to error.
 *
 * The billing pause must also cover Dependabot: its update runs execute as
 * Actions workflows under the `dynamic` event, so the `CI_BILLING_PAUSED`
 * repository variable that gates every workflow job cannot stop them. When
 * `billing_paused: true` is configured, version updates are disabled by
 * rendering `open-pull-requests-limit: 0` and dropping the cadence to
 * monthly; `schedule` is a required key, so the ecosystem blocks stay
 * structurally valid and a later sync with the flag removed restores the
 * template verbatim.
 * @param {string} content
 * @param {Record<string,string>} config
 * @param {string} languages
 * @returns {string}
 */
export function renderDependabot(content, config, languages) {
  let rendered = content
  if (!includesValue(languages, 'rust')) {
    rendered = stripDependabotEcosystem(rendered, 'cargo')
  }
  if (!includesValue(languages, 'typescript')) {
    rendered = stripDependabotEcosystem(rendered, 'bun')
  }
  if (!includesValue(languages, 'python')) {
    rendered = stripDependabotEcosystem(rendered, 'pip')
  }
  if (
    includesValue(languages, 'typescript') &&
    configured(config.package_manager, 'bun') === 'npm'
  ) {
    // The template tracks the fleet's bun majority; an npm-locked consumer
    // needs the npm ecosystem or Dependabot fails with misconfigured_tooling
    // (it cannot read bun.lock).
    rendered = swapBunEcosystemForNpm(rendered)
  }
  if (configured(config.billing_paused, 'false') === 'true') {
    rendered = pauseDependabot(rendered)
  }
  if (isStagingRelease(config.git_workflow)) return rendered
  return rendered.replaceAll('target-branch: staging', 'target-branch: main')
}

/**
 * Retarget the JavaScript ecosystem block to npm for npm-locked consumers.
 * Exact-string based so template drift fails loudly at Dependabot time
 * instead of silently scanning the wrong lockfile.
 * @param {string} content
 * @returns {string}
 */
function swapBunEcosystemForNpm(content) {
  return content
    .replace('  - package-ecosystem: bun\n', '  - package-ecosystem: npm\n')
    .replace('      bun-dependencies:\n', '      npm-dependencies:\n')
}

/**
 * Disable Dependabot version updates for every remaining ecosystem. The
 * transformations are regex-based so they hold for any ecosystem count and
 * any future template default; an unchanged file after both replacements
 * means the template stopped defining schedules or limits, which is a loud
 * template drift the next sync test will catch.
 * @param {string} content
 * @returns {string}
 */
function pauseDependabot(content) {
  const limited = content.replace(
    /^(\s*)open-pull-requests-limit:\s*\d+\s*$/gm,
    `$1open-pull-requests-limit: 0 # billing_paused: version updates disabled`
  )
  return limited.replace(
    /^(\s*)interval:\s*weekly\s*$/gm,
    `$1interval: monthly # billing_paused: reduced cadence`
  )
}

/**
 * Remove one package-ecosystem update block from a dependabot template.
 * Blocks are split on their leading list marker so removal never disturbs
 * neighboring ecosystems or the file header.
 * @param {string} content
 * @param {string} ecosystem
 * @returns {string}
 */
function stripDependabotEcosystem(content, ecosystem) {
  return content
    .split(/(?=^  - package-ecosystem: )/m)
    .filter((block) => !block.startsWith(`  - package-ecosystem: ${ecosystem}\n`))
    .join('')
}

/**
 * Contribution policy documents describe the repository's branch flow. The
 * canonical templates describe the staging-release topology (this runtime
 * itself uses it); direct repositories render the equivalent main-targeting
 * policy. The transformation is exact-string based so any template drift
 * fails loudly (a missed replacement leaves staging prose intact) instead of
 * producing a partial hybrid.
 * @param {string} content
 * @param {string} file
 * @param {Record<string,string>} config
 * @returns {string}
 */
export function renderContributionDocs(content, file, config) {
  const replacements = DIRECT_DOC_REPLACEMENTS[file]
  if (!replacements) return content
  let rendered = content
  const stagingRelease = isStagingRelease(config.git_workflow)
  for (const [staging, direct] of replacements) {
    const from = stagingRelease ? direct : staging
    const to = stagingRelease ? staging : direct
    if (rendered.includes(from)) {
      rendered = rendered.replace(from, to)
    } else if (!rendered.includes(to)) {
      throw new Error(
        `Missing ${stagingRelease ? 'staging-release' : 'direct'} workflow template marker in ${file}: ${JSON.stringify(from)}`
      )
    }
  }
  if (stagingRelease && configured(config.staging_validation_mode, 'fast') === 'audit') {
    rendered = rendered.replace(
      'Fast validation: CI plus unit tests, ending in `Validation / Gate`',
      'Audit validation: CI, full tests, Security, and CodeQL, ending in `Validation / Gate`'
    )
  }
  return rendered
}

/** @type {Record<string, Array<[string, string]>>} */
const DIRECT_DOC_REPLACEMENTS = {
  'AGENTS.md': [
    [
      'For normal feature work, branch from `staging` and target pull requests at `staging`. Treat `main` as the protected release branch.',
      'For normal feature work, branch from `main` and target pull requests at `main`. Treat `main` as the protected release branch.',
    ],
    [
      'Use `push` for `main, staging` and `pull_request` for `staging` unless a workflow has a documented event-specific reason.',
      'Use `push` for `main` and `pull_request` for `main` unless a workflow has a documented event-specific reason.',
    ],
    [
      'This repository uses the `staging-release` workflow: topic branches **squash** into `staging`, a promotion PR **rebases** validated changes into `main` (`merge_strategy: rebase`), and the Release Please version PR **rebases** into `main` (`release_merge_strategy: rebase`). Feature PRs land on `staging` with squash merges; promotion and release PRs land on `main` with rebase merges. Re-align `staging` with `main` after a release when needed.',
      'This repository uses the `direct` workflow: topic branches **squash** directly into `main`, and the Release Please version PR **squashes** into `main` (`release_merge_strategy: squash`). Feature and release PRs land on `main` with squash merges. No integration branch exists; all pull requests target `main`.',
    ],
    [
      'This repository uses the `staging-release` workflow. Topic pull requests target `staging`; promotion pull requests target `main`.',
      'This repository uses the `direct` workflow. Topic pull requests target `main`.',
    ],
  ],
  '.github/CONTRIBUTING.md': [
    [
      'This repository uses the `staging-release` workflow. Topic pull requests target `staging`; promotion pull requests target `main`.',
      'This repository uses the `direct` workflow. Topic pull requests target `main`.',
    ],
    [
      '4. Branch from `staging` and target pull requests at `staging`; do not work directly on `main`.',
      '4. Branch from `main` and target pull requests at `main`; do not push directly to `main`.',
    ],
    [
      '```text\n                                      release PR\n                                   ┌──────────────┐\n                                   │              ▼\nfeat/*  fix/*  chore/*  ──PR──▶  staging  ──PR──▶  main\ndocs/*  test/*  refactor/*         │              │\n                                   │              └── protected release branch\n                                   └── integration branch\n```',
      '```text\n                              release PR\n                           ┌──────────────┐\n                           │              ▼\nfeat/*  fix/*  chore/*  ──PR──▶  main\ndocs/*  test/*  refactor/*         │\n                                   └── protected release branch\n```',
    ],
    [
      '| Branch                                                         | Purpose                  | Contribution rule                                                         |\n| -------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------- |\n| `main`                                                         | Protected release branch | Merge through the `staging` → `main` release PR. No direct pushes.        |\n| `staging`                                                      | Integration branch       | Target normal pull requests here. Required checks must pass before merge. |\n| `feat/*`, `fix/*`, `chore/*`, `refactor/*`, `docs/*`, `test/*` | Focused work             | Branch from `staging`; keep changes small and reviewable.                 |\n',
      '| Branch                                                         | Purpose                  | Contribution rule                                      |\n| -------------------------------------------------------------- | ------------------------ | ------------------------------------------------------ |\n| `main`                                                         | Protected release branch | Merge through pull requests only. No direct pushes.    |\n| `feat/*`, `fix/*`, `chore/*`, `refactor/*`, `docs/*`, `test/*` | Focused work             | Branch from `main`; keep changes small and reviewable. |\n',
    ],
    [
      'The Git workflow is `staging-release`: topic branches **squash** into `staging`, a promotion PR **rebases** validated changes into `main` (`merge_strategy: rebase`), and the Release Please version PR **rebases** into `main` (`release_merge_strategy: rebase`). Release automation never defaults to a merge method and never merges with `--admin`; `code-foundry doctor` and `code-foundry sync` fail closed on any other merge strategy. Re-align `staging` with `main` after a release when needed.',
      'The Git workflow is `direct`: topic branches **squash** directly into `main`, and the Release Please version PR **squashes** into `main` (`release_merge_strategy: squash`). Release automation never defaults to a merge method and never merges with `--admin`; `code-foundry doctor` and `code-foundry sync` fail closed on any other release merge strategy. This repository has one protected integration and release branch: `main`.',
    ],
    [
      'git switch staging\ngit pull --ff-only origin staging',
      'git switch main\ngit pull --ff-only origin main',
    ],
    ['1. Start from an up-to-date `staging` branch.', '1. Start from an up-to-date `main` branch.'],
    [
      '8. Push the branch and open a pull request into `staging`.',
      '8. Push the branch and open a pull request into `main`.',
    ],
    [
      '10. Merge with a squash after required checks pass and the change is ready; feature PRs land on `staging` with squash merges.',
      '10. Merge with a squash after required checks pass and the change is ready; feature PRs land on `main` with squash merges.',
    ],
    ['3. Branch from the upstream `staging` branch.', '3. Branch from the upstream `main` branch.'],
    [
      '7. Push to the fork and open a pull request targeting `staging`.',
      '7. Push to the fork and open a pull request targeting `main`.',
    ],
    [
      '| Event                                              | Expected automation                                                                   |\n| -------------------------------------------------- | ------------------------------------------------------------------------------------- |\n| Draft pull request targeting `staging`             | No runner-heavy validation; run local checks before requesting review                 |\n| Ready pull request targeting `staging`             | Fast validation: CI plus unit tests, ending in `Validation / Gate`                    |\n| Draft ordinary pull request targeting `main`       | No runner-heavy validation; run local checks before requesting review                 |\n| Ready ordinary pull request targeting `main`       | Audit validation: CI, full tests, Security, and CodeQL, ending in `Validation / Gate` |\n| Exact Release Please pull request targeting `main` | Full validation: CI, full tests, Security, and CodeQL, ending in `Validation / Gate`  |\n| Scheduled or manual validation                     | Full audit tier                                                                       |\n| Push to a working branch                           | Draft PR workflow                                                                     |\n| Push to `staging`                                  | Promotion PR workflow; canonical validation waits for the PR event                    |\n| Push to `main`                                     | Release workflow; CodeQL skips release-only merges (audit covers drift)               |\n',
      '| Event                                              | Expected automation                                                                   |\n| -------------------------------------------------- | ------------------------------------------------------------------------------------- |\n| Draft pull request targeting `main`                | No runner-heavy validation; run local checks before requesting review                 |\n| Ready pull request targeting `main`                | Audit validation: CI, full tests, Security, and CodeQL, ending in `Validation / Gate` |\n| Exact Release Please pull request targeting `main` | Full validation: CI, full tests, Security, and CodeQL, ending in `Validation / Gate`  |\n| Scheduled or manual validation                     | Full audit tier                                                                       |\n| Push to a working branch                           | Draft PR workflow                                                                     |\n| Push to `main`                                     | Release workflow; CodeQL skips release-only merges (audit covers drift)               |\n',
    ],
    [
      '| Change                       | Target    | Merge method                                    | Merge gate                                                |\n| ---------------------------- | --------- | ----------------------------------------------- | --------------------------------------------------------- |\n| Working branch               | `staging` | Squash                                          | All applicable required checks pass                       |\n| `staging` → `main` promotion | `main`    | Rebase (`merge_strategy`)                       | Current staging checks, release review, and rollout notes |\n| Release Please version PR    | `main`    | Rebase (`release_merge_strategy`, fails closed) | Validation gate and release policy pass                   |\n',
      '| Change                    | Target | Merge method                      | Merge gate                              |\n| ------------------------- | ------ | --------------------------------- | --------------------------------------- |\n| Working branch            | `main` | Squash                            | All applicable required checks pass     |\n| Release Please version PR | `main` | Squash (`release_merge_strategy`) | Validation gate and release policy pass |\n',
    ],
    [
      'Draft pull requests do not start runner-heavy validation unless `draft_protection: false` is configured for generated callers. The lightweight Draft Guard converts ordinary pull requests opened or reopened while ready back to draft; it never checks out pull-request code and it excludes Release Please version heads, whose release workflow owns their state. Marking a pull request ready for review starts the applicable validation tier, and each new commit on a ready pull request reruns that tier for the current head. Draft updates allocate no validation runner while protection is enabled. Converting a pull request to draft cancels in-flight validation through the lightweight cancellation control.',
      'Draft pull requests do not start validation unless `draft_protection: false` is configured. The lightweight Draft Guard converts ordinary pull requests opened or reopened while ready back to draft; it never checks out pull-request code and it excludes Release Please version heads, whose release workflow owns their state. Marking a pull request ready for review starts the applicable validation tier, and each new commit on a ready pull request reruns that tier for the current head. Draft updates allocate no validation runner while protection is enabled. Converting a pull request to draft runs only the lightweight cancellation control.',
    ],
    ['1. Create a focused branch from `staging`.', '1. Create a focused branch from `main`.'],
  ],
  '.github/SECURITY.md': [
    [
      'The latest commit on `staging` receives security patches. Patches are promoted to `main` through the next release cycle.',
      'The latest commit on `main` receives security patches.',
    ],
    ['| `staging`        | ✅        |\n', ''],
  ],
}

/** @param {Record<string,string>} config */
function validateRustCodeqlConfig(config) {
  const threads = configured(config.codeql_rust_threads, '1')
  const maxParallel = configured(config.codeql_rust_max_parallel, '1')
  if (!/^(?:[1-9]|[1-5][0-9]|6[0-4])$/.test(threads)) {
    throw new Error('Unsupported codeql_rust_threads; use an integer from 1 to 64.')
  }
  if (!/^(?:[1-8])$/.test(maxParallel)) {
    throw new Error('Unsupported codeql_rust_max_parallel; use an integer from 1 to 8.')
  }

  const rawShards = configured(config.codeql_rust_shards, '["all"]')
  let shards
  try {
    shards = JSON.parse(rawShards)
  } catch {
    throw new Error('Invalid codeql_rust_shards; use a JSON array of relative Rust source paths.')
  }
  if (!Array.isArray(shards) || shards.length === 0 || shards.length > 8) {
    throw new Error('Invalid codeql_rust_shards; configure between 1 and 8 shards.')
  }
  const seen = new Set()
  for (const shard of shards) {
    if (typeof shard !== 'string' || shard.length === 0 || shard.length > 512 || seen.has(shard)) {
      throw new Error('Invalid codeql_rust_shards; shards must be unique non-empty strings.')
    }
    seen.add(shard)
    if (shard === 'all') continue
    for (const candidate of shard.split(',')) {
      const path = candidate.trim()
      if (
        !path ||
        path.startsWith('/') ||
        path.split('/').includes('..') ||
        !/^[A-Za-z0-9._/@+ -]+$/.test(path)
      ) {
        throw new Error(`Invalid Rust CodeQL shard path: ${path || '(empty)'}`)
      }
    }
  }
  // "all" combined with scoped shards is a deliberate consumer strategy: the
  // broad pass keeps the workspace-level SARIF category reporting while the
  // scoped shards add per-manifest detail. The renderer forwards the same
  // list to every lane, so lane parity holds regardless of the combination.
  return { shards: JSON.stringify(shards), threads, maxParallel }
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Recognize a Code Foundry-generated legacy event caller (the consumer copies
 * of the old ci/test/security/codeql callers). Recognition is structural and
 * end-to-end: the generated name, a thin caller with no steps or runs-on, the
 * runtime wiring, a single job named after the workflow, and a pinned remote
 * reference to the runtime's reusable workflow. Anything else is treated as a
 * repository-owned workflow and preserved byte-for-byte.
 * @param {string|Buffer} content
 * @param {string} stem
 * @param {string} runtimeRepository
 * @returns {boolean}
 */
export function isGeneratedEventCaller(content, stem, runtimeRepository) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content)
  // Generated callers carried the shared display name "Code Foundry" before
  // issue 609 gave each caller a unique name; both renders must stay
  // recognizable so a topology switch can still prune stale promotion callers.
  const names = ['Code Foundry', ...(stem === 'release-pr' ? ['Code Foundry Promotion'] : [])]
  if (!names.some((name) => new RegExp(`^name:\\s*${escapeRegExp(name)}\\s*$`, 'm').test(text)))
    return false
  if (/^\s*(runs-on|steps):/m.test(text)) return false
  // Older generated staging-promotion callers predate the explicit runtime
  // repository input. They are still safe to identify structurally by their
  // single reusable-workflow job so direct-topology syncs can remove them.
  if (stem !== 'release-pr' && !text.includes('runtime-repository:')) return false
  if (!new RegExp(`^  ${stem}:`, 'm').test(text)) return false
  return new RegExp(
    `uses:\\s*${escapeRegExp(runtimeRepository)}/\\.github/workflows/${stem}\\.yml@`
  ).test(text)
}

/** @param {string} baseline @param {string} existing */
function mergeGitignore(baseline, existing) {
  const marker = '# Repository-specific rules'
  const markerIndex = existing.indexOf(marker)
  const head = markerIndex >= 0 ? existing.slice(0, markerIndex) : existing
  const customSection = markerIndex >= 0 ? existing.slice(markerIndex + marker.length).trim() : ''
  const baselineLines = new Set(
    baseline
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  )
  // Preserve consumer-owned entries the baseline does not define, including
  // the comments that introduce them, so a sync never silently drops
  // repository-specific ignore rules that live outside the managed section
  // (for example Cloudflare or framework build output added by the repo).
  /** @type {string[]} */
  const preserved = []
  /** @type {string[]} */
  let pending = []
  for (const line of head.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      pending.push(line)
      continue
    }
    if (baselineLines.has(trimmed)) {
      pending = []
      continue
    }
    preserved.push(...pending, line)
    pending = []
  }
  /** @type {string[]} */
  const customLines = []
  const seen = new Set()
  for (const line of [...preserved, ...(customSection ? customSection.split(/\r?\n/) : [])]) {
    const trimmed = line.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    customLines.push(line)
  }
  return customLines.length
    ? `${baseline.trimEnd()}\n\n${marker}\n${customLines.join('\n')}\n`
    : baseline
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {string} source @returns {string} */
function stripJsonComments(source) {
  const output = []
  let inString = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (inString) {
      output.push(char)
      if (char === '\\' && next !== undefined) {
        output.push(next)
        index += 1
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      output.push(char)
      continue
    }
    if (char === '/' && next === '/') {
      output.push(' ', ' ')
      index += 2
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
        output.push(' ')
        index += 1
      }
      index -= 1
      continue
    }
    if (char === '/' && next === '*') {
      output.push(' ', ' ')
      index += 2
      while (index < source.length) {
        const commentChar = source[index]
        const commentNext = source[index + 1]
        if (commentChar === '*' && commentNext === '/') {
          output.push(' ', ' ')
          index += 1
          break
        }
        output.push(commentChar === '\n' || commentChar === '\r' ? commentChar : ' ')
        index += 1
      }
      continue
    }
    output.push(char)
  }
  return output.join('')
}

/** @param {string} source @returns {string} */
function stripJsonTrailingCommas(source) {
  const output = []
  let inString = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      output.push(char)
      if (char === '\\') {
        const escaped = source[index + 1]
        if (escaped !== undefined) {
          output.push(escaped)
          index += 1
        }
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      output.push(char)
      continue
    }
    if (char === ',') {
      let nextIndex = index + 1
      while (/\s/.test(source[nextIndex] ?? '')) nextIndex += 1
      if (source[nextIndex] === '}' || source[nextIndex] === ']') continue
    }
    output.push(char)
  }
  return output.join('')
}

/** @param {string} source @returns {unknown} */
function parseJsonc(source) {
  return JSON.parse(stripJsonTrailingCommas(stripJsonComments(source)))
}

/**
 * Merge a baseline Oxc config (.oxfmtrc.json / .oxlintrc.json) with the
 * consumer's current config. The baseline owns every key it defines, except
 * `ignorePatterns`, where consumer-specific patterns (added by sync
 * migrations or by the repository) are preserved so repeated syncs never
 * churn them. Keys the baseline does not define (e.g. a repository-owned
 * `overrides` block) belong to the consumer and are preserved as well, so
 * a sync never silently drops repository-owned configuration. Consumer
 * category values are merged last so explicit category overrides survive the
 * baseline's default category levels.
 *
 * When the merged semantics already match the consumer file, the exact
 * existing bytes are returned untouched: rewriting canonical JSON here
 * would fight the formatter (which collapses short collections that
 * `JSON.stringify` expands) and churn the file on every sync.
 * @param {string} baseline @param {string} existing @returns {string}
 */
function mergeIgnorePatternsConfig(baseline, existing) {
  /** @type {Record<string, any>} */
  let consumer = {}
  try {
    const parsed = parseJsonc(existing)
    if (!isJsonObject(parsed)) return baseline
    consumer = parsed
  } catch {
    return baseline
  }
  /** @type {Record<string, any>} */
  let config = {}
  try {
    const parsed = parseJsonc(baseline)
    if (!isJsonObject(parsed)) return baseline
    config = parsed
  } catch {
    return baseline
  }
  /** @type {Record<string, any>} */
  const merged = { ...config }
  for (const [key, value] of Object.entries(consumer)) {
    if (key === 'categories' && isJsonObject(merged.categories) && isJsonObject(value)) {
      merged.categories = { ...merged.categories, ...value }
      continue
    }
    if (!(key in merged)) merged[key] = value
  }
  const extra = Array.isArray(consumer.ignorePatterns) ? consumer.ignorePatterns : []
  const base = Array.isArray(merged.ignorePatterns) ? merged.ignorePatterns : []
  const missing = extra.filter((pattern) => !base.includes(pattern))
  if (missing.length) merged.ignorePatterns = [...base, ...missing]
  if (jsonDeepEqual(merged, consumer)) return existing
  return `${JSON.stringify(merged, null, 2)}\n`
}

/**
 * Order-insensitive deep equality for JSON-compatible values. Used to detect
 * semantic equality between the merged Oxc configuration and the consumer's
 * current file so formatting differences never trigger a rewrite.
 * @param {any} a @param {any} b @returns {boolean}
 */
function jsonDeepEqual(a, b) {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => jsonDeepEqual(item, b[index]))
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => key in b && jsonDeepEqual(a[key], b[key]))
}

/**
 * Ensure the consumer's .oxfmtrc.json carries every baseline ignore pattern
 * (plus any migrated custom patterns). Missing patterns are appended to the
 * existing list; the file is left untouched when nothing is missing or the
 * config is absent/unparseable.
 * @param {string} target @param {string[]} patterns @param {string[]} changed @param {boolean} dryRun
 */
function ensureOxfmtIgnorePatterns(target, patterns, changed, dryRun) {
  const path = join(target, '.oxfmtrc.json')
  if (patterns.length === 0 || !existsSync(path)) return
  let config
  try {
    config = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return
  }
  const existing = Array.isArray(config.ignorePatterns) ? config.ignorePatterns : []
  const merged = [...existing]
  for (const pattern of patterns) {
    if (!merged.includes(pattern)) merged.push(pattern)
  }
  if (merged.length === existing.length) return
  config.ignorePatterns = merged
  changed.push('.oxfmtrc.json')
  writeOrReport(path, `${JSON.stringify(config, null, 2)}\n`, dryRun)
}

/** @param {string} file @param {string} content */
function isLegacyManagedDoc(file, content) {
  if (file === 'AGENTS.md') {
    return (
      content.includes('.github/scripts/bootstrap.sh') &&
      content.includes('bash .github/scripts/ci.sh')
    )
  }
  if (file === '.github/CONTRIBUTING.md') {
    return (
      content.includes('.github/scripts/bootstrap.sh') && content.includes('.github/template.yml')
    )
  }
  return false
}

const MANAGED_BLOCK_PATTERN =
  /<!-- code-foundry-managed: ([A-Za-z0-9_-]+) -->[\s\S]*?<!-- \/code-foundry-managed: \1 -->/g
const MANAGED_MARKER_LINE = /^[ \t]*<!-- \/?code-foundry-managed: [A-Za-z0-9_-]+ -->[ \t]*\r?\n/gm

/** @param {string} id */
function managedBlockPattern(id) {
  const start = `<!-- code-foundry-managed: ${id} -->`
  const end = `<!-- /code-foundry-managed: ${id} -->`
  return new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, 'g')
}

/**
 * Remove managed marker lines that do not belong to a complete block. The
 * pre-block templates carried a single unclosed `config-aware-policy` marker
 * as an ownership flag; that residue (and any hand-mangled leftover marker)
 * is migration noise, not content, and would otherwise break block matching.
 * Markers inside complete blocks are kept.
 * @param {string} content
 * @returns {string}
 */
function stripUnpairedManagedMarkers(content) {
  const spans = [...content.matchAll(MANAGED_BLOCK_PATTERN)].map((match) => [
    match.index,
    match.index + match[0].length,
  ])
  if (!spans.length) return content.replace(MANAGED_MARKER_LINE, '')
  let out = ''
  let cursor = 0
  for (const match of content.matchAll(MANAGED_MARKER_LINE)) {
    const index = match.index
    if (spans.some(([from, to]) => index >= from && index < to)) continue
    out += content.slice(cursor, index)
    cursor = index + match[0].length
  }
  return out + content.slice(cursor)
}

/**
 * Refresh the managed policy blocks in a policy document against a rendered
 * baseline while preserving every unmarked line (issue #667). Blocks the
 * document already carries are replaced with the baseline content in place,
 * so config-driven prose (branch topology, validation tiers) always follows
 * the repository configuration. Missing blocks migrate in place when their
 * baseline content is present verbatim — documents rendered by the pre-block
 * templates carried the same prose unmarked — and are appended at the end
 * otherwise, so hand-edited generated regions and consumer-owned sections
 * are never silently deleted.
 * @param {string} existing
 * @param {string} baseline
 * @returns {string}
 */
function refreshManagedPolicyDocument(existing, baseline) {
  const blocks = [...baseline.matchAll(MANAGED_BLOCK_PATTERN)]
  if (!blocks.length) return existing

  let merged = existing
  /** @type {Set<string>} */
  const present = new Set()
  for (const match of blocks) {
    const id = match[1]
    const occurrences = [...merged.matchAll(managedBlockPattern(id))]
    if (occurrences.length > 1) {
      throw new Error(`Managed policy block appears more than once in consumer document: ${id}`)
    }
    if (occurrences.length === 1) {
      merged = merged.replace(managedBlockPattern(id), () => match[0])
      present.add(id)
    }
  }

  merged = stripUnpairedManagedMarkers(merged)
  // Stripping residue and block wrapping can leave the blank runs the old
  // template carried; oxfmt collapses three or more newlines to one blank
  // line, so normalize to the same shape the format gate expects.
  merged = merged.replace(/\n{3,}/g, '\n\n')

  for (const match of blocks) {
    if (present.has(match[1])) continue
    const start = `<!-- code-foundry-managed: ${match[1]} -->`
    const end = `<!-- /code-foundry-managed: ${match[1]} -->`
    const inner = match[0]
      .slice(start.length, match[0].length - end.length)
      .replace(/^\n+/, '')
      .replace(/\n+$/, '')
    if (inner && merged.includes(inner)) {
      // Wrap the legacy unmarked region in place; the replacer function keeps
      // `$` sequences in the prose from being treated as substitution patterns.
      merged = merged.replace(inner, () => match[0])
      continue
    }
    const separator = merged.endsWith('\n\n') ? '' : merged.endsWith('\n') ? '\n' : '\n\n'
    merged = `${merged}${separator}${match[0]}\n`
  }
  return merged
}

/** @param {string} target @param {string[]} args */
function git(target, args) {
  spawnSync('git', args, { cwd: target, stdio: 'ignore' })
}

/** @param {string} target @param {string[]} args @returns {string} */
function gitOutput(target, args) {
  const result = spawnSync('git', args, { cwd: target, encoding: 'utf8' })
  return result.status === 0 ? (result.stdout ?? '').trim() : ''
}

/**
 * Hook names git runs on the client that Code Foundry does not own. When one
 * of these exists in a machine-level hooks directory, sync writes a
 * delegating stub for it so enabling `core.hooksPath=.githooks` keeps the
 * machine's hooks (git-lfs, secret scanners) firing.
 */
const MACHINE_DELEGATED_HOOKS = [
  'applypatch-msg',
  'commit-msg',
  'prepare-commit-msg',
  'post-applypatch',
  'post-checkout',
  'post-commit',
  'post-merge',
  'post-rewrite',
  'pre-applypatch',
  'pre-auto-gc',
  'pre-rebase',
  'pre-push',
  'reference-transaction',
  'sendemail-validate',
  'post-index-change',
]

/**
 * The hooks directories a machine-level hook may live in, in the order the
 * generated hooks probe them: the repository hooks path sync just replaced,
 * then the global one, then the checkout's default directory. Relative values
 * resolve against the repository root, matching git's own semantics.
 *
 * @param {string} target @param {string} previousHooksPath @returns {string[]}
 */
function machineHooksDirectories(target, previousHooksPath) {
  return [
    previousHooksPath,
    gitOutput(target, ['config', '--global', '--get', 'core.hooksPath']),
    `${gitOutput(target, ['rev-parse', '--git-common-dir']) || '.git'}/hooks`,
  ].flatMap((dir) => {
    if (!dir || dir === '.githooks' || dir === './.githooks') return []
    return [isAbsolute(dir) ? dir : join(target, dir)]
  })
}

/**
 * The delegating stub for one machine-level hook name. Self-contained: the
 * machine's hooks directories are re-probed at run time so the committed
 * templates never bake in machine-specific paths.
 *
 * @param {string} name
 */
const machineDelegateStub = (name) => `#!/usr/bin/env sh
# Generated by Code Foundry — delegates ${name} to the machine-level hook so
# enabling .githooks keeps secret guards, git-lfs, and other machine hooks
# working. Discovery mirrors .githooks/pre-commit; rerun sync after changing
# the machine's hooks.
set -eu
machine_hook() {
  hook_name="$1"
  for dir in \\
    "$(git config --get code-foundry.previousHooksPath 2>/dev/null || true)" \\
    "$(git config --global --get core.hooksPath 2>/dev/null || true)" \\
    "$(git rev-parse --git-common-dir 2>/dev/null || printf '.git')/hooks"
  do
    case "$dir" in
      '' | .githooks | ./.githooks | */.githooks) continue ;;
    esac
    candidate="$dir/$hook_name"
    if [ -f "$candidate" ] && ! [ "$candidate" -ef "$0" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}
if [ -n "\${CODE_FOUNDRY_HOOK_CHAIN:-}" ]; then
  exit 0
fi
if machine="$(machine_hook ${name})"; then
  # The marker makes a machine hook that delegates back to .githooks settle
  # here instead of looping.
  if [ -x "$machine" ]; then
    CODE_FOUNDRY_HOOK_CHAIN=1 exec "$machine" "$@"
  else
    CODE_FOUNDRY_HOOK_CHAIN=1 exec sh "$machine" "$@"
  fi
fi
exit 0
`

/**
 * Write delegating stubs into .githooks for every machine-level hook this
 * repository does not own, and remove stubs the machine no longer backs. The
 * stubs are machine-local (gitignored): they are rewritten on every sync and
 * only ever removed when their content carries this generator's marker.
 *
 * @param {string} target @param {string} previousHooksPath
 */
function syncMachineHookDelegates(target, previousHooksPath) {
  const directories = machineHooksDirectories(target, previousHooksPath)
  /** @param {string} name */
  const machineHook = (name) => {
    for (const dir of directories) {
      const candidate = join(dir, name)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // Absent from this directory; keep probing.
      }
    }
    return null
  }
  mkdirSync(join(target, '.githooks'), { recursive: true })
  for (const name of MACHINE_DELEGATED_HOOKS) {
    const stubPath = join(target, '.githooks', name)
    if (machineHook(name)) {
      writeFileSync(stubPath, machineDelegateStub(name))
      chmodSync(stubPath, 0o755)
    } else if (
      existsSync(stubPath) &&
      readFileSync(stubPath, 'utf8').includes('Generated by Code Foundry')
    ) {
      rmSync(stubPath)
    }
  }
}

/** @param {string} file @param {Buffer|string} content @param {boolean} dryRun */
function writeOrReport(file, content, dryRun) {
  if (dryRun) {
    console.log(`Would sync ${file}`)
    return
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

/** @param {Buffer} a @param {Buffer} b */
function buffersEqual(a, b) {
  return a.equals(b)
}

/** @param {string} root @param {string} source @param {string|undefined} configuredWorkflow @returns {Record<string,string>} */
function createDefaultConfig(root, source, configuredWorkflow) {
  const languages = detectLanguages(root).join(',')
  const packageManager = detectPackageManager(root)
  const runners = recommendRunners(root)
  const stagingRelease = configuredWorkflow === 'staging-release'
  return {
    version: '1',
    profile: detectProfile(root),
    languages,
    features: 'all',
    codeql: 'auto',
    dependency_review: 'auto',
    package_manager: packageManager,
    codeql_rust_shards: '["all"]',
    codeql_rust_threads: '1',
    codeql_rust_max_parallel: '1',
    runtime_repository: '0xPlayerOne/code-foundry',
    runtime_ref: `v${readPackageVersion(source)}`,
    ...runners,
    toolchain: 'auto',
    ...(stagingRelease ? { staging_validation_mode: 'fast' } : {}),
    performance: 'auto',
    draft_protection: 'true',
    performance_command: '',
    performance_profile: '',
    performance_budget_file: 'performance-package-budgets.json',
    prune_standard: 'false',
    cache_packages: 'auto',
    cache_build: 'auto',
    required_capabilities: '',
    coverage_enforcement: 'auto',
    coverage_minimum: '80',
    coverage_metrics: 'lines',
    coverage_report: '',
    turbo_remote: 'auto',
    release_type: detectPackageManager(root) === 'none' ? 'auto' : 'node',
    npm_publish: 'false',
    post_release: 'false',
    post_release_workflow: '',
    post_release_mode: 'auto',
    opencode_security_model: '',
    sync_mode: 'overlay',
    custom_workflows: 'preserve',
    license: existsSync(join(root, 'LICENSE')) ? 'preserve' : 'gpl-3.0-or-later',
    git_workflow: 'direct',
    merge_strategy: stagingRelease ? 'rebase' : 'squash',
    release_merge_strategy: stagingRelease ? 'rebase' : 'squash',
  }
}

/** @param {Record<string,string>} config */
function renderConfig(config) {
  return `${Object.entries(config)
    .map(([key, value]) => renderConfigLine(key, value))
    .join('\n')}\n`
}

/** @param {string} content @param {string[]} keys */
function removeConfigKeys(content, keys) {
  if (!keys.length) return content
  const rejected = new Set(keys)
  return content
    .split(/\r?\n/)
    .filter((line) => {
      const key = line.match(/^([A-Za-z0-9_-]+):/)?.[1]
      return !key || !rejected.has(key)
    })
    .join('\n')
}

/** @param {string} key @param {string} value */
function renderConfigLine(key, value) {
  if (value === '') return `${key}:`
  // Quote values that YAML would parse as collections or that would trip
  // the formatter (e.g. codeql_rust_shards: '["all"]').
  const needsQuotes = /^[[\]{]|[:,#]\s|\s#/.test(value)
  return needsQuotes ? `${key}: '${value.replace(/'/g, "''")}'` : `${key}: ${value}`
}
/** @param {string} root */
export function readPackageVersion(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
