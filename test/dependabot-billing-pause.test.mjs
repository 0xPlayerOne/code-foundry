import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { renderDependabot } from '../src/commands/sync.mjs'

const template = readFileSync(
  fileURLToPath(new URL('../.github/dependabot.yml', import.meta.url)),
  'utf8'
)

const directConfig = {
  git_workflow: 'direct',
  merge_strategy: 'squash',
  release_merge_strategy: 'squash',
}

describe('renderDependabot billing pause', () => {
  it('leaves the template verbatim when billing is not paused', () => {
    const rendered = renderDependabot(template, { ...directConfig }, 'typescript')
    assert.match(rendered, /open-pull-requests-limit: 99$/m)
    assert.match(rendered, /interval: weekly$/m)
    assert.doesNotMatch(rendered, /billing_paused/)
  })

  it('disables version updates and drops to monthly for every ecosystem when paused', () => {
    const rendered = renderDependabot(
      template,
      { ...directConfig, billing_paused: 'true' },
      'typescript,python,rust'
    )
    const limits = [...rendered.matchAll(/^(\s*)open-pull-requests-limit: (.*)$/gm)]
    assert.ok(limits.length >= 4, `expected every ecosystem limit rendered, got ${limits.length}`)
    for (const [, indent, value] of limits) {
      assert.equal(indent, '    ', 'limit must stay at ecosystem-block indentation')
      assert.match(value, /^0 # billing_paused/, 'every ecosystem must render limit 0')
    }
    assert.doesNotMatch(rendered, /interval: weekly/)
    const intervals = [...rendered.matchAll(/^(\s*)interval: (.*)$/gm)]
    for (const [, , value] of intervals) {
      assert.match(value, /^monthly # billing_paused/, 'every cadence must drop to monthly')
    }
    assert.doesNotMatch(rendered, /target-branch: staging/)
  })

  it('keeps the pause applied for the staging-release topology too', () => {
    const rendered = renderDependabot(
      template,
      { git_workflow: 'staging-release', billing_paused: 'true' },
      'typescript'
    )
    assert.doesNotMatch(rendered, /open-pull-requests-limit: 99$/m)
    assert.match(rendered, /target-branch: staging/)
  })

  it('renders limit 0 while still retargeting updates to main for direct repositories', () => {
    const rendered = renderDependabot(
      template,
      { ...directConfig, billing_paused: 'true' },
      'typescript'
    )
    assert.match(rendered, /target-branch: main/)
    assert.match(rendered, /open-pull-requests-limit: 0 # billing_paused/)
    // Pause markers may only annotate limit and interval lines; ignore and
    // groups blocks are untouched.
    for (const line of rendered.split('\n')) {
      if (line.includes('# billing_paused')) {
        assert.match(line, /open-pull-requests-limit: 0|interval: monthly/)
      }
    }
  })
})
