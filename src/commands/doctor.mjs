// @ts-check

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { includesValue, readConfig } from '../lib/config.mjs'
import { recommendRunners, resolveProfile } from '../lib/profile.mjs'
import { doctorGithub } from '../lib/github-doctor.mjs'
import { isGeneratedEventCaller } from './sync.mjs'

/** @param {string} root @param {{ github?: boolean }} [options] */
export function doctor(root, options = {}) {
  const target = resolve(root)
  const config = readConfig(join(target, '.github/code-foundry.yml'))
  const profile = resolveProfile(target)
  const recommendations = recommendRunners(target)
  let errors = 0
  /** @param {string} message */
  const error = (message) => { console.error(`ERROR: ${message}`); errors += 1 }
  /** @param {string} message */
  const warn = (message) => console.warn(`WARN: ${message}`)

  const toolchain = config.toolchain ?? 'auto'
  if (!['auto', 'native', 'mise'].includes(toolchain)) error(`unsupported toolchain: ${toolchain}`)
  if (toolchain === 'mise' && !existsSync(join(target, '.mise.toml'))) error('.mise.toml is required when toolchain: mise')
  if (toolchain === 'auto') {
    console.log(existsSync(join(target, '.mise.toml'))
      ? 'Toolchain: mise (detected from existing .mise.toml).'
      : 'Toolchain: native (mise not configured).')
  }
  const hooks = git(target, ['config', '--get', 'core.hooksPath'])
  if (hooks !== '.githooks') warn('Git hooks are not enabled; run `npx code-foundry init`')
  if (['rust', 'python', 'solidity'].some((language) => profile.languages.split(',').includes(language)) && (config.unit_runner ?? recommendations.unit_runner) === 'ubuntu-slim') {
    warn('unit_runner is ubuntu-slim for a native-toolchain repository; ubuntu-latest is recommended.')
  }

  const packageFile = join(target, 'package.json')
  if (existsSync(packageFile)) {
    let packageJson
    try { packageJson = JSON.parse(readFileSync(packageFile, 'utf8')) }
    catch { error('package.json is not valid JSON'); packageJson = {} }
    const lockfiles = ['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'].filter((file) => existsSync(join(target, file)))
    const groups = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
    if (!lockfiles.length && groups.some((key) => Object.keys(packageJson[key] ?? {}).length)) error('package.json exists but no supported lockfile was found')
    if (lockfiles.length > 1) error('multiple JavaScript lockfiles found; keep one package manager')
    if (packageJson.packageManager && lockfiles.length) {
      const declared = String(packageJson.packageManager).split('@')[0]
      const actual = lockfiles[0]?.startsWith('bun') ? 'bun' : lockfiles[0]?.split('-')[0].replace('.yaml', '')
      if (actual && declared !== actual) error(`packageManager (${declared}) does not match ${actual} lockfile`)
    }
  }

  if (profile.languages.split(',').includes('rust') && !commandExists('cargo')) error('Cargo is required for this repository')
  if (profile.languages.split(',').includes('rust')) {
    const metadata = spawnSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], { cwd: target, stdio: 'ignore' })
    if (metadata.status !== 0) error('cargo metadata failed')
  }
  if (profile.languages.split(',').includes('python') && !commandExists('python') && !existsSync(join(target, '.venv/bin/python'))) error('Python is required for this repository')

  const releaseConfigPath = join(target, 'release-please-config.json')
  if (existsSync(releaseConfigPath)) {
    /** @type {Record<string, any>} */
    let releaseConfig = {}
    try { releaseConfig = JSON.parse(readFileSync(releaseConfigPath, 'utf8')) }
    catch { error('release-please-config.json is not valid JSON') }
    const manifestMode = Boolean(releaseConfig.packages || releaseConfig['release-type'])
    if (manifestMode && !existsSync(join(target, '.release-please-manifest.json'))) {
      error('release-please-config.json requires .release-please-manifest.json; run code-foundry sync to bootstrap it')
    }
  }

  const features = config.features ?? 'all'
  for (const workflow of ['validation', 'draft-pr', 'release-pr', 'release']) {
    if (includesValue(features, workflow) && !existsSync(join(target, `.github/workflows/${workflow}.yml`))) error(`missing enabled workflow: ${workflow}.yml`)
  }
  const validationEnabled = includesValue(features, 'validation') || ['ci', 'test', 'security', 'codeql'].some((legacy) => includesValue(features, legacy))
  const validationCaller = ['validation.yml', 'validation_self-ci.yml']
    .map((file) => join(target, `.github/workflows/${file}`))
    .find((file) => existsSync(file) && /pull_request:/.test(readFileSync(file, 'utf8')))
  if (validationEnabled && !validationCaller) {
    error('missing tiered validation caller; run code-foundry sync to adopt validation.yml')
  } else if (validationCaller) {
    const caller = readFileSync(validationCaller, 'utf8')
    if (!/^  validation:\n    name: Validation/m.test(caller)) {
      error('validation caller is missing the Validation job; the Validation / Gate aggregate check cannot form.')
    }
    if (!/uses:\s+(?:\.\/\.github\/workflows\/validation\.yml|\S+\/\.github\/workflows\/validation\.yml@)/.test(caller)) {
      error('validation caller does not reference the validation orchestrator.')
    }
    const runtimeRef = caller.match(/^\s+runtime-ref:\s+(.+?)\s*$/m)?.[1]
    const checkoutRef = caller.match(/^\s+ref:\s+(.+?)\s*$/m)?.[1]
    if (!runtimeRef || !checkoutRef) {
      error('validation caller is missing runtime ref wiring (mode checkout or orchestrator input).')
    } else if (runtimeRef !== checkoutRef) {
      error(`validation caller pins mismatched runtime refs (${runtimeRef} vs ${checkoutRef}).`)
    } else if (runtimeRef !== '${{ github.sha }}' && !/^v\d+\.\d+\.\d+$/.test(runtimeRef)) {
      warn(`validation caller runtime ref ${runtimeRef} is not a released tag; pin a vX.Y.Z tag.`)
    }
  }
  const runtimeRepository = config.runtime_repository ?? '0xPlayerOne/code-foundry'
  for (const stem of ['ci', 'test', 'security', 'codeql']) {
    const legacy = join(target, `.github/workflows/${stem}.yml`)
    if (existsSync(legacy) && isGeneratedEventCaller(readFileSync(legacy, 'utf8'), stem, runtimeRepository)) {
      warn(`stale generated legacy caller ${stem}.yml still triggers canonical suites; run code-foundry sync to migrate to validation.yml.`)
    }
  }
  console.log('Remote CI, Test, Security, CodeQL, and release runtimes are loaded by the tiered validation orchestrator.')
  if (options.github) {
    const github = doctorGithub(target)
    /** @type {{ codeFoundryTokenPresent?: boolean, releasePleaseTokenPresent?: boolean }} */
    const secrets = github.details.secrets ?? {}
    for (const message of github.warnings) warn(`GitHub: ${message}`)
    for (const message of github.errors) error(`GitHub: ${message}`)
    console.log(`GitHub doctor inspected ${github.details.repository}.`)
    const codeFoundryToken = secrets.codeFoundryTokenPresent ? 'present' : 'absent'
    const releasePleaseToken = secrets.releasePleaseTokenPresent ? 'present' : 'absent'
    console.log(`GitHub tokens: CODE_FOUNDRY_TOKEN=${codeFoundryToken}, RELEASE_PLEASE_TOKEN=${releasePleaseToken}`)
    if (!secrets.codeFoundryTokenPresent && !secrets.releasePleaseTokenPresent) {
      warn('GitHub token routing fallback: PR creation will remain draft and requires manual ready-for-review to trigger validation.')
    }
  }
  if (errors) throw new Error(`Repository doctor found ${errors} error(s).`)
  console.log('Repository doctor passed.')
}

/** @param {string} root @param {string[]} args */
function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout?.trim() ?? ''
}

/** @param {string} command */
function commandExists(command) {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0
}
