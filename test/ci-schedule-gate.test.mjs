import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ungatedScheduledWorkflows } from '../src/commands/ci.mjs'

/**
 * @param {Record<string, string>} workflows
 * @param {boolean} [withGithubDir]
 */
function fixture(workflows, withGithubDir = true) {
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-schedule-gate-'))
  if (withGithubDir) {
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    for (const [name, source] of Object.entries(workflows)) {
      writeFileSync(join(root, '.github/workflows', name), source)
    }
  }
  return root
}

const customCron = `name: Health probe

on:
  schedule:
    - cron: '23 */6 * * *'
  workflow_dispatch:

permissions:
  contents: read

jobs:
  probe:
    runs-on: ubuntu-slim
`

const gatedCron = `name: Nightly audit

on:
  schedule:
    - cron: '0 6 * * *'

jobs:
  audit:
    if: vars.CI_BILLING_PAUSED != 'true'
    runs-on: ubuntu-slim
`

describe('ungatedScheduledWorkflows', () => {
  it('flags a custom cron workflow and extracts its crons', () => {
    const root = fixture({ 'health.yml': customCron })
    assert.deepEqual(ungatedScheduledWorkflows(root), [
      { file: '.github/workflows/health.yml', crons: ['23 */6 * * *'] },
    ])
  })

  it('skips scheduled workflows that reference the billing variable', () => {
    const root = fixture({ 'health.yml': customCron, 'audit.yml': gatedCron })
    const flagged = ungatedScheduledWorkflows(root)
    assert.deepEqual(flagged, [{ file: '.github/workflows/health.yml', crons: ['23 */6 * * *'] }])
  })

  it('ignores workflows without a schedule trigger', () => {
    const root = fixture({
      'push.yml': `on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-slim
`,
    })
    assert.deepEqual(ungatedScheduledWorkflows(root), [])
  })

  it('returns empty when no workflows directory exists', () => {
    assert.deepEqual(ungatedScheduledWorkflows(fixture({}), false), [])
  })

  it('reads unquoted cron expressions and stops at the next top-level key', () => {
    const root = fixture({
      'unquoted.yml': `on:
  schedule:
    - cron: 30 6 * * *
jobs:
  build:
    runs-on: ubuntu-slim
`,
    })
    assert.deepEqual(ungatedScheduledWorkflows(root), [
      { file: '.github/workflows/unquoted.yml', crons: ['30 6 * * *'] },
    ])
  })

  it('ignores the inline trigger form without a block schedule', () => {
    const root = fixture({ 'inline.yml': 'on: [push, workflow_dispatch]\njobs: {}\n' })
    assert.deepEqual(ungatedScheduledWorkflows(root), [])
  })
})
