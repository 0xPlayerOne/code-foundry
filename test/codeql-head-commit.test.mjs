import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const workflowUrl = new URL('../.github/workflows/codeql.yml', import.meta.url)
const source = readFileSync(workflowUrl, 'utf8')

function jobLines(workflow, jobName) {
  const lines = workflow.split('\n')
  const start = lines.indexOf(`  ${jobName}:`)
  assert.notEqual(start, -1, `job ${jobName} must exist`)
  const nextJobOffset = lines
    .slice(start + 1)
    .findIndex((line) => /^  [A-Za-z0-9_-]+:\s*$/.test(line))
  const end = nextJobOffset === -1 ? lines.length : start + 1 + nextJobOffset
  return lines.slice(start + 1, end)
}

describe('CodeQL analysis commit pinning', () => {
  // codeql-action records the uploaded commit_oid from `git rev-parse HEAD`
  // on the checked-out workspace; the `sha` input to analyze/upload is only
  // a fallback when git cannot resolve HEAD. Analyzing the default
  // pull_request merge checkout therefore stamps results with a merge SHA
  // that GitHub regenerates on every mergeability evaluation, which leaves
  // required code-scanning ruleset arms permanently unsatisfied.
  it('checks out the pull request head commit in the analyze job', () => {
    const analyze = jobLines(source, 'analyze')
    const checkoutIndex = analyze.findIndex((line) => line.includes('actions/checkout@'))
    assert.notEqual(checkoutIndex, -1, 'analyze job must check out the repository')

    const step = analyze.slice(checkoutIndex, checkoutIndex + 10).join('\n')
    assert.match(
      step,
      /ref:.*pull_request\.head\.sha/,
      'analyze checkout must pin ref to the pull request head SHA'
    )
  })

  it('uploads SARIF against the pull request head ref and SHA', () => {
    const analyze = jobLines(source, 'analyze').join('\n')
    assert.match(
      analyze,
      /ref:\s*\$\{\{[^}]*refs\/pull\/\{0\}\/head[^}]*\}\}/,
      'upload must target refs/pull/<number>/head'
    )
    assert.match(
      analyze,
      /sha:\s*\$\{\{[^}]*pull_request\.head\.sha[^}]*\}\}/,
      'upload must record the pull request head SHA'
    )
  })

  it('keeps the same head pinning inside the composite action', () => {
    const action = readFileSync(
      new URL('../.github/actions/codeql/action.yml', import.meta.url),
      'utf8'
    )
    assert.match(
      action,
      /ref:\s*\$\{\{[^}]*refs\/pull\/\{0\}\/head[^}]*\}\}/,
      'composite action upload must target refs/pull/<number>/head'
    )
    assert.match(
      action,
      /sha:\s*\$\{\{[^}]*pull_request\.head\.sha[^}]*\}\}/,
      'composite action upload must record the pull request head SHA'
    )
  })
})
