#!/usr/bin/env node
// @ts-check

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { doctor } from './commands/doctor.mjs'
import { reconcileRelease } from './commands/release.mjs'
import { syncRepository } from './commands/sync.mjs'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** @typedef {{ target: string, dryRun: boolean, force: boolean, github: boolean, base: string, head: string }} Options */
/** @typedef {{ command: string, options: Options }} ParsedArgs */

const usage = `code-foundry — initialize and maintain agent-ready repositories

Usage:
  npx code-foundry init [--target PATH]
  npx code-foundry sync [--target PATH]
  npx code-foundry doctor [--target PATH]
  npx code-foundry release reconcile [--github] [--base BRANCH] [--head BRANCH]

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
  const options = { target: process.cwd(), dryRun: false, force: false, github: false, base: 'main', head: 'staging' }

  if (command === 'release') {
    const subcommand = argv.shift()
    if (subcommand !== 'reconcile') fail(`unknown release command: ${subcommand ?? '(missing)'}; use release reconcile`)
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
      doctor(target)
    } catch (error) {
      console.error(`code-foundry: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  } else if (command === 'release') {
    try {
      reconcileRelease(target, options)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }
  else fail(`unknown command: ${command}`)
}

main()
