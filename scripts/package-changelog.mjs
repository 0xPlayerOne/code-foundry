#!/usr/bin/env node
// @ts-check

// Trims CHANGELOG.md to the most recent releases for the published npm
// package. The repository keeps the full history: Release Please prepends
// each release to CHANGELOG.md on `main`, and this script only rewrites the
// ephemeral copy in the qualification pack job's checkout immediately before
// `npm pack --ignore-scripts`. It is deliberately not a `prepack` lifecycle
// hook — the qualified producer packs with lifecycle scripts disabled — and
// it must never be committed back to the repository.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_RELEASES = 20
export const FULL_CHANGELOG_URL =
  'https://github.com/0xPlayerOne/code-foundry/blob/main/CHANGELOG.md'
const MARKER = '<!-- code-foundry: packaged changelog -->'

// Release Please writes `## [x.y.z](compare-url) (date)` (or `### ` for some
// patch styles); headings without a version are not release sections.
const RELEASE_HEADING = /^#{2,3} \[?v?\d+\.\d+\.\d+/

/**
 * @param {string} text Full CHANGELOG.md contents.
 * @param {{ releases?: number, url?: string }} [options]
 * @returns {{ text: string, kept: number, omitted: number }}
 */
export function trimChangelog(text, options = {}) {
  const releases = options.releases ?? DEFAULT_RELEASES
  const url = options.url ?? FULL_CHANGELOG_URL
  if (!Number.isInteger(releases) || releases < 1)
    throw new Error('releases must be a positive integer')
  if (text.includes(MARKER)) throw new Error('CHANGELOG.md is already trimmed for packaging')

  const lines = text.split('\n')
  const starts = []
  for (const [index, line] of lines.entries()) if (RELEASE_HEADING.test(line)) starts.push(index)
  if (starts.length <= releases) return { text, kept: starts.length, omitted: 0 }

  const kept = lines.slice(0, starts[releases]).join('\n').trimEnd()
  const omitted = starts.length - releases
  const footer = [
    MARKER,
    '',
    '---',
    '',
    `This packaged changelog lists the ${releases} most recent releases; ${omitted} older ` +
      `release${omitted === 1 ? '' : 's'} are omitted to keep the package small.`,
    `See the [full changelog](${url}) for the complete history.`,
    '',
  ].join('\n')
  return { text: `${kept}\n\n${footer}`, kept: releases, omitted }
}

/** @param {string[]} argv */
function main(argv) {
  let releases = DEFAULT_RELEASES
  const files = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--releases') releases = Number(argv[(index += 1)])
    else if (argument.startsWith('-')) throw new Error(`Unknown option ${argument}`)
    else files.push(argument)
  }
  if (files.length > 1) throw new Error('Pass at most one changelog path')
  const file = resolve(files[0] ?? 'CHANGELOG.md')
  const before = readFileSync(file, 'utf8')
  const result = trimChangelog(before, { releases })
  writeFileSync(file, result.text)
  console.log(
    `${file}: kept ${result.kept} releases, omitted ${result.omitted} ` +
      `(${Buffer.byteLength(before)} -> ${Buffer.byteLength(result.text)} bytes)`
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2))
