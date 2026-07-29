#!/usr/bin/env node
// @ts-check

import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { doctor } from './commands/doctor.mjs'
import { dispatchPostReleaseHook, reconcileRelease } from './commands/release.mjs'
import { discoverRepositories, upgradeFleet } from './commands/fleet.mjs'
import { syncRepository } from './commands/sync.mjs'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** @typedef {{ target: string, root: string, dryRun: boolean, force: boolean, github: boolean, createPr: boolean, base: string, head: string, tag: string, workflow: string, mode: string, version: string, releaseSubcommand?: string, fleetSubcommand?: string }} Options */
/** @typedef {{ command: string, options: Options }} ParsedArgs */

const usage = `code-foundry — initialize and maintain agent-ready repositories

Usage:
  npx code-foundry init [--target PATH]
  npx code-foundry sync [--target PATH]
  npx code-foundry doctor [--target PATH]
  npx code-foundry release reconcile [--github] [--base BRANCH] [--head BRANCH]
  npx code-foundry release hook --tag TAG --workflow WORKFLOW
  npx code-foundry fleet status [--root PATH]
  npx code-foundry fleet upgrade [--root PATH] [--dry-run] [--create-pr]

The repository configuration lives in .github/code-foundry.yml.
init detects the repository, creates that file, and renders the baseline.
sync reads it and refreshes standard files from the configured runtime.

Options:
  --target PATH   Repository directory (default: current directory)
  --dry-run       Preview changes without writing files
  --force         Replace protected standard documents
  --github        Apply a verified fast-forward through GitHub
  --base BRANCH   Release source branch (default: main)
  --head BRANCH   Branch to reconcile (default: staging)
  --tag TAG       Published release tag for a post-release hook
  --workflow FILE  Workflow to dispatch for a post-release hook
  --mode MODE     auto, workflow-dispatch, release-event, or disabled
  --root PATH     Fleet root containing repositories (default: current directory)
  --create-pr     Create isolated upgrade branches and pull requests
  --version TAG   Runtime tag to report in fleet upgrade branches
  -h, --help      Show this help
`

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`code-foundry: ${message}`)
  process.exit(2)
}

/** @param {string[]} argv @returns {ParsedArgs} */
function parseArgs(argv) {
  const first = argv[0]
  const hasCommand = Boolean(first && !first.startsWith('-'))
  const command = hasCommand ? /** @type {string} */ (argv.shift()) : 'init'
  /** @type {Options} */
  const options = { target: process.cwd(), root: process.cwd(), dryRun: false, force: false, github: false, createPr: false, base: 'main', head: 'staging', tag: '', workflow: '', mode: 'auto', version: `v${readPackageVersion(packageRoot)}` }

  if (command === 'release') {
    const subcommand = argv.shift()
    if (subcommand !== 'reconcile' && subcommand !== 'hook') fail(`unknown release command: ${subcommand ?? '(missing)'}; use release reconcile or release hook`)
    options.releaseSubcommand = subcommand
  } else if (command === 'fleet') {
    const subcommand = argv.shift()
    if (subcommand !== 'status' && subcommand !== 'upgrade') fail(`unknown fleet command: ${subcommand ?? '(missing)'}; use fleet status or fleet upgrade`)
    options.fleetSubcommand = subcommand
  }

  while (argv.length) {
    const arg = argv.shift()
    if (arg === '-h' || arg === '--help') {
      console.log(usage)
      process.exit(0)
    }
    if (arg === '--target') {
      const value = argv.shift()
      if (!value || value.startsWith('-')) fail('--target requires a path')
      options.target = value
    } else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--force') options.force = true
    else if (arg === '--github') options.github = true
    else if (arg === '--base') options.base = argv.shift() ?? fail('--base requires a branch')
    else if (arg === '--head') options.head = argv.shift() ?? fail('--head requires a branch')
    else if (arg === '--tag') options.tag = argv.shift() ?? fail('--tag requires a tag')
    else if (arg === '--workflow') options.workflow = argv.shift() ?? fail('--workflow requires a workflow')
    else if (arg === '--mode') options.mode = argv.shift() ?? fail('--mode requires a delivery mode')
    else if (arg === '--root') options.root = argv.shift() ?? fail('--root requires a path')
    else if (arg === '--create-pr') options.createPr = true
    else if (arg === '--version') options.version = argv.shift() ?? fail('--version requires a tag')
    else fail(`unknown option: ${arg}; run --help for the supported options`)
  }

  return { command, options }
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  const target = resolve(options.target)

  if (command === 'init') {
    try {
      syncRepository({ target, source: packageRoot, dryRun: options.dryRun, force: options.force, init: true })
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  } else if (command === 'sync') {
    try {
      syncRepository({ target, source: packageRoot, dryRun: options.dryRun, force: options.force })
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  } else if (command === 'doctor') {
    try {
      doctor(target, { github: options.github })
    } catch (error) {
      console.error(`code-foundry: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  } else if (command === 'release') {
    try {
      if (options.releaseSubcommand === 'hook') dispatchPostReleaseHook(target, options)
      else reconcileRelease(target, options)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  } else if (command === 'fleet') {
    try {
      const root = resolve(options.root)
      if (options.fleetSubcommand === 'status') console.log(JSON.stringify(discoverRepositories(root), null, 2))
      else upgradeFleet(root, packageRoot, { createPr: options.createPr, dryRun: options.dryRun, force: options.force, version: options.version })
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }
  else fail(`unknown command: ${command}`)
}

main()

/** @param {string} root @returns {string} */
function readPackageVersion(root) {
  try { return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version ?? '0.0.0' } catch { return '0.0.0' }
}
