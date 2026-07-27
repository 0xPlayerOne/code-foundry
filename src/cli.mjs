#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

const usage = `repo-foundry — initialize and maintain agent-ready repositories

Usage:
  repo-foundry init [options]
  repo-foundry sync [options]
  repo-foundry doctor [--target PATH]

Init/sync options:
  --target PATH             Repository directory (default: current directory)
  --source PATH_OR_URL      Template source override
  --ref REF                 Template branch or tag (default: main)
  --languages LIST          auto or typescript,rust,python,solidity
  --features LIST           all or ci,codeql,security,test,draft-pr,release-pr,release,dependabot
  --package-manager NAME    auto, bun, pnpm, yarn, or npm
  --dry-run                 Preview changes without writing files
  --prune                   Remove disabled standard workflows
  --protection              Synchronize main branch protections (init only)
  --no-bootstrap            Skip mise/hooks/doctor bootstrap after init
  -h, --help                Show this help
`

function fail(message) {
  console.error(`repo-foundry: ${message}`)
  process.exit(2)
}

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'init'
  const options = {
    target: process.cwd(),
    source: packageRoot,
    ref: 'main',
    languages: 'auto',
    features: 'all',
    packageManager: 'auto',
    dryRun: false,
    prune: false,
    protection: false,
    bootstrap: true,
  }
  const values = new Map([
    ['--target', 'target'],
    ['--source', 'source'],
    ['--ref', 'ref'],
    ['--languages', 'languages'],
    ['--features', 'features'],
    ['--package-manager', 'packageManager'],
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
      continue
    }
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--prune') options.prune = true
    else if (arg === '--protection') options.protection = true
    else if (arg === '--no-bootstrap') options.bootstrap = false
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
  const common = [
    '--source', options.source,
    '--ref', options.ref,
    '--languages', options.languages,
    '--features', options.features,
  ]
  if (options.prune) common.push('--prune')
  if (options.dryRun) common.push('--check')
  else common.push('--apply')

  if (command === 'init') {
    const initArgs = [...common]
    if (options.protection) initArgs.push('--protection')
    if (!options.bootstrap) {
      // The shell initializer is intentionally composable; sync first and let
      // callers run bootstrap separately when installing into a CI image.
      run('sync-template.sh', initArgs, target)
    } else {
      run('init-repo.sh', [
        '--source', options.source,
        '--ref', options.ref,
        '--languages', options.languages,
        '--features', options.features,
        '--package-manager', options.packageManager,
        ...(options.dryRun ? ['--dry-run'] : []),
        ...(options.prune ? ['--prune'] : []),
        ...(options.protection ? ['--protection'] : []),
      ], target)
    }
  } else if (command === 'sync') {
    run('sync-template.sh', common, target)
  } else if (command === 'doctor') {
    run('doctor.sh', [], target)
  } else {
    fail(`unknown command: ${command}`)
  }
}

main()
