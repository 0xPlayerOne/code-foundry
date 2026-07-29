// @ts-check

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** @param {string[]} standardFiles @param {string} file */
export function isManagedPath(standardFiles, file) {
  return standardFiles.includes(file)
}

/** @param {string} root @param {string[]} standardFiles @returns {string[]} */
export function customWorkflowFiles(root, standardFiles) {
  const directory = join(root, '.github/workflows')
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => `.github/workflows/${file}`)
    .filter((file) => !isManagedPath(standardFiles, file))
    .sort()
}

/** @param {string} root @param {Record<string, string>} config */
export function overlayPolicy(root, config) {
  const mode = config.sync_mode ?? 'overlay'
  const custom = config.custom_workflows ?? 'preserve'
  if (!['overlay', 'strict'].includes(mode)) throw new Error(`Unsupported sync_mode: ${mode}; use overlay or strict.`)
  if (custom !== 'preserve') throw new Error(`Unsupported custom_workflows: ${custom}; custom workflows are always preserved.`)
  return { mode, custom_workflows: custom }
}
