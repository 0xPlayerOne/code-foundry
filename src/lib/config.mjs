// @ts-check

import { existsSync, readFileSync } from 'node:fs'

/**
 * Read the intentionally small YAML subset used by code-foundry.yml.
 * Values are scalar strings; this keeps the CLI dependency-free.
 * @param {string} file
 * @returns {Record<string, string>}
 */
export function readConfig(file) {
  if (!existsSync(file)) return {}

  /** @type {Record<string, string>} */
  const config = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/)
    if (!match) continue
    const value = match[2].replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')
    config[match[1]] = value
  }
  return config
}

/** @param {string} value @param {string} fallback */
export function configured(value, fallback) {
  return value === undefined || value === '' ? fallback : value
}

/** @param {string} value @returns {string[]} */
export function listValue(value) {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

/** @param {string} value @param {string} item */
export function includesValue(value, item) {
  return value === 'all' || listValue(value).includes(item)
}
