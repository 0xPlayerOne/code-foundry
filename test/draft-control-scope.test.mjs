import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

test('draft cancellation selects only runs associated with the target PR', () => {
  const workflow = readFileSync('.github/workflows/draft-control_self-ci.yml', 'utf8')
  const query = workflow.match(/--jq "([^\n]+)" \|/)?.[1]
  assert.ok(query)
  assert.match(workflow, /\[\[ "\$PR_NUMBER" =~ \^\[0-9\]\+\$ \]\]/)
  const response = { workflow_runs: [
    { id: 11, pull_requests: [{ number: 7 }] },
    { id: 12, pull_requests: [{ number: 8 }] },
    { id: 13, pull_requests: [] },
    { id: 14 },
    { id: 15, pull_requests: [{ number: 8 }, { number: 7 }] },
  ] }
  const result = spawnSync('jq', ['-r', query.replaceAll('$PR_NUMBER', '7')], {
    input: JSON.stringify(response), encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trim().split('\n'), ['11', '15'])
})
