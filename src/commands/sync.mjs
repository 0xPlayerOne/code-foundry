// @ts-check

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { detectLanguages, detectPackageManager, detectProfile, recommendRunners } from '../lib/profile.mjs'
import { configured, includesValue, readConfig } from '../lib/config.mjs'
import { buildReleaseConfig, buildReleaseManifest } from '../lib/release-manifest.mjs'
import { customWorkflowFiles, overlayPolicy } from '../lib/overlay.mjs'

const standardFiles = [
  '.editorconfig', '.gitattributes', '.gitignore', 'release-please-config.json',
  'docs/EXTENSIONS.md',
  '.githooks/pre-commit', 'AGENTS.md', 'LICENSE', 'NOTICE', 'ruff.toml', '.prettierrc', '.prettierignore',
  '.github/CODEOWNERS', '.github/CODE_OF_CONDUCT.md', '.github/CONTRIBUTING.md',
  '.github/PULL_REQUEST_TEMPLATE.md', '.github/SECURITY.md', '.github/dependabot.yml',
  '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/config.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/workflows/validation.yml', '.github/workflows/draft-pr.yml',
  '.github/workflows/release-pr.yml', '.github/workflows/release.yml',
  '.github/workflows/opencode-security.yml',
]

/**
 * Legacy event callers that the tiered validation caller replaces. Sync
 * removes them only when they are recognized as Code Foundry-generated;
 * custom workflows are always preserved byte-for-byte.
 */
const LEGACY_GENERATED_CALLERS = ['ci', 'test', 'security', 'codeql']

const protectedFiles = new Set([
  'AGENTS.md', '.github/CODE_OF_CONDUCT.md', '.github/CONTRIBUTING.md',
  '.github/PULL_REQUEST_TEMPLATE.md', '.github/SECURITY.md', 'NOTICE',
])

const legacyFiles = [
  '.github/code-foundry.yml.example', '.github/template.yml', '.github/template.yml.example',
  '.github/scripts/bootstrap.sh', '.github/scripts/changed-files.sh', '.github/scripts/ci.sh',
  '.github/scripts/codeql-languages.sh', '.github/scripts/doctor.sh', '.github/scripts/format-fast-path.sh',
  '.github/scripts/init-repo.sh', '.github/scripts/pre-commit.sh', '.github/scripts/profile.sh',
  '.github/scripts/security.sh', '.github/scripts/sitecustomize.py', '.github/scripts/sync-codeowners.sh',
  '.github/scripts/sync-protection.sh', '.github/scripts/sync-template.sh', '.github/scripts/turbo-cache-probe.sh',
  '.github/licenses/MIT.txt',
  '.github/licenses/GPL-3.0-or-later.txt', '.github/licenses/AGPL-3.0-or-later.txt',
]

/** @typedef {{ target: string, source: string, dryRun?: boolean, force?: boolean, init?: boolean }} SyncOptions */

