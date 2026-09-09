// @ts-check

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { taskProfile } from '../runtime.mjs'
import { evidencePath, fingerprint, TASKS } from '../lib/task-policy.mjs'

const runtime = fileURLToPath(new URL('../runtime.mjs', import.meta.url))
const fastTasks = new Set(['format', 'lint', 'type_check', 'build', 'unit', 'performance'])
export const agentUsage = `code-foundry plan [--target PATH] [--tier fast|audit] [--changed] [--base REF] [--json]
code-foundry check [--target PATH] [--tier fast|audit] [--changed] [--base REF] [--timeout SECONDS] [--json]

plan discovers tasks without executing them. check invokes the shared CI runtime.
--changed annotates affected paths; it never prunes required or custom checks.
fast includes CI tasks, unit tests, and performance; audit adds integration/E2E/smoke.
Neither command substitutes for GitHub Security, CodeQL, release policy, or review.
`

/** @typedef {{command: 'plan'|'check', target: string, tier: 'fast'|'audit', changed: boolean, base: string, json: boolean, timeout: number}} AgentOptions */
/** @typedef {{runtime?: string, core?: string}} RuntimePaths */

/** @param {string[]} argv @returns {AgentOptions} */
export function parseAgentArgs(argv) {
  const [command, ...args] = argv
  if (command !== 'plan' && command !== 'check') throw new Error('Expected plan or check')
  /** @type {AgentOptions} */
  const options = { command, target: process.cwd(), tier: 'fast', changed: false, base: 'HEAD', json: false, timeout: 600000 }
  const seen = new Set()
  while (args.length) {
    const key = args.shift()
    if (!key || seen.has(key)) throw new Error(`Duplicate or missing option: ${key}`)
    seen.add(key)
    if (key === '--json') options.json = true
    else if (key === '--changed') options.changed = true
    else {
      if (!['--target', '--tier', '--base', '--timeout'].includes(key)) throw new Error(`Unknown option: ${key}`)
      const value = args.shift()
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${key}`)
      if (key === '--target') options.target = resolve(value)
      if (key === '--base') options.base = value
      if (key === '--tier') {
        if (!['fast', 'audit'].includes(value)) throw new Error('tier must be fast or audit')
        options.tier = /** @type {'fast'|'audit'} */ (value)
      }
      if (key === '--timeout') {
        const seconds = Number(value)
        if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error('timeout must be 1–3600 whole seconds')
        options.timeout = seconds * 1000
      }
    }
  }
  if (seen.has('--base') && !options.changed) throw new Error('--base requires --changed')
  if (command === 'plan' && seen.has('--timeout')) throw new Error('--timeout applies only to check execution')
  return options
}

/** @param {string} root @param {string[]} args */
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`Unable to inspect repository: git ${args[0]}`)
  return result.stdout
}

/** @param {AgentOptions} options */
export function sourceContext(options) {
  const sourceSha = git(options.target, ['rev-parse', '--verify', 'HEAD']).trim()
  if (!/^[0-9a-f]{40}$/i.test(sourceSha)) throw new Error('Repository HEAD must resolve to a commit')
  const dirty = git(options.target, ['status', '--porcelain=v1', '-z']).split('\0').filter(Boolean)
    .some((line) => !line.slice(3).startsWith('.code-foundry/'))
  let baseSha = null
  /** @type {string[]} */
  let changedFiles = []
  if (options.changed) {
    if (options.base.startsWith('-') || /[\x00-\x20\x7f]/.test(options.base)) throw new Error('Invalid base ref')
    baseSha = git(options.target, ['rev-parse', '--verify', `${options.base}^{commit}`]).trim()
    const lists = [
      git(options.target, ['diff', '--name-only', '-z', baseSha, '--']),
      git(options.target, ['diff', '--cached', '--name-only', '-z', '--']),
      git(options.target, ['diff', '--name-only', '-z', '--']),
      git(options.target, ['ls-files', '--others', '--exclude-standard', '-z']),
    ]
    changedFiles = [...new Set(lists.flatMap((value) => value.split('\0')).filter((file) => file && !file.startsWith('.code-foundry/')))]
    // This freshly created array is local to the plan.
    // oxlint-disable-next-line unicorn/no-array-sort
    changedFiles.sort()
  }
  return { sourceSha, dirty, baseSha, changedFiles }
}

/** @param {AgentOptions} options @param {RuntimePaths} [paths] */
export function planChecks(options, paths = {}) {
  const source = sourceContext(options)
  // Direct discovery shares CI policy, but unlike ci task_profile it writes no skip receipts.
  const tasks = TASKS.map((task) => ({
    ...taskProfile(options.target, task, paths.core),
    selected: options.tier === 'audit' || fastTasks.has(task),
    argv: [process.execPath, paths.runtime ?? runtime, 'ci', task],
  }))
  return { schemaVersion: 1, kind: 'code-foundry-validation-plan', status: 'planned',
    tier: options.tier, ...source, tasks,
    changePolicy: 'annotation-only; no tasks pruned without a proven dependency graph',
    remoteValidationRequired: true,
    deferredRemoteChecks: ['Security', 'CodeQL', 'release policy when applicable', 'required reviews'],
  }
}

/** @param {string} root */
function outputDirectory(root) {
  let directory = resolve(root)
  for (const component of ['.code-foundry', 'agent-results']) {
    directory = join(directory, component)
    if (!existsSync(directory)) mkdirSync(directory)
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())
      throw new Error('Agent evidence directory must be a real directory inside the repository')
  }
  return directory
}

/** @param {AgentOptions} options @param {RuntimePaths} [paths] */
export function checkRepository(options, paths = {}) {
  const plan = planChecks(options, paths)
  const directory = outputDirectory(options.target)
  const lock = join(directory, 'active.lock')
  try { mkdirSync(lock) }
  catch { throw new Error('Another agent check may be running; inspect agent-results/active.lock before recovery') }
  const runDirectory = mkdtempSync(join(directory, 'check-'))
  const reportFile = join(runDirectory, 'summary.json')
  /** @type {Record<string, any>} */
  const report = { ...plan, kind: 'code-foundry-validation-result', status: 'failed',
    startedAt: new Date().toISOString(), completedAt: null, tasks: [],
    report: reportFile, deferredTasks: plan.tasks.filter((task) => !task.selected).map((task) => task.task) }
  let failed = false
  try {
    for (const item of plan.tasks.filter((task) => task.selected)) {
      if (!item.applicable || failed) {
        report.tasks.push({ ...item, status: failed && item.applicable ? 'blocked' : 'skipped',
          reason: failed && item.applicable ? 'an earlier task failed' : item.reason })
        continue
      }
      const receiptFile = evidencePath(options.target, `.code-foundry/results/${item.task}.json`)
      const before = fingerprint(receiptFile)
      const result = spawnSync(item.argv[0], item.argv.slice(1), {
        cwd: options.target, timeout: options.timeout,
        // Keep stdout exclusively available for the public JSON contract.
        stdio: ['ignore', 2, 2],
        env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' },
      })
      let receipt = null
      let reason = result.error ? `Runtime execution failed: ${(/** @type {NodeJS.ErrnoException} */ (result.error)).code ?? result.error.name}` : ''
      if (fingerprint(receiptFile) !== before && existsSync(receiptFile)) {
        try {
          receipt = JSON.parse(readFileSync(receiptFile, 'utf8'))
          if (receipt.kind !== 'code-foundry-task-result' || receipt.schemaVersion !== 1 || receipt.task !== item.task || receipt.sourceSha !== plan.sourceSha)
            throw new Error('Receipt identity does not match the planned task/source')
        } catch (error) { reason = error instanceof Error ? error.message : String(error); receipt = null }
      }
      const passed = result.status === 0 && receipt?.status === 'passed' && !reason
      const snapshot = receipt ? join(runDirectory, `${item.task}.json`) : null
      if (snapshot) writeFileSync(snapshot, `${JSON.stringify(receipt, null, 2)}\n`)
      failed = !passed
      report.tasks.push({ ...item, status: passed ? 'passed' : 'failed', exitCode: result.status,
        signal: result.signal, reason: reason || receipt?.reason || 'missing fresh successful task evidence',
        receipt: snapshot, artifacts: receipt?.artifacts ?? [] })
    }
    report.status = failed ? 'failed' : report.tasks.some((/** @type {any} */ task) => task.status === 'passed') ? 'passed' : 'skipped'
    return report
  } finally {
    report.completedAt = new Date().toISOString()
    try { writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`) }
    finally { rmSync(lock, { recursive: true }) }
  }
}

/** @param {string[]} argv */
export function agentCommand(argv) {
  const jsonOutput = argv.includes('--json')
  if (argv.includes('--help') || argv.includes('-h')) { console.log(agentUsage); return 0 }
  try {
    const options = parseAgentArgs(argv)
    const result = options.command === 'plan' ? planChecks(options) : checkRepository(options)
    if (options.json) console.log(JSON.stringify(result, null, 2))
    else {
      console.log(`${options.command}: ${result.status} (${options.tier}, ${result.sourceSha})`)
      for (const item of result.tasks) console.log(`${item.task}: ${item.status ?? (item.selected ? item.applicable ? 'planned' : 'skipped' : 'deferred')} — ${item.reason}`)
      console.log('GitHub security checks and review requirements remain separate.')
    }
    return result.status === 'failed' ? 1 : 0
  } catch (error) {
    const result = { schemaVersion: 1, kind: 'code-foundry-validation-error', status: 'failed',
      reason: error instanceof Error ? error.message : String(error) }
    if (jsonOutput) console.log(JSON.stringify(result, null, 2))
    else console.error(result.reason)
    return 1
  }
}
