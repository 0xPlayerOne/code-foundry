// @ts-check

import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readConfig } from '../lib/config.mjs'
import { formatterCommand } from '../lib/formatter.mjs'

/** @param {string[]} argv */
export function formatCommand(argv) {
  let target = process.cwd()
  let check = false
  let staged = false
  /** @type {string|undefined} */
  let changed
  while (argv.length) {
    const arg = argv.shift()
    if (arg === '--target') target = argv.shift() || ''
    else if (arg === '--check') check = true
    else if (arg === '--staged') staged = true
    else if (arg === '--changed') changed = argv.shift() || ''
    else throw new Error(`Unknown format option: ${arg}`)
  }
  if (!target || target.startsWith('-')) throw new Error('--target requires a path')
  target = resolve(target)
  const config = readConfig(resolve(target, '.github/code-foundry.yml'))
  const [tool, ...args] = formatterCommand(config.formatter, { check, staged, changed })
  if (staged && !check) {
    // Bun restages working-tree contents. Refuse partial staging rather than
    // silently including edits that the caller deliberately left out.
    /** @param {string[]} diffArgs */
    const paths = (diffArgs) => {
      const result = spawnSync('git', diffArgs, { cwd: target, encoding: 'utf8' })
      if (result.status !== 0) throw new Error('Cannot inspect staged formatter changes')
      return result.stdout.split('\0').filter(Boolean)
    }
    const index = new Set(paths(['diff', '--cached', '--name-only', '-z']))
    if (paths(['diff', '--name-only', '-z']).some((file) => index.has(file)))
      throw new Error('Partially staged files: format and stage those files explicitly first')
  }
  const command = tool === 'bun' ? [tool, ...args] : ['npx', '--no-install', tool, ...args]
  const result = spawnSync(command[0], command.slice(1), { cwd: target, stdio: 'inherit' })
  if (result.error) throw result.error
  return result.status ?? 1
}
