// @ts-check

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

/** @typedef {{ target: string, source: string, dryRun?: boolean, force?: boolean, init?: boolean, runtimeRef?: string }} SyncOptions */

/** @param {SyncOptions} options */
export function syncRepository(options) {
  const target = resolve(options.target)
  const source = resolve(options.source)
  const dryRun = options.dryRun ?? false
  const force = options.force ?? false
  const configPath = join(target, '.github/code-foundry.yml')
  const existingConfig = readConfig(configPath)
  if (!Object.keys(existingConfig).length && !options.init)
    throw new Error('Missing .github/code-foundry.yml; run init first.')
  const defaults = createDefaultConfig(target, source, existingConfig.git_workflow)
  let config = { ...defaults, ...existingConfig }
  const workflow = gitWorkflow(config.git_workflow)
  if (!['direct', 'staging-release'].includes(workflow)) {
    throw new Error(`Unsupported git_workflow: ${workflow}; use direct or staging-release.`)
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
    writeOrReport(configPath, renderConfig(config), dryRun)
  } else {
    const missing = Object.keys(defaults).filter((key) => !(key in existingConfig))
    const original = readFileSync(configPath, 'utf8')
    const normalized = removeConfigKeys(original, obsoleteConfigKeys).trimEnd()
    if (missing.length || normalized !== original.trimEnd()) {
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
  const changed = []

  // Keep normal semver pins current during sync while preserving intentional
  // refs such as `main`, `staging`, or a custom immutable SHA. An explicit
  // runtime ref (fleet upgrade) is authoritative and overrides even those so
  // the rendered callers and the config pin land on the same runtime.
  if (
    existingConfig.runtime_ref &&
    existingConfig.runtime_ref !== targetRuntimeRef &&
    (options.runtimeRef !== undefined || /^v\d+\.\d+\.\d+$/.test(existingConfig.runtime_ref))
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
      content = Buffer.from(renderReleaseConfig(target, sourceFile))
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
          target === source
        )
      )
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
      if (!isLegacyManagedDoc(file, existing) && !isManagedConfigPolicy(file, existing)) {
        if (configAwarePolicyFiles.has(file)) {
          const merged = mergeManagedPolicyBlocks(existing, content.toString('utf8'))
          if (merged !== existing) {
            changed.push(file)
            writeOrReport(destination, merged, dryRun)
          }
        }
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
    ].sort()) {
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
  if (!dryRun && existsSync(join(target, '.githooks/pre-commit'))) {
    chmodSync(join(target, '.githooks/pre-commit'), 0o755)
    git(target, ['config', 'core.hooksPath', '.githooks'])
  }
  console.log(`${changed.length} baseline file(s) differ.`)
  if (overlays.custom_workflows === 'preserve') {
    const custom = customWorkflowFiles(target, standardFiles)
    if (custom.length) console.log(`Preserved ${custom.length} repository-owned workflow(s).`)
  }
  return { changed, config }
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

/** @param {string} target @param {string} sourceFile @returns {string} */
function renderReleaseConfig(target, sourceFile) {
  return `${JSON.stringify(mergeReleaseConfig(target, sourceFile), null, 2)}\n`
}

/** @param {string} file @param {string} languages @param {string} features @param {Record<string, string>} config */
function shouldInclude(file, languages, features, config) {
  if (file === 'ruff.toml') return includesValue(languages, 'python')
  if (file === '.oxfmtrc.json' || file === '.oxlintrc.json')
    return includesValue(languages, 'typescript')
  if (file === '.github/dependabot.yml') return includesValue(features, 'dependabot')
  // The OpenCode Security caller is installed in every repository so the
  // OPENCODE_SECURITY repository variable can opt a repository in (or out)
  // without a configuration change. The detect job keeps the scan off unless
  // the configuration or the variable enables it and the API key exists.
  if (file === '.github/workflows/opencode-security.yml') return true
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
    rendered = removeWorkflowBlock(rendered, 'push')
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
  // Consumer release callers are generic package release workflows. The
  // installed-consumer qualification harness is specific to Code Foundry's
  // own package and must remain in the self workflow rather than being
  // rendered into every consumer's release caller.
  if (workflow === 'release' && !selfRepository) {
    rendered = removeWorkflowBlock(rendered, 'qualification')
    rendered = removeWorkflowNeed(rendered, 'release', 'qualification')
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
    }
    for (const [input, value] of Object.entries(runnerInputs)) {
      if (!value) continue
      rendered = rendered.replace(new RegExp(`^(\\s+${input}:)\\s+.*$`, 'm'), `$1 ${value}`)
    }
    rendered = rendered.replace(/^(\s+rust-shards:)\s+.*$/m, `$1 '${rustCodeql.shards}'`)
    rendered = rendered.replace(/^(\s+rust-threads:)\s+.*$/m, `$1 '${rustCodeql.threads}'`)
    rendered = rendered.replace(/^(\s+rust-max-parallel:)\s+.*$/m, `$1 ${rustCodeql.maxParallel}`)
  }
  if (workflow === 'codeql') {
    rendered = rendered.replace(/^(\s+rust-shards:)\s+.*$/m, `$1 '${rustCodeql.shards}'`)
    rendered = rendered.replace(/^(\s+rust-threads:)\s+.*$/m, `$1 '${rustCodeql.threads}'`)
    rendered = rendered.replace(/^(\s+rust-max-parallel:)\s+.*$/m, `$1 ${rustCodeql.maxParallel}`)
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
 * Remove a single root-job dependency while preserving the rest of the job.
 * @param {string} content
 * @param {string} jobId
 * @param {string} dependency
 * @returns {string}
 */
function removeWorkflowNeed(content, jobId, dependency) {
  const lines = content.split('\n')
  const start = lines.findIndex((line) => line === `  ${jobId}:`)
  if (start === -1) return content
  let end = start + 1
  while (end < lines.length && !/^  [A-Za-z0-9_-]+:\s*$/.test(lines[end])) end += 1
  const need = lines.findIndex(
    (line, index) => index > start && index < end && line === `    needs: ${dependency}`
  )
  if (need >= 0) lines.splice(need, 1)
  return lines.join('\n')
}

/**
 * Dependabot updates land on the repository's integration branch. Direct
 * repositories have no staging branch, so every update targets main. Cargo,
 * npm, and pip updates are emitted only when Rust, TypeScript, or Python is
 * part of the configured language set, respectively; weekly updater runs
 * fail when an ecosystem has no manifests to read, so unconfigured
 * ecosystems are dropped instead of left to error.
 * @param {string} content
 * @param {Record<string,string>} config
 * @param {string} languages
 * @returns {string}
 */
function renderDependabot(content, config, languages) {
  let rendered = content
  if (!includesValue(languages, 'rust')) {
    rendered = stripDependabotEcosystem(rendered, 'cargo')
  }
  if (!includesValue(languages, 'typescript')) {
    rendered = stripDependabotEcosystem(rendered, 'npm')
  }
  if (!includesValue(languages, 'python')) {
    rendered = stripDependabotEcosystem(rendered, 'pip')
  }
  if (isStagingRelease(config.git_workflow)) return rendered
  return rendered.replaceAll('target-branch: staging', 'target-branch: main')
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
      '| Event                                              | Expected automation                                                                   |\n| -------------------------------------------------- | ------------------------------------------------------------------------------------- |\n| Draft pull request targeting `staging`             | No runner-heavy validation; run local checks before requesting review                 |\n| Ready pull request targeting `staging`             | Fast validation: CI plus unit tests, ending in `Validation / Gate`                    |\n| Draft ordinary pull request targeting `main`       | No runner-heavy validation; run local checks before requesting review                 |\n| Ready ordinary pull request targeting `main`       | Audit validation: CI, full tests, Security, and CodeQL, ending in `Validation / Gate` |\n| Exact Release Please pull request targeting `main` | Full validation: CI, full tests, Security, and CodeQL, ending in `Validation / Gate`  |\n| Scheduled or manual validation                     | Full audit tier                                                                       |\n| Push to a working branch                           | Draft PR workflow                                                                     |\n| Push to `staging`                                  | Promotion PR workflow; canonical validation waits for the PR event                    |\n| Push to `main`                                     | Release workflow plus default-branch CodeQL scan; validation ran on the merged PR     |\n',
      '| Event                                              | Expected automation                                                                   |\n| -------------------------------------------------- | ------------------------------------------------------------------------------------- |\n| Draft pull request targeting `main`                | No runner-heavy validation; run local checks before requesting review                 |\n| Ready pull request targeting `main`                | Audit validation: CI, full tests, Security, and CodeQL, ending in `Validation / Gate` |\n| Exact Release Please pull request targeting `main` | Full validation: CI, full tests, Security, and CodeQL, ending in `Validation / Gate`  |\n| Scheduled or manual validation                     | Full audit tier                                                                       |\n| Push to a working branch                           | Draft PR workflow                                                                     |\n| Push to `main`                                     | Release workflow plus default-branch CodeQL scan; validation ran on the merged PR     |\n',
    ],
    [
      '| Change                       | Target    | Merge method                                    | Merge gate                                                |\n| ---------------------------- | --------- | ----------------------------------------------- | --------------------------------------------------------- |\n| Working branch               | `staging` | Squash                                          | All applicable required checks pass                       |\n| `staging` → `main` promotion | `main`    | Rebase (`merge_strategy`)                       | Current staging checks, release review, and rollout notes |\n| Release Please version PR    | `main`    | Rebase (`release_merge_strategy`, fails closed) | Validation gate and release policy pass                   |\n',
      '| Change                    | Target | Merge method                      | Merge gate                              |\n| ------------------------- | ------ | --------------------------------- | --------------------------------------- |\n| Working branch            | `main` | Squash                            | All applicable required checks pass     |\n| Release Please version PR | `main` | Squash (`release_merge_strategy`) | Validation gate and release policy pass |\n',
    ],
    [
      'Draft pull requests do not start runner-heavy validation. The lightweight Draft Guard also converts ordinary pull requests opened, reopened, or updated while ready back to draft; it never checks out pull-request code and it excludes Release Please version heads, whose release workflow owns their state. Marking a pull request ready for review starts the applicable validation tier. Convert it back to draft after an update, then mark it ready again after every update so the required checks attach to the current head; converting it back to draft cancels in-flight validation, and no replacement starts until it is ready again.',
      'Draft pull requests do not start validation. The lightweight Draft Guard also converts ordinary pull requests opened, reopened, or updated while ready back to draft; it never checks out pull-request code and it excludes Release Please version heads, whose release workflow owns their state. Marking a pull request ready for review starts the applicable validation tier. Convert it back to draft after an update, then mark it ready again after every update so the required checks attach to the current head. Converting it to draft runs only the lightweight cancellation control.',
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
  if (seen.has('all') && shards.length !== 1) {
    throw new Error('Invalid codeql_rust_shards; "all" cannot be combined with scoped shards.')
  }
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
  if (!/^name:\s*Code Foundry\s*$/m.test(text)) return false
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

/**
 * Config-aware policy documents are generated contracts: a normal sync must
 * refresh generated copies after branch-topology or validation-policy edits.
 * Unmarked consumer-owned documents receive only the explicitly marked policy
 * blocks, so another agent's initializer cannot be overwritten. The top-level
 * marker owns generated copies. Exact scaffold signatures migrate older
 * generated copies without treating arbitrary repository documentation as
 * managed.
 * @param {string} file
 * @param {string} content
 */
function isManagedConfigPolicy(file, content) {
  if (!configAwarePolicyFiles.has(file)) return false
  if (content.includes('<!-- code-foundry-managed: config-aware-policy -->')) return true
  if (file === 'AGENTS.md') {
    return (
      content.startsWith('# Agent Instructions\n') &&
      content.includes(
        'These instructions are the repository-level operating contract for coding agents'
      ) &&
      content.includes('They complement `CONTRIBUTING.md`.')
    )
  }
  if (file === '.github/CONTRIBUTING.md') {
    return (
      content.startsWith('# Contributing\n') &&
      content.includes(
        'This guide is the operating contract for humans and automation contributing to this repository.'
      ) &&
      content.includes('[Agent contract](#agent-operating-contract)')
    )
  }
  return (
    content.startsWith('# Security Policy\n') &&
    content.includes('## Reporting a Vulnerability') &&
    content.includes(
      'This policy covers the code, configuration, dependencies, workflows, and generated artifacts maintained in this repository.'
    )
  )
}

/** @param {string} target @param {string[]} args */
function git(target, args) {
  spawnSync('git', args, { cwd: target, stdio: 'ignore' })
}

/**
 * Merge the marked policy blocks from a rendered baseline into a consumer-owned
 * policy document. Unmarked AGENTS.md/CONTRIBUTING.md files are commonly
 * generated by another agent initializer, so sync must add and refresh the
 * Code Foundry contract without replacing the user's surrounding instructions.
 * @param {string} existing
 * @param {string} baseline
 * @returns {string}
 */
function mergeManagedPolicyBlocks(existing, baseline) {
  const blockPattern =
    /<!-- code-foundry-managed: ([A-Za-z0-9_-]+) -->[\s\S]*?<!-- \/code-foundry-managed: \1 -->/g
  const blocks = [...baseline.matchAll(blockPattern)]
  if (!blocks.length) return existing

  let merged = existing
  for (const match of blocks) {
    const id = match[1]
    const block = match[0]
    const start = `<!-- code-foundry-managed: ${id} -->`
    const end = `<!-- /code-foundry-managed: ${id} -->`
    const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, 'g')
    const occurrences = merged.match(pattern) ?? []
    if (occurrences.length > 1) {
      throw new Error(`Managed policy block appears more than once in consumer document: ${id}`)
    }
    if (occurrences.length === 1) {
      merged = merged.replace(pattern, block)
      continue
    }
    if (merged.includes(start) || merged.includes(end)) {
      throw new Error(`Managed policy block is incomplete in consumer document: ${id}`)
    }
    const separator = merged.endsWith('\n\n') ? '' : merged.endsWith('\n') ? '\n' : '\n\n'
    merged = `${merged}${separator}${block}\n`
  }
  return merged
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
