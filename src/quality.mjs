#!/usr/bin/env node
// @ts-check
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ownedPath, runProductQuality } from './lib/product-quality.mjs'

try {
  const [configPath, phase = 'build', ...extra] = process.argv.slice(2)
  if (!configPath || extra.length)
    throw new Error('Usage: node quality.mjs MANIFEST.json [build|browser|deployed]')
  const root = resolve(process.cwd())
  const config = JSON.parse(readFileSync(ownedPath(root, configPath), 'utf8'))
  console.log(JSON.stringify(runProductQuality(root, config, phase)))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
