// @ts-check

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { includesValue, readConfig } from '../lib/config.mjs'
import { resolveProfile } from '../lib/profile.mjs'

/** @param {string} root */
export function doctor(root) {
  const target = resolve(root)
  const config = readConfig(join(target, '.github/code-foundry.yml'))
  const profile = resolveProfile(target)
  let errors = 0
  /** @param {string} message */
  const error = (message) => { console.error(`ERROR: ${message}`); errors += 1 }
  /** @param {string} message */
  const warn = (message) => console.warn(`WARN: ${message}`)

  if (!existsSync(join(target, '.mise.toml'))) error('.mise.toml is missing')
  const hooks = git(target, ['config', '--get', 'core.hooksPath'])
  if (hooks !== '.githooks') warn('Git hooks are not enabled; run `npx code-foundry init`')

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

  for (const workflow of ['ci', 'codeql', 'security', 'test', 'draft-pr', 'release-pr', 'release']) {
    if (includesValue(config.features ?? 'all', workflow) && !existsSync(join(target, `.github/workflows/${workflow}.yml`))) error(`missing enabled workflow: ${workflow}.yml`)
  }
  console.log('Remote CI, Test, Security, CodeQL, and release runtimes are loaded by reusable workflow wrappers.')
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
