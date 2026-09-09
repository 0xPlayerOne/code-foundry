// @ts-check

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** @param {unknown} value @param {string} label */
export function versionId(value, label = 'version ID') {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

/** @param {string} value */
export function httpsUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('Deployment URLs must be HTTPS without credentials or fragments')
  return url.href
}

/** @param {string} content @param {string} worker */
export function parseUpload(content, worker) {
  const entries = content.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line))
  if (entries.some((entry) => entry.type === 'command-failed')) throw new Error('Wrangler reported command-failed')
  const uploads = entries.filter((entry) => entry.type === 'version-upload')
  if (uploads.length !== 1) throw new Error('Expected exactly one structured version-upload record')
  const upload = uploads[0]
  if (upload.version !== 1 || upload.worker_name !== worker)
    throw new Error('Unsupported Wrangler output schema or unexpected Worker name')
  const url = httpsUrl(upload.preview_url)
  if (!new URL(url).hostname.endsWith('.workers.dev')) throw new Error('Expected a Workers version preview URL')
  return { worker, versionId: versionId(upload.version_id), url }
}

/** @param {string} value */
export function pinnedWrangler(value) {
  if (value === 'local') return ['bunx', '--bun', '--no-install', 'wrangler']
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value))
    throw new Error('wrangler-version must be local or an exact version, never latest or a range')
  return ['npx', '--yes', `wrangler@${value}`]
}

/** @param {string} value @param {string} label */
export function parseArgv(value, label) {
  const argv = JSON.parse(value)
  if (!Array.isArray(argv) || !argv.length || argv.some((arg) => typeof arg !== 'string' || !arg.length || arg.includes('\0')))
    throw new Error(`${label} must be a non-empty JSON argv array`)
  return /** @type {string[]} */ (argv)
}

/** Hash a declared build tree, refusing symlinks rather than following external files.
 * @param {string} root @param {string} directory
 */
export function digestBuild(root, directory) {
  const base = resolve(root)
  const target = resolve(base, directory)
  const location = relative(base, target)
  if (!location || location === '..' || location.startsWith(`..${sep}`))
    throw new Error('artifact-path must identify a build subdirectory inside the checkout')
  let ancestor = base
  for (const part of location.split(sep)) {
    ancestor = resolve(ancestor, part)
    if (lstatSync(ancestor).isSymbolicLink()) throw new Error('Build tree must not contain symlinks')
  }
  const hash = createHash('sha256')
  let files = 0
  /** @param {string} directory */
  function visit(directory) {
    // Sorting a fresh directory listing does not mutate shared state.
    // oxlint-disable-next-line unicorn/no-array-sort
    const entries = readdirSync(directory).sort()
    for (const name of entries) {
      const file = resolve(directory, name)
      const stat = lstatSync(file)
      if (stat.isSymbolicLink()) throw new Error('Build tree must not contain symlinks')
      if (stat.isDirectory()) visit(file)
      else if (stat.isFile()) {
        const content = readFileSync(file)
        hash.update(`${relative(target, file).split(sep).join('/')}\0${content.length}\0`).update(content)
        files += 1
      } else throw new Error('Build tree contains a non-regular file')
    }
  }
  visit(target)
  if (!files) throw new Error('Build tree is empty')
  return `sha256:${hash.digest('hex')}`
}

/**
 * Inspect the actual uploaded version, never log binding values or secret material.
 * Read-only declarations are reviewed test policy, not a sandbox for Worker code.
 * @param {any} version @param {any} policy @param {'preview'|'production'} mode
 */
