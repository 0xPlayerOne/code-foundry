// @ts-check

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { detectLanguages, detectPackageManager, detectProfile } from '../lib/profile.mjs'
import { configured, includesValue, readConfig } from '../lib/config.mjs'

const standardFiles = [
  '.editorconfig', '.gitattributes', '.gitignore', 'release-please-config.json',
  '.githooks/pre-commit', 'AGENTS.md', 'LICENSE', 'NOTICE', 'ruff.toml', '.prettierrc',
  '.github/CODEOWNERS', '.github/CODE_OF_CONDUCT.md', '.github/CONTRIBUTING.md',
  '.github/PULL_REQUEST_TEMPLATE.md', '.github/SECURITY.md', '.github/dependabot.yml',
  '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/config.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml', '.github/scripts/profile.sh',
  '.github/scripts/changed-files.sh', '.github/scripts/ci.sh', '.github/scripts/pre-commit.sh',
  '.github/workflows/ci.yml', '.github/workflows/codeql.yml', '.github/workflows/draft-pr.yml',
  '.github/workflows/release-pr.yml', '.github/workflows/release.yml',
  '.github/workflows/security.yml', '.github/workflows/test.yml',
]

const protectedFiles = new Set([
  'AGENTS.md', '.github/CODE_OF_CONDUCT.md', '.github/CONTRIBUTING.md',
  '.github/PULL_REQUEST_TEMPLATE.md', '.github/SECURITY.md',
])

const legacyFiles = [
  '.github/code-foundry.yml.example', '.github/template.yml', '.github/template.yml.example',
  '.github/scripts/bootstrap.sh', '.github/scripts/codeql-languages.sh', '.github/scripts/doctor.sh',
  '.github/scripts/format-fast-path.sh', '.github/scripts/init-repo.sh', '.github/scripts/security.sh',
  '.github/scripts/sync-codeowners.sh', '.github/scripts/sync-protection.sh',
  '.github/scripts/turbo-cache-probe.sh', '.github/licenses/MIT.txt',
  '.github/licenses/GPL-3.0-or-later.txt', '.github/licenses/AGPL-3.0-or-later.txt',
]

/** @typedef {{ target: string, source: string, dryRun?: boolean, force?: boolean, init?: boolean }} SyncOptions */

