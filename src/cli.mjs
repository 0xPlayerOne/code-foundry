#!/usr/bin/env node
// @ts-check

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { doctor } from './commands/doctor.mjs'
import { syncRepository } from './commands/sync.mjs'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** @typedef {{ target: string, dryRun: boolean, force: boolean }} Options */
/** @typedef {{ command: string, options: Options }} ParsedArgs */

const usage = `code-foundry — initialize and maintain agent-ready repositories

Usage:
  npx code-foundry init [--target PATH]
  npx code-foundry sync [--target PATH]
  npx code-foundry doctor [--target PATH]

The repository configuration lives in .github/code-foundry.yml.
init detects the repository, creates that file, and renders the baseline.
sync reads it and refreshes standard files from the configured runtime.

Options:
  --target PATH   Repository directory (default: current directory)
  --dry-run       Preview changes without writing files
  --force         Replace protected standard documents
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
  const options = { target: process.cwd(), dryRun: false, force: false }

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
  }
  else fail(`unknown command: ${command}`)
}

main()
