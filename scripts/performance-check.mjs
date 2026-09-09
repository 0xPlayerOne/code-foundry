#!/usr/bin/env node
// @ts-check

import { readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const budgets = {
  cliP95Ms: 250,
  runtimeP95Ms: 250,
  focusedTestsMs: 10_000,
  ciChecksMs: 15_000,
  runtimeDependencies: 0,
  developmentDependencies: 4,
  packedBytes: 220_000,
  unpackedBytes: 850_000,
  packedFiles: 95,
}

/** @param {string} command @param {string[]} args @param {NodeJS.ProcessEnv} [env] */
function run(command, args, env = process.env) {
  const started = performance.now()
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env,
    maxBuffer: 10 * 1024 * 1024,
  })
  const durationMs = performance.now() - started
  if (result.status !== 0) {
    process.stderr.write(result.stdout)
    process.stderr.write(result.stderr)
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`)
  }
  return { durationMs, stdout: result.stdout }
}

/** @param {string} label @param {string[]} args @param {NodeJS.ProcessEnv} [env] */
function benchmarkNode(label, args, env = process.env) {
  const samples = []
  for (let index = 0; index < 9; index += 1) {
    const { durationMs } = run(process.execPath, args, env)
    if (index >= 2) samples.push(durationMs)
  }
  samples.sort((left, right) => left - right)
  return {
    label,
    samples: samples.length,
    medianMs: samples[Math.floor(samples.length / 2)],
    p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
  }
}

const cli = benchmarkNode('CLI help startup', ['src/cli.mjs', '--help'])
const runtime = benchmarkNode('runtime mode startup', ['src/runtime.mjs', 'validation', 'mode'], {
  ...process.env,
  FOUNDRY_EVENT_NAME: 'pull_request',
  FOUNDRY_BASE_REF: 'main',
  FOUNDRY_HEAD_REF: 'perf/runtime-audit',
})
const focusedTests = run(process.execPath, ['--test', 'test/runtime.test.mjs']).durationMs

const ciStarted = performance.now()
for (const script of ['format:check', 'lint', 'type-check', 'build']) {
  run('bun', ['run', script])
}
const ciChecks = performance.now() - ciStarted

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const runtimeDependencies = Object.keys(packageJson.dependencies ?? {}).length
const developmentDependencies = Object.keys(packageJson.devDependencies ?? {}).length
const pack = JSON.parse(run('npm', ['pack', '--dry-run', '--json']).stdout)[0]
const workflow = readFileSync(resolve(root, '.github/workflows/test.yml'), 'utf8')
const performanceJob = workflow.slice(
  workflow.indexOf('\n  performance:'),
  workflow.indexOf('\n  integration:')
)
const cacheIsolated =
  /cache-build: false/.test(performanceJob) && /cache-save: false/.test(performanceJob)

const metrics = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  cli,
  runtime,
  focusedTestsMs: focusedTests,
  ciChecksMs: ciChecks,
  cacheIsolated,
  runtimeDependencies,
  developmentDependencies,
  releaseArtifact: {
    packedBytes: pack.size,
    unpackedBytes: pack.unpackedSize,
    files: pack.files.length,
  },
  budgets,
}

const failures = []
if (cli.p95Ms > budgets.cliP95Ms) failures.push(`CLI p95 ${cli.p95Ms.toFixed(1)} ms`)
if (runtime.p95Ms > budgets.runtimeP95Ms)
  failures.push(`runtime p95 ${runtime.p95Ms.toFixed(1)} ms`)
if (focusedTests > budgets.focusedTestsMs)
  failures.push(`focused tests ${focusedTests.toFixed(1)} ms`)
if (ciChecks > budgets.ciChecksMs) failures.push(`CI checks ${ciChecks.toFixed(1)} ms`)
if (!cacheIsolated) failures.push('performance job can write shared build caches')
if (runtimeDependencies > budgets.runtimeDependencies)
  failures.push(`${runtimeDependencies} runtime dependencies`)
if (developmentDependencies > budgets.developmentDependencies)
  failures.push(`${developmentDependencies} development dependencies`)
if (pack.size > budgets.packedBytes) failures.push(`packed artifact ${pack.size} bytes`)
if (pack.unpackedSize > budgets.unpackedBytes)
  failures.push(`unpacked artifact ${pack.unpackedSize} bytes`)
if (pack.files.length > budgets.packedFiles) failures.push(`${pack.files.length} packed files`)

writeFileSync(resolve(root, 'performance-results.json'), `${JSON.stringify(metrics, null, 2)}\n`)
console.log(JSON.stringify(metrics, null, 2))

if (failures.length > 0) {
  for (const failure of failures) console.error(`Performance budget exceeded: ${failure}`)
  process.exitCode = 1
}
