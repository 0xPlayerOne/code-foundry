#!/usr/bin/env node
// Runs independent test commands at the same time so a mixed repository's
// unit wall time is its slowest runner, not the sum of all of them. Each line
// of output is prefixed with its runner's label, and the exit status is the
// first failing command's in the order given, so the result stays stable.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** @typedef {{ label: string, command: string, args: string[] }} Job */

/** @param {Job} job @returns {Promise<number>} */
function runJob(job) {
  return new Promise((resolvePromise) => {
    const child = spawn(job.command, job.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const prefix = `[${job.label}] `
    /** @param {import('node:stream').Readable} stream @param {NodeJS.WriteStream} sink */
    const relay = (stream, sink) =>
      createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) =>
        sink.write(`${prefix}${line}\n`)
      )
    relay(child.stdout, process.stdout)
    relay(child.stderr, process.stderr)
    child.on('error', (error) => {
      process.stderr.write(`${prefix}${error.message}\n`)
      resolvePromise(1)
    })
    child.on('close', (code, signal) => resolvePromise(signal ? 1 : (code ?? 1)))
  })
}

/** @param {Job[]} jobs */
export async function runConcurrent(jobs) {
  const statuses = await Promise.all(jobs.map(runJob))
  return statuses.find((status) => status !== 0) ?? 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runConcurrent(JSON.parse(process.argv[2] ?? '[]'))
}
