#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

const usage = `code-foundry — initialize and maintain agent-ready repositories

Usage:
  code-foundry init [options]
  code-foundry sync [options]
  code-foundry doctor [--target PATH]

Init/sync options:
  --target PATH             Repository directory (default: current directory)
  --source PATH_OR_URL      Template source override
  --ref REF                 Template branch or tag (default: main)
  --config PATH             Use a .github/code-foundry.yml configuration file
  --profile NAME            auto, application, monorepo, or minimal
  --languages LIST          auto or typescript,rust,python,solidity
  --features LIST           all or ci,codeql,security,test,draft-pr,release-pr,release,dependabot
  --package-manager NAME    auto, bun, pnpm, yarn, or npm
  --runtime-repository OWNER/REPO  Reusable workflow runtime repository
  --runtime-ref REF          Reusable workflow runtime tag or branch
  --release-type NAME        auto, node, python, rust, simple, or none
  --license NAME             agpl-3.0-or-later, mit, preserve, or none
  --license-file PATH        Use an exact custom license file
  --npm-publish              Enable npm publication in the release workflow
  --dry-run                 Preview changes without writing files
  --force                   Replace protected standard docs/templates
  --prune                   Remove disabled standard workflows
  --protection              Synchronize main branch protections (init only)
  --no-bootstrap            Skip mise/hooks/doctor bootstrap after init
  -h, --help                Show this help
`

function fail(message) {
  console.error(`code-foundry: ${message}`)
  process.exit(2)
}

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'init'
  const options = {
    target: process.cwd(),
    source: packageRoot,
    ref: 'main',
    config: process.env.REPO_FOUNDRY_CONFIG || '',
    profile: process.env.REPO_FOUNDRY_PROFILE || 'auto',
    languages: process.env.REPO_FOUNDRY_LANGUAGES || 'auto',
    features: process.env.REPO_FOUNDRY_FEATURES || 'all',
    packageManager: process.env.REPO_FOUNDRY_PACKAGE_MANAGER || 'auto',
    // Leave this empty unless the caller explicitly selects a runtime. The
    // initializer can then derive the runtime from --source, which keeps
    // organization forks plug-and-play.
    runtimeRepository: process.env.REPO_FOUNDRY_RUNTIME_REPOSITORY || '',
    runtimeRef: process.env.REPO_FOUNDRY_RUNTIME_REF || '',
    releaseType: process.env.REPO_FOUNDRY_RELEASE_TYPE || 'auto',
    license: process.env.REPO_FOUNDRY_LICENSE || (command === 'init' ? 'agpl-3.0-or-later' : 'preserve'),
    licenseFile: process.env.REPO_FOUNDRY_LICENSE_FILE || '',
    npmPublish: process.env.REPO_FOUNDRY_NPM_PUBLISH === 'true',
    languagesSet: false,
    featuresSet: false,
    profileSet: Boolean(process.env.REPO_FOUNDRY_PROFILE),
    packageManagerSet: Boolean(process.env.REPO_FOUNDRY_PACKAGE_MANAGER),
    runtimeRepositorySet: Boolean(process.env.REPO_FOUNDRY_RUNTIME_REPOSITORY),
    runtimeRefSet: Boolean(process.env.REPO_FOUNDRY_RUNTIME_REF),
    releaseTypeSet: Boolean(process.env.REPO_FOUNDRY_RELEASE_TYPE),
    licenseSet: Boolean(process.env.REPO_FOUNDRY_LICENSE),
    licenseFileSet: Boolean(process.env.REPO_FOUNDRY_LICENSE_FILE),
    npmPublishSet: Boolean(process.env.REPO_FOUNDRY_NPM_PUBLISH),
    dryRun: false,
    prune: false,
    force: false,
    protection: false,
    bootstrap: true,
  }
  const values = new Map([
    ['--target', 'target'],
    ['--source', 'source'],
    ['--ref', 'ref'],
    ['--config', 'config'],
    ['--profile', 'profile'],
    ['--languages', 'languages'],
    ['--features', 'features'],
    ['--package-manager', 'packageManager'],
    ['--runtime-repository', 'runtimeRepository'],
    ['--runtime-ref', 'runtimeRef'],
    ['--release-type', 'releaseType'],
    ['--license', 'license'],
    ['--license-file', 'licenseFile'],
  ])

  while (argv.length) {
    const arg = argv.shift()
    if (arg === '-h' || arg === '--help') {
      console.log(usage)
      process.exit(0)
    }
    if (values.has(arg)) {
      const value = argv.shift()
      if (!value || value.startsWith('-')) fail(`${arg} requires a value`)
      options[values.get(arg)] = value
      if (arg === '--languages') options.languagesSet = true
      if (arg === '--features') options.featuresSet = true
      if (arg === '--profile') options.profileSet = true
      if (arg === '--package-manager') options.packageManagerSet = true
      if (arg === '--runtime-repository') options.runtimeRepositorySet = true
      if (arg === '--runtime-ref') options.runtimeRefSet = true
      if (arg === '--release-type') options.releaseTypeSet = true
      if (arg === '--license') options.licenseSet = true
      if (arg === '--license-file') options.licenseFileSet = true
      continue
    }
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--force') options.force = true
    else if (arg === '--prune') options.prune = true
    else if (arg === '--protection') options.protection = true
    else if (arg === '--no-bootstrap') options.bootstrap = false
    else if (arg === '--npm-publish') { options.npmPublish = true; options.npmPublishSet = true }
    else fail(`unknown option: ${arg}`)
  }

  return { command, options }
}

