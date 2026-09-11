import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, it } from 'node:test'

const workflowDirectories = [
  new URL('../.github/workflows/', import.meta.url),
  new URL('../src/templates/workflows/', import.meta.url),
]

function workflowJobs(source) {
  const lines = source.split('\n')
  const jobsIndex = lines.indexOf('jobs:')
  if (jobsIndex === -1) return []

  const jobs = []
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^  ([A-Za-z0-9_-]+):\s*$/)
    if (!match) continue

    const nextJobOffset = lines
      .slice(index + 1)
      .findIndex((line) => /^  [A-Za-z0-9_-]+:\s*$/.test(line))
    const end = nextJobOffset === -1 ? lines.length : index + 1 + nextJobOffset
    jobs.push({ name: match[1], lines: lines.slice(index + 1, end) })
  }
  return jobs
}

/** A job that calls a reusable workflow may not carry timeout-minutes; every
 * other job must, so a hung runner cannot run to GitHub's 360-minute default. */
function isReusableCaller(lines) {
  return lines.some((line) => line.startsWith('    uses:'))
}

describe('Workflow job timeout invariant', () => {
  it('bounds every step job and keeps reusable-workflow callers schema-valid', () => {
    const unbounded = []
    const misplaced = []
    for (const directory of workflowDirectories) {
      const workflowFiles = readdirSync(directory)
        .filter((file) => file.endsWith('.yml'))
        .toSorted()

      for (const file of workflowFiles) {
        const source = readFileSync(new URL(file, directory), 'utf8')
        for (const job of workflowJobs(source)) {
          const bounded = job.lines.some((line) => line.startsWith('    timeout-minutes:'))
          if (isReusableCaller(job.lines) && bounded) misplaced.push(`${file}:${job.name}`)
          if (!isReusableCaller(job.lines) && !bounded) unbounded.push(`${file}:${job.name}`)
        }
      }
    }

    assert.deepEqual(unbounded, [], `step jobs without timeout-minutes: ${unbounded.join(', ')}`)
    assert.deepEqual(
      misplaced,
      [],
      `reusable-workflow callers must not set timeout-minutes: ${misplaced.join(', ')}`
    )
  })
})