export function inspectBindings(version, policy, mode) {
  const bindings = version?.resources?.bindings
  if (Object.values(version?.resources?.script_runtime?.exports ?? {}).some((entry) => /** @type {any} */ (entry)?.type === 'durable-object'))
    throw new Error('Durable Object exports require a repository-specific preview and migration workflow')
  if (!Array.isArray(bindings)) throw new Error('Version API did not return binding metadata')
  if (policy.schemaVersion !== 1) throw new Error('Unsupported binding policy schema')
  if (!Array.isArray(policy.readOnlyBindings ?? []) || !Array.isArray(policy.isolatedBindings ?? []))
    throw new Error('Binding policy lists must be arrays')
  const safeTypes = new Set(['plain_text', 'secret_text', 'json', 'assets', 'version_metadata', 'wasm_module', 'text_blob', 'data_blob'])
  let stateless = true
  /** @type {{name: string, type: string, policy: string}[]} */
  const result = []
  for (const binding of bindings) {
    if (typeof binding.name !== 'string' || typeof binding.type !== 'string') throw new Error('Malformed binding metadata')
    if (binding.type === 'durable_object_namespace')
      throw new Error('Durable Objects require a repository-specific preview and migration workflow')
    if (safeTypes.has(binding.type)) {
      result.push({ name: binding.name, type: binding.type, policy: 'stateless' })
      continue
    }
    stateless = false
    const isolated = (policy.isolatedBindings ?? []).find((/** @type {any} */ entry) => entry.name === binding.name && entry.type === binding.type)
    if (isolated) {
      if (mode !== 'preview') throw new Error('Isolated preview bindings must never be promoted into production')
      const expected = isolated.expected ?? {}
      const production = isolated.production ?? {}
      const keys = Object.keys(expected)
      if (!keys.length || keys.some((key) => ['type', 'name'].includes(key) || typeof expected[key] !== 'string' || typeof production[key] !== 'string'))
        throw new Error('Isolated bindings require expected and production resource identifiers')
      if (!keys.some((key) => expected[key] !== production[key])) throw new Error('Preview binding reuses production resource identifiers')
      if (keys.some((key) => binding[key] !== expected[key])) throw new Error(`Isolated resource mismatch for ${binding.name}`)
      result.push({ name: binding.name, type: binding.type, policy: 'isolated' })
      continue
    }
    const reviewed = (policy.readOnlyBindings ?? []).some((/** @type {any} */ entry) => entry.name === binding.name && entry.type === binding.type)
    if (!reviewed) throw new Error(`Unreviewed stateful binding: ${binding.name} (${binding.type})`)
    result.push({ name: binding.name, type: binding.type, policy: 'reviewed-read-only' })
  }
  return { stateless, rollbackSafe: stateless && policy.rollbackSafe === true, bindings: result }
}

/** @param {string} candidate @param {number} percentage @param {any[]} previous */
export function deploymentVersions(candidate, percentage, previous = []) {
  versionId(candidate)
  if (!Number.isFinite(percentage) || percentage < 0.01 || percentage > 100 || (percentage < 100 && percentage > 99.99)) throw new Error('Canary percentage must be greater than zero and at most 100')
  if (percentage === 100) return [{ version_id: candidate, percentage: 100 }]
  if (previous.length !== 1 || previous[0].percentage !== 100)
    throw new Error('A canary requires exactly one baseline version serving 100%')
  const baseline = versionId(previous[0].version_id)
  if (baseline === candidate) throw new Error('Canary and baseline must be different versions')
  return [{ version_id: candidate, percentage }, { version_id: baseline, percentage: 100 - percentage }]
}

/** @param {any} previous */
export function validateRollback(previous) {
  if (!Array.isArray(previous) || previous.length < 1 || previous.length > 2)
    throw new Error('No valid rollback deployment is available')
  let total = 0
  const seen = new Set()
  for (const entry of previous) {
    versionId(entry.version_id)
    if (seen.has(entry.version_id)) throw new Error('Duplicate rollback version')
    seen.add(entry.version_id)
    if (!Number.isFinite(entry.percentage) || entry.percentage <= 0 || entry.percentage > 100)
      throw new Error('Invalid rollback percentage')
    total += entry.percentage
  }
  if (Math.abs(total - 100) > 1e-8) throw new Error('Rollback percentages must total 100')
  return previous.map((entry) => ({ version_id: entry.version_id, percentage: entry.percentage }))
}

/** @param {string} root @param {string} file */
export function bindingPolicy(root, file) {
  if (!file) return { schemaVersion: 1, readOnlyBindings: [], isolatedBindings: [] }
  const path = resolve(root, file)
  const location = relative(resolve(root), path)
  if (location === '..' || location.startsWith(`..${sep}`)) throw new Error('Binding policy escapes checkout')
  if (!existsSync(path)) throw new Error('Binding policy file is missing')
  return JSON.parse(readFileSync(path, 'utf8'))
}
