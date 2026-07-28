#!/usr/bin/env node
// @ts-check

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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

/** @param {string} script @param {string[]} args @param {string} target */
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
  const common = ['--source', packageRoot, '--ref', 'main']
  if (options.dryRun) common.push('--check')
  else common.push('--apply')
  if (options.force) common.push('--force')

  if (command === 'init') {
    const initArgs = ['--source', packageRoot, '--ref', 'main']
    if (options.dryRun) initArgs.push('--dry-run')
    if (options.force) initArgs.push('--force')
    run('init-repo.sh', initArgs, target)
  }
  else if (command === 'sync') run('sync-template.sh', common, target)
  else if (command === 'doctor') run('doctor.sh', [], target)
  else fail(`unknown command: ${command}`)
}

main()
