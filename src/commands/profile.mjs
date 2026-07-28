// @ts-check

import { resolve } from 'node:path'
import { resolveProfile } from '../lib/profile.mjs'

/** @param {string} root @param {'detect'|'env'|'get'} mode @param {string|undefined} key */
export function profile(root, mode = 'detect', key) {
  /** @type {Record<string, string>} */
  const values = resolveProfile(resolve(root))
  if (mode === 'get') {
    if (!key || !(key in values)) throw new Error(`unknown profile key: ${key ?? ''}`)
    console.log(values[key])
    return
  }
  for (const [name, value] of Object.entries(values)) {
    const envName = `REPO_FOUNDRY_${name.toUpperCase()}`
    console.log(mode === 'env' ? `${envName}=${value}` : `${name}=${value}`)
  }
}