/** @param {SyncOptions} options */
export function syncRepository(options) {
  const target = resolve(options.target)
  const source = resolve(options.source)
  const dryRun = options.dryRun ?? false
  const force = options.force ?? false
  const configPath = join(target, '.github/code-foundry.yml')
  const existingConfig = readConfig(configPath)
  if (!Object.keys(existingConfig).length && !options.init) throw new Error('Missing .github/code-foundry.yml; run init first.')
  const defaults = createDefaultConfig(target, source)
  let config = { ...defaults, ...existingConfig }
  if (!Object.keys(existingConfig).length) {
    writeOrReport(configPath, renderConfig(config), dryRun)
  } else {
    const missing = Object.keys(defaults).filter((key) => !(key in existingConfig))
    if (missing.length) {
      const current = readFileSync(configPath, 'utf8').trimEnd()
      const additions = missing.map((key) => renderConfigLine(key, defaults[key])).join('\n')
      writeOrReport(configPath, `${current}\n${additions}\n`, dryRun)
    }
  }

  const languages = configured(config.languages, detectLanguages(target).join(','))
  const features = configured(config.features, 'all')
  const runtimeRepository = configured(config.runtime_repository, '0xPlayerOne/code-foundry')
  const sourceRuntimeRef = `v${readPackageVersion(source)}`
  let runtimeRef = configured(config.runtime_ref, sourceRuntimeRef)
  const toolchain = configured(config.toolchain, 'auto')
  const overlays = overlayPolicy(target, config)
  const rustCodeql = validateRustCodeqlConfig(config)
  if (!['auto', 'native', 'mise'].includes(toolchain)) {
    throw new Error(`Unsupported toolchain: ${toolchain}; use auto, native, or mise.`)
  }
  const license = configured(config.license, existsSync(join(target, 'LICENSE')) ? 'preserve' : 'gpl-3.0-or-later')
  const changed = []

  // Keep normal semver pins current during sync while preserving intentional
  // refs such as `main`, `staging`, or a custom immutable SHA.
  if (existingConfig.runtime_ref && /^v\d+\.\d+\.\d+$/.test(existingConfig.runtime_ref) && existingConfig.runtime_ref !== sourceRuntimeRef) {
    runtimeRef = sourceRuntimeRef
    const current = readFileSync(configPath, 'utf8')
    const updated = current.replace(/^runtime_ref:\s*.*$/m, `runtime_ref: ${sourceRuntimeRef}`)
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
    if (!force && protectedFiles.has(file) && existsSync(destination)) {
      const existing = readFileSync(destination, 'utf8')
      if (!isLegacyManagedDoc(file, existing)) continue
    }
    if ((file === 'LICENSE' || file === 'NOTICE') && license === 'preserve' && existsSync(destination)) continue
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
      content = Buffer.from(renderWorkflow(content.toString('utf8'), config, runtimeRepository, runtimeRef, rustCodeql))
    }
    if (file === '.gitignore' && existsSync(destination)) {
      content = Buffer.from(mergeGitignore(content.toString('utf8'), readFileSync(destination, 'utf8')))
    }
    if (file === '.prettierignore' && existsSync(destination)) {
      content = Buffer.from(mergeIgnoreFile(content.toString('utf8'), readFileSync(destination, 'utf8')))
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
      if (dryRun) console.log(`Would remove generated legacy caller ${stem}.yml; validation.yml replaces it.`)
      else rmSync(destination, { force: true })
    } else {
      console.log(`Preserved ${stem}.yml: not recognized as a Code Foundry-generated caller.`)
    }
  }

  const releaseManifest = buildReleaseManifest(target, mergeReleaseConfig(target, sourcePath(source, 'release-please-config.json')))
  if (releaseManifest) {
    const manifestPath = join(target, '.release-please-manifest.json')
    /** @type {Record<string, string>} */
    let existingManifest = {}
    if (existsSync(manifestPath)) {
      try { existingManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) }
      catch { existingManifest = {} }
    }
    /** @type {Record<string, string>} */
    const mergedManifest = {}
    for (const directory of [...new Set([...Object.keys(releaseManifest), ...Object.keys(existingManifest)])].sort()) {
      mergedManifest[directory] = existingManifest[directory] ?? releaseManifest[directory]
    }
    const content = `${JSON.stringify(mergedManifest, null, 2)}\n`
    if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== content) {
      changed.push('.release-please-manifest.json')
      writeOrReport(manifestPath, content, dryRun)
    }
  }

  if (license !== 'preserve' && license !== 'none') {
    const licenseFile = license === 'mit' ? 'MIT.txt' : license === 'agpl-3.0-or-later' ? 'AGPL-3.0-or-later.txt' : 'GPL-3.0-or-later.txt'
    const sourceLicense = join(source, '.github/licenses', licenseFile)
    if (!existsSync(sourceLicense)) throw new Error(`License template missing: ${sourceLicense}`)
    const licenseContent = readFileSync(sourceLicense)
    if (!existsSync(join(target, 'LICENSE')) || !buffersEqual(licenseContent, readFileSync(join(target, 'LICENSE')))) {
      changed.push('LICENSE')
      writeOrReport(join(target, 'LICENSE'), licenseContent, dryRun)
    }
    if (!existsSync(join(target, 'NOTICE'))) writeOrReport(join(target, 'NOTICE'), readFileSync(join(source, 'NOTICE')), dryRun)
  }

  for (const file of legacyFiles) {
    const destination = join(target, file)
    if (existsSync(destination)) {
      changed.push(file)
      if (dryRun) console.log(`Would remove ${file}`)
      else rmSync(destination, { force: true })
    }
  }
  for (const file of ['ruff.toml', '.prettierrc', '.prettierignore']) {
    const relevant = file === 'ruff.toml' ? includesValue(languages, 'python') : includesValue(languages, 'typescript')
    if (!relevant && existsSync(join(target, file))) {
      changed.push(file)
      if (dryRun) console.log(`Would remove irrelevant language configuration ${file}`)
      else rmSync(join(target, file), { force: true })
    }
  }
  if (includesValue(languages, 'typescript') && existsSync(join(target, '.prettierignore'))) {
    const prettierIgnore = readFileSync(join(target, '.prettierignore'), 'utf8')
    if (!prettierIgnore.split(/\r?\n/).includes('.github/.code-foundry')) {
      writeOrReport(join(target, '.prettierignore'), `${prettierIgnore.trimEnd()}\n.github/.code-foundry\n`, dryRun)
      changed.push('.prettierignore')
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
const RELEASE_BASELINE_KEYS = ['$schema', 'bump-minor-pre-major', 'changelog-sections', 'include-component-in-tag']

/** @param {string} target @param {string} sourceFile @returns {Record<string, any>} */
function mergeReleaseConfig(target, sourceFile) {
  /** @type {Record<string, any>} */
  let baseline = {}
  try { baseline = JSON.parse(readFileSync(sourceFile, 'utf8')) }
  catch { baseline = {} }
  const safeBaseline = Object.fromEntries(RELEASE_BASELINE_KEYS.filter((key) => key in baseline).map((key) => [key, baseline[key]]))
  const destination = join(target, 'release-please-config.json')
  let existing = baseline
  if (existsSync(destination)) {
    try { existing = JSON.parse(readFileSync(destination, 'utf8')) }
    catch { existing = baseline }
  }
  return buildReleaseConfig(target, { ...safeBaseline, ...existing })
}

/** @param {string} target @param {string} sourceFile @returns {string} */
function renderReleaseConfig(target, sourceFile) {
  return `${JSON.stringify(mergeReleaseConfig(target, sourceFile), null, 2)}\n`
}

/** @param {string} file @param {string} languages @param {string} features @param {Record<string, string>} config */
function shouldInclude(file, languages, features, config) {
  if (file === 'ruff.toml') return includesValue(languages, 'python')
  if (file === '.prettierrc' || file === '.prettierignore') return includesValue(languages, 'typescript')
  if (file === '.github/dependabot.yml') return includesValue(features, 'dependabot')
  if (file === '.github/workflows/opencode-security.yml') return ['true', 'auto'].includes(config.opencode_security ?? 'false')
  const workflow = file.match(/^\.github\/workflows\/([^/]+)\.yml$/)?.[1]
  // The tiered validation caller supersedes the legacy ci/test/security/codeql
  // event callers, so legacy feature names keep selecting it.
  if (workflow === 'validation') {
    return includesValue(features, 'validation') || LEGACY_GENERATED_CALLERS.some((legacy) => includesValue(features, legacy))
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
 */
function renderWorkflow(content, config, repository, ref, rustCodeql) {
  const localPrefix = 'uses: ./.github/workflows/'
  const remotePrefix = `uses: ${repository}/.github/workflows/`
  let rendered = content.replaceAll(localPrefix, remotePrefix)
  rendered = rendered.replace(new RegExp(`${escapeRegExp(remotePrefix)}([^\\s@]+)`, 'g'), `$&@${ref}`)
  // Pin every runtime reference in the rendered caller: the orchestrator input
  // in the `with:` block and the mode job's runtime checkout. Self templates
  // use ${{ github.sha }} and are only rewritten when rendered for consumers.
  rendered = rendered.replace(/^(\s+runtime-ref:)\s+.*$/gm, `$1 ${ref}`)
  rendered = rendered.replace(/^(\s+ref:)\s+\$\{\{\s*github\.sha\s*\}\}\s*$/gm, `$1 ${ref}`)
  rendered = rendered.replace(/^(\s+runtime-repository:)\s+.*$/gm, `$1 ${repository}`)
  rendered = rendered.replace(new RegExp(`^(\\s+repository:)\\s+0xPlayerOne\\/code-foundry\\s*$`, 'gm'), `$1 ${repository}`)
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
  const workflow = content.match(/\.github\/workflows\/([^/]+)\.yml/)?.[1]
  const runner = workflow ? runners[workflow] : undefined
  if (runner) rendered = rendered.replace(/^(\s+runner:)\s+.*$/m, `$1 ${runner}`)
  if (workflow === 'test' && config.unit_runner) {
    rendered = rendered.replace(/^(\s+unit-runner:)\s+.*$/m, `$1 ${config.unit_runner}`)
  }
  if (workflow === 'validation') {
    /** @type {Record<string, string|undefined>} */
    const runnerInputs = {
      'ci-runner': config.ci_runner ?? config.runner,
      'test-runner': config.test_runner ?? config.runner,
      'security-runner': config.security_runner ?? config.runner,
      'codeql-runner': config.codeql_runner ?? config.runner,
      'unit-runner': config.unit_runner,
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
  return rendered
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
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

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
  if (!text.includes('runtime-repository:')) return false
  if (!new RegExp(`^  ${stem}:`, 'm').test(text)) return false
  return new RegExp(`uses:\\s*${escapeRegExp(runtimeRepository)}/\\.github/workflows/${stem}\\.yml@`).test(text)
}

/** @param {string} baseline @param {string} existing */
function mergeGitignore(baseline, existing) {
  const marker = '# Repository-specific rules'
  const custom = existing.includes(marker) ? existing.slice(existing.indexOf(marker) + marker.length).trim() : ''
  return custom ? `${baseline.trimEnd()}\n\n${marker}\n${custom}\n` : baseline
}

/** @param {string} baseline @param {string} existing */
function mergeIgnoreFile(baseline, existing) {
  const baselineLines = new Set(baseline.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
  const custom = existing.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim() && !baselineLines.has(line.trim()))
  return custom.length ? `${baseline.trimEnd()}\n\n# Repository-specific rules\n${custom.join('\n')}\n` : baseline
}

/** @param {string} file @param {string} content */
function isLegacyManagedDoc(file, content) {
  if (file === 'AGENTS.md') {
    return content.includes('.github/scripts/bootstrap.sh') && content.includes('bash .github/scripts/ci.sh')
  }
  if (file === '.github/CONTRIBUTING.md') {
    return content.includes('.github/scripts/bootstrap.sh') && content.includes('.github/template.yml')
  }
  return false
}

/** @param {string} target @param {string[]} args */
function git(target, args) { spawnSync('git', args, { cwd: target, stdio: 'ignore' }) }

/** @param {string} file @param {Buffer|string} content @param {boolean} dryRun */
function writeOrReport(file, content, dryRun) {
  if (dryRun) { console.log(`Would sync ${file}`); return }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

/** @param {Buffer} a @param {Buffer} b */
function buffersEqual(a, b) { return a.equals(b) }

/** @param {string} root @param {string} source @returns {Record<string,string>} */
function createDefaultConfig(root, source) {
  const languages = detectLanguages(root).join(',')
  const packageManager = detectPackageManager(root)
  const runners = recommendRunners(root)
  return {
    version: '1', profile: detectProfile(root), languages, features: 'all', codeql: 'auto', dependency_review: 'auto', package_manager: packageManager,
    codeql_rust_shards: '["all"]', codeql_rust_threads: '1', codeql_rust_max_parallel: '1',
    runtime_repository: '0xPlayerOne/code-foundry', runtime_ref: `v${readPackageVersion(source)}`,
    ...runners,
    toolchain: 'auto',
    prune_standard: 'false', cache_packages: 'auto', cache_build: 'auto', coverage_minimum: '80', turbo_remote: 'auto',
    release_type: detectPackageManager(root) === 'none' ? 'auto' : 'node', npm_publish: 'false',
    post_release: 'false', post_release_workflow: '', post_release_mode: 'auto',
    opencode_security: 'false',
    sync_mode: 'overlay', custom_workflows: 'preserve',
    license: existsSync(join(root, 'LICENSE')) ? 'preserve' : 'gpl-3.0-or-later', git_workflow: 'staging-release', merge_strategy: 'rebase', release_merge_strategy: 'squash',
  }
}

/** @param {Record<string,string>} config */
function renderConfig(config) { return `${Object.entries(config).map(([key, value]) => renderConfigLine(key, value)).join('\n')}\n` }
/** @param {string} key @param {string} value */
function renderConfigLine(key, value) {
  if (value === '') return `${key}:`
  // Quote values that YAML would parse as collections or that would trip
  // prettier's formatter (e.g. codeql_rust_shards: '["all"]').
  const needsQuotes = /^[\[\]{]|[:,#]\s|\s#/.test(value)
  return needsQuotes ? `${key}: '${value.replace(/'/g, "''")}'` : `${key}: ${value}`
}
/** @param {string} root */
function readPackageVersion(root) {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '0.0.0' } catch { return '0.0.0' }
}