function run(script, args, target) {
  const scriptPath = resolve(packageRoot, '.github/scripts', script)
  if (!existsSync(scriptPath)) fail(`package is missing ${script}`)
  const result = spawnSync('bash', [scriptPath, ...args], {
    cwd: target,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.error) fail(result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  const target = resolve(options.target)
  const common = ['--source', options.source, '--ref', options.ref]
  if (options.config) common.push('--config', options.config)
  if (options.profileSet) common.push('--profile', options.profile)
  if (options.languagesSet) common.push('--languages', options.languages)
  if (options.featuresSet) common.push('--features', options.features)
  if (options.packageManagerSet) common.push('--package-manager', options.packageManager)
  if (options.runtimeRepositorySet) common.push('--runtime-repository', options.runtimeRepository)
  if (options.runtimeRefSet) common.push('--runtime-ref', options.runtimeRef)
  if (options.releaseTypeSet) common.push('--release-type', options.releaseType)
  if (options.licenseSet) common.push('--license', options.license)
  if (options.licenseFileSet && options.licenseFile) common.push('--license-file', options.licenseFile)
  if (options.prune) common.push('--prune')
  if (options.force) common.push('--force')
  if (options.dryRun) common.push('--check')
  else common.push('--apply')

  if (command === 'init') {
    const initArgs = [
      '--source', options.source,
      '--ref', options.ref,
    ]
    if (options.profileSet) initArgs.push('--profile', options.profile)
    if (options.languagesSet) initArgs.push('--languages', options.languages)
    if (options.featuresSet) initArgs.push('--features', options.features)
    if (options.packageManagerSet) initArgs.push('--package-manager', options.packageManager)
    if (options.releaseTypeSet) initArgs.push('--release-type', options.releaseType)
    if (options.licenseSet) initArgs.push('--license', options.license)
    if (options.config) initArgs.push('--config', options.config)
    if (options.runtimeRepositorySet) initArgs.push('--runtime-repository', options.runtimeRepository)
    if (options.runtimeRefSet) initArgs.push('--runtime-ref', options.runtimeRef)
    if (options.licenseFileSet && options.licenseFile) initArgs.push('--license-file', options.licenseFile)
    if (options.protection) initArgs.push('--protection')
    if (options.dryRun) initArgs.push('--dry-run')
    if (options.prune) initArgs.push('--prune')
    if (options.force) initArgs.push('--force')
    if (options.npmPublishSet && options.npmPublish) initArgs.push('--npm-publish')
    if (!options.bootstrap) initArgs.push('--no-bootstrap')
    run('init-repo.sh', initArgs, target)
  } else if (command === 'sync') {
    run('sync-template.sh', common, target)
  } else if (command === 'doctor') {
    run('doctor.sh', [], target)
  } else {
    fail(`unknown command: ${command}`)
  }
}

main()
