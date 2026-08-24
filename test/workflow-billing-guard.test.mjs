import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, it } from 'node:test'

const workflowsDirectory = new URL('../.github/workflows/', import.meta.url)
const billingGuard = "vars.CI_BILLING_PAUSED != 'true'"

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

function jobCondition(lines) {
  const conditionIndex = lines.findIndex((line) => /^    if:/.test(line))
  if (conditionIndex === -1) return ''

  const condition = [lines[conditionIndex].trim()]
  for (let index = conditionIndex + 1; index < lines.length; index += 1) {
    if (!/^      /.test(lines[index])) break
    condition.push(lines[index].trim())
  }
  return condition.join(' ')
}

describe('CI billing pause workflow invariant', () => {
  it('guards every checked-in workflow job before a runner can be allocated', () => {
    const failures = []
    const workflowFiles = readdirSync(workflowsDirectory)
      .filter((file) => file.endsWith('.yml'))
      .sort()

    for (const file of workflowFiles) {
      const source = readFileSync(new URL(file, workflowsDirectory), 'utf8')
      const jobs = workflowJobs(source)
      assert.notEqual(jobs.length, 0, `${file} must define at least one job`)

      for (const job of jobs) {
        if (!jobCondition(job.lines).includes(billingGuard)) failures.push(`${file}:${job.name}`)
      }
    }

    assert.deepEqual(failures, [], `unguarded workflow jobs: ${failures.join(', ')}`)
  })
})
