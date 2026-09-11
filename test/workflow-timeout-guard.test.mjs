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

describe('Workflow job timeout invariant', () => {
  it('bounds every checked-in workflow job with timeout-minutes', () => {
    const failures = []
    for (const directory of workflowDirectories) {
      const workflowFiles = readdirSync(directory)
        .filter((file) => file.endsWith('.yml'))
        .toSorted()

      for (const file of workflowFiles) {
        const source = readFileSync(new URL(file, directory), 'utf8')
        for (const job of workflowJobs(source)) {
          const bounded = job.lines.some((line) => line.startsWith('    timeout-minutes:'))
          if (!bounded) failures.push(`${file}:${job.name}`)
        }
      }
    }

    assert.deepEqual(failures, [], `unbounded workflow jobs: ${failures.join(', ')}`)
  })
})
