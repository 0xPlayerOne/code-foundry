#!/usr/bin/env node
// @ts-check

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  coverageFiles,
  describeTask,
  evaluateCoverage,
  fingerprint,
  readTaskPolicy,
  TASKS,
} from './lib/task-policy.mjs'

const core = fileURLToPath(new URL('./runtime-core.mjs', import.meta.url))

/** @param {string} root @param {string} task @param {string} [entry] */
export function taskProfile(root, task, entry = core) {
  const result = spawnSync(process.execPath, [entry, 'ci', 'task_profile', task], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: '' },
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `Task discovery failed: ${task}`)
  const profile = Object.fromEntries(
    result.stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^([a-z_]+)=(.*)$/)
      return match ? [[match[1], match[2]]] : []
    })
  )
  if (!['true', 'false'].includes(profile.applicable))
    throw new Error(`Task discovery returned no applicability: ${task}`)
  return {
    ...describeTask(root, task, profile),
    javascript: profile.javascript ?? 'false',
    python: profile.python ?? 'false',
    rust: profile.rust ?? 'false',
  }
}

/** @param {string} root @param {string} task @param {unknown} result */
function saveResult(root, task, result) {
  const base = realpathSync(root)
  const directory = resolve(base, '.code-foundry/results')
  for (const ancestor of [resolve(base, '.code-foundry'), directory]) {
    if (!existsSync(ancestor)) mkdirSync(ancestor)
    const actual = relative(base, realpathSync(ancestor))
    if (actual === '..' || actual.startsWith(`..${sep}`))
      throw new Error('Result directory escapes repository')
  }
  const destination = resolve(directory, `${task}.json`)
  const temporary = `${destination}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  renameSync(temporary, destination)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const json = JSON.stringify(result, null, 2)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\n<details><summary>Code Foundry: ${task}</summary><pre>${json}</pre></details>\n`
    )
  }
}

/** @param {string} root */
function sourceSha(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

/**
 * Stable public runtime; the native executor stays separate from policy and evidence.
 * Tests can substitute an executor without installing consumer dependencies.
 * @param {string[]} args @param {string} [root] @param {string} [entry]
 * @returns {number}
 */
export function runRuntime(args, root = process.cwd(), entry = core) {
  const [area, task, selected] = args
  if (area !== 'ci' || task === 'install') {
    const result = spawnSync(process.execPath, [entry, ...args], { cwd: root, stdio: 'inherit' })
    if (result.error) throw result.error
    return result.status ?? 1
  }
  const policy = readTaskPolicy(root)
  if (task === 'plan') {
    console.log(
      JSON.stringify(
        { schemaVersion: 1, tasks: TASKS.map((name) => taskProfile(root, name, entry)) },
        null,
        2
      )
    )
    return 0
  }
  if (task === 'should_run' || task === 'task_profile') {
    const profile = taskProfile(root, selected, entry)
    for (const requiredName of policy.required.filter(
      (name) => name !== 'coverage' && name !== selected
    ))
      taskProfile(root, requiredName, entry)
    if (!profile.applicable) {
      const now = new Date().toISOString()
      saveResult(root, selected, {
        schemaVersion: 1,
        kind: 'code-foundry-task-result',
        task: selected,
        sourceSha: sourceSha(root),
        startedAt: now,
        completedAt: now,
        status: 'skipped',
        reason: profile.reason,
        required: false,
        commands: [],
        artifacts: [],
      })
    }
    for (const [key, value] of Object.entries({
      applicable: String(profile.applicable),
      javascript: profile.javascript ?? 'false',
      python: profile.python ?? 'false',
      rust: profile.rust ?? 'false',
    })) {
      const line = `${key}=${value}\n`
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line)
      else process.stdout.write(line)
    }
    return 0
  }
  if (!TASKS.includes(task)) throw new Error(`Unknown CI task: ${task || '(missing)'}`)
  const startedAt = new Date().toISOString()
  /** @type {Record<string, any>} */
  const report = {
    schemaVersion: 1,
    kind: 'code-foundry-task-result',
    task,
    sourceSha: sourceSha(root),
    startedAt,
    completedAt: startedAt,
    status: 'failed',
    commands: [],
    artifacts: [],
  }
  try {
    const profile = taskProfile(root, task, entry)
    report.required = profile.required
    report.applicable = profile.applicable
    report.reason = profile.reason
    if (!profile.applicable) {
      report.status = 'skipped'
      return 0
    }
    const before =
      task === 'unit' && policy.coverageMode !== 'off'
        ? Object.fromEntries(
            coverageFiles(root, policy).map(({ file, path }) => [file, fingerprint(path)])
          )
        : {}
    const argv = [process.execPath, entry, 'ci', task]
    const result = spawnSync(argv[0], argv.slice(1), { cwd: root, stdio: 'inherit' })
    report.commands.push({
      argv,
      source: profile.source,
      status: result.status,
      signal: result.signal,
    })
    if (result.error) throw result.error
    if (result.status !== 0) {
      report.reason = result.signal
        ? `executor terminated by ${result.signal}`
        : `executor exited ${result.status}`
      return result.status ?? 1
    }
    if (task === 'unit') {
      report.coverage = evaluateCoverage(root, policy, before)
      report.artifacts.push(...report.coverage.artifacts)
    }
    if (task === 'eval')
      report.artifacts.push('eval-results/summary.json', 'eval-results/result.json')
    if (task === 'performance') report.artifacts.push('performance-results/summary.json')
    report.status = 'passed'
    return 0
  } catch (error) {
    report.reason = error instanceof Error ? error.message : String(error)
    console.error(report.reason)
    return 1
  } finally {
    report.completedAt = new Date().toISOString()
    saveResult(root, task, report)
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exitCode = runRuntime(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
