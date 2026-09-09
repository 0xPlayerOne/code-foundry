// @ts-check
import { join, resolve } from 'node:path'
import { syncRepository as synchronize, readPackageVersion } from './sync-core.mjs'
import { readConfig, configured } from '../lib/config.mjs'
import { inspectQueueCaller, mergeQueueEnabled, queueRuntimeRef, renderMergeQueueCaller, syncQueueCaller } from '../lib/merge-queue.mjs'

export * from './sync-core.mjs'

/** @param {Parameters<typeof synchronize>[0]} options */
export function syncRepository(options) {
  const target = resolve(options.target)
  const source = resolve(options.source)
  const existing = readConfig(join(target, '.github/code-foundry.yml'))
  const enabled = mergeQueueEnabled(existing.merge_queue)
  const ref = queueRuntimeRef(existing.runtime_ref, readPackageVersion(source), options.runtimeRef)
  // Reject malformed opt-in settings or a user-owned destination before the
  // original synchronizer changes any files. It remains the owner of defaults.
  if (enabled) {
    const preflight = renderMergeQueueCaller({
      ...existing,
      runtime_repository: configured(existing.runtime_repository, '0xPlayerOne/code-foundry'),
    }, ref)
    inspectQueueCaller(target, preflight)
  } else inspectQueueCaller(target, null)
  const result = synchronize(options)
  const content = enabled ? renderMergeQueueCaller({
    ...result.config,
    runtime_repository: configured(result.config.runtime_repository, '0xPlayerOne/code-foundry'),
  }, ref) : null
  const changed = syncQueueCaller(target, content, options.dryRun ?? false)
  return { ...result, changed: [...new Set([...result.changed, ...changed])] }
}