/** @param {SyncOptions} options */
export function syncRepository(options) {
  const target = resolve(options.target)
  const source = resolve(options.source)
  const dryRun = options.dryRun ?? false
  const force = options.force ?? false
  let config = readConfig(join(target, '.github/code-foundry.yml'))
  if (options.init && !Object.keys(config).length) {
    config = createDefaultConfig(target, source)
    writeOrReport(join(target, '.github/code-foundry.yml'), renderConfig(config), dryRun)
  }
  if (!Object.keys(config).length) throw new Error('Missing .github/code-foundry.yml; run init first.')

  const languages = configured(config.languages, detectLanguages(target).join(','))
  const features = configured(config.features, 'all')
  const runtimeRepository = configured(config.runtime_repository, '0xPlayerOne/code-foundry')
  const runtimeRef = configured(config.runtime_ref, `v${readPackageVersion(source)}`)
  const license = configured(config.license, existsSync(join(target, 'LICENSE')) ? 'preserve' : 'gpl-3.0-or-later')
  const changed = []

  for (const file of standardFiles) {
    if (!shouldInclude(file, languages, features)) continue
    const sourceFile = sourcePath(source, file)
    if (!existsSync(sourceFile)) throw new Error(`Template file missing: ${file}`)
    const destination = join(target, file)
    if (!force && protectedFiles.has(file) && existsSync(destination)) continue
    if ((file === 'LICENSE' || file === 'NOTICE') && license === 'preserve' && existsSync(destination)) continue
    if ((file === 'LICENSE' || file === 'NOTICE') && license === 'none') continue
    if (file === '.github/CODEOWNERS' && existsSync(destination)) continue
    let content = readFileSync(sourceFile)
    if (file.endsWith('.yml') && file.startsWith('.github/workflows/')) {
      content = Buffer.from(renderWorkflow(content.toString('utf8'), config, runtimeRepository, runtimeRef))
    }
    if (file === '.gitignore' && existsSync(destination)) {
      content = Buffer.from(mergeGitignore(content.toString('utf8'), readFileSync(destination, 'utf8')))
    }
    if (!existsSync(destination) || !buffersEqual(content, readFileSync(destination))) {
      changed.push(file)
      writeOrReport(destination, content, dryRun)
    }
  }

  if (license !== 'preserve' && license !== 'none') {
    const licenseFile = license === 'mit' ? 'MIT.txt' : license === 'agpl-3.0-or-later' ? 'AGPL-3.0-or-later.txt' : 'GPL-3.0-or-later.txt'
    const sourceLicense = join(source, '.github/licenses', licenseFile)
    if (!existsSync(sourceLicense)) throw new Error(`License template missing: ${sourceLicense}`)
    writeOrReport(join(target, 'LICENSE'), readFileSync(sourceLicense), dryRun)
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
  for (const file of ['ruff.toml', '.prettierrc', '.prettierignore']) {
    const relevant = file === 'ruff.toml' ? includesValue(languages, 'python') : includesValue(languages, 'typescript')
    if (!relevant && existsSync(join(target, file))) {
      changed.push(file)
      if (dryRun) console.log(`Would remove irrelevant language configuration ${file}`)
      else rmSync(join(target, file), { force: true })
    }
  }
  if (!dryRun && existsSync(join(target, '.githooks/pre-commit'))) {
    chmodSync(join(target, '.githooks/pre-commit'), 0o755)
    git(target, ['config', 'core.hooksPath', '.githooks'])
  }
  console.log(`${changed.length} baseline file(s) differ.`)
  return { changed, config }
}

/** @param {string} file @param {string} languages @param {string} features */
function shouldInclude(file, languages, features) {
  if (file === 'ruff.toml') return includesValue(languages, 'python')
  if (file === '.prettierrc') return includesValue(languages, 'typescript')
  if (file === '.github/dependabot.yml') return includesValue(features, 'dependabot')
  const workflow = file.match(/^\.github\/workflows\/([^/]+)\.yml$/)?.[1]
  return !workflow || includesValue(features, workflow)
}

/** @param {string} source @param {string} file */
function sourcePath(source, file) {
  if (file.startsWith('.github/workflows/')) {
    const name = file.slice('.github/workflows/'.length, -4)
    return join(source, '.github/workflows', `${name}_self-ci.yml`)
  }
  return join(source, file)
}

/** @param {string} content @param {Record<string,string>} config @param {string} repository @param {string} ref */
function renderWorkflow(content, config, repository, ref) {
  const localPrefix = 'uses: ./.github/workflows/'
  const remotePrefix = `uses: ${repository}/.github/workflows/`
  let rendered = content.replaceAll(localPrefix, remotePrefix)
  rendered = rendered.replace(new RegExp(`${escapeRegExp(remotePrefix)}([^\\s@]+)`, 'g'), `$&@${ref}`)
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
  return rendered
}

/** @param {string} value */
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** @param {string} baseline @param {string} existing */
function mergeGitignore(baseline, existing) {
  const marker = '# Repository-specific rules'
  const custom = existing.includes(marker) ? existing.slice(existing.indexOf(marker) + marker.length).trim() : ''
  return custom ? `${baseline.trimEnd()}\n\n${marker}\n${custom}\n` : baseline
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
  return {
    version: '1', profile: detectProfile(root), languages, features: 'all', package_manager: packageManager,
    runtime_repository: '0xPlayerOne/code-foundry', runtime_ref: `v${readPackageVersion(source)}`,
    runner: 'ubuntu-latest', unit_runner: 'ubuntu-slim', ci_runner: 'ubuntu-latest', test_runner: 'ubuntu-latest',
    security_runner: 'ubuntu-slim', codeql_runner: 'ubuntu-latest', pr_runner: 'ubuntu-slim', release_runner: 'ubuntu-slim',
    prune_standard: 'false', cache_packages: 'auto', cache_build: 'auto', coverage_minimum: '80', turbo_remote: 'auto',
    release_type: detectPackageManager(root) === 'none' ? 'auto' : 'node', npm_publish: 'false',
    license: existsSync(join(root, 'LICENSE')) ? 'preserve' : 'gpl-3.0-or-later', git_workflow: 'staging-release', merge_strategy: 'rebase',
  }
}

/** @param {Record<string,string>} config */
function renderConfig(config) { return `${Object.entries(config).map(([key, value]) => `${key}: ${value}`).join('\n')}\n` }
/** @param {string} root */
function readPackageVersion(root) {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '0.0.0' } catch { return '0.0.0' }
}
