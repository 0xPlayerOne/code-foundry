import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { dependabotPauseState } from '../src/commands/ci.mjs'

/** @param {string} [dependabot] @param {string} [configExtra] */
function fixture(dependabot, configExtra = '') {
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-dep-pause-'))
  mkdirSync(join(root, '.github'), { recursive: true })
  if (dependabot !== undefined) {
    writeFileSync(join(root, '.github/dependabot.yml'), dependabot)
  }
  if (configExtra) {
    writeFileSync(join(root, '.github/code-foundry.yml'), configExtra)
  }
  return root
}

const activeDependabot = `version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 99
`

const pausedDependabot = `version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: monthly
    open-pull-requests-limit: 0 # billing_paused: version updates disabled
`

describe('dependabotPauseState', () => {
  it('reports inactive when dependabot.yml is absent', () => {
    assert.deepEqual(dependabotPauseState(fixture()), {
      configured: false,
      active: false,
      file: '.github/dependabot.yml',
    })
  })

  it('reports active when an ecosystem has a nonzero limit', () => {
    const state = dependabotPauseState(fixture(activeDependabot))
    assert.equal(state.active, true)
    assert.equal(state.configured, false)
  })

  it('treats a missing limit as active because Dependabot defaults it to 5', () => {
    const state = dependabotPauseState(
      fixture(
        'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\n'
      )
    )
    assert.equal(state.active, true)
  })

  it('reports inactive but unconfigured when limits are zero without the config key', () => {
    const state = dependabotPauseState(fixture(pausedDependabot))
    assert.equal(state.active, false)
    assert.equal(state.configured, false)
  })

  it('reports paused and inactive when billing_paused is set and limits are zero', () => {
    const state = dependabotPauseState(
      fixture(pausedDependabot, 'languages: typescript\nbilling_paused: true\n')
    )
    assert.equal(state.active, false)
    assert.equal(state.configured, true)
  })
})
