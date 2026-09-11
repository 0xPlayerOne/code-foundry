import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { syncRepository } from '../src/commands/sync.mjs'

/** @param {string} customWorkflow */
function consumerFixture(customWorkflow) {
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-runtime-pin-'))
  mkdirSync(join(root, '.github/workflows'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
  writeFileSync(
    join(root, '.github/code-foundry.yml'),
    'languages: typescript\npackage_manager: bun\nfeatures: all\ngit_workflow: direct\nmerge_strategy: squash\nrelease_merge_strategy: squash\n'
  )
  writeFileSync(join(root, '.github/workflows/cloudflare-preview.yml'), customWorkflow)
  return root
}

const stalePin = `name: Cloudflare Preview

on:
  pull_request:
    types: [ready_for_review, synchronize]

jobs:
  preview:
    if: vars.CI_BILLING_PAUSED != 'true' && github.event.pull_request.draft == false
    uses: 0xPlayerOne/code-foundry/.github/workflows/cloudflare-deploy.yml@v1.9.12
`

describe('Sync runtime pin refresh in preserved workflows', () => {
  it('advances plain semver pins on the configured runtime repository', () => {
    const root = consumerFixture(stalePin)
    try {
      const result = syncRepository({ target: root, source: process.cwd() })
      assert.ok(
        result.changed.includes('.github/workflows/cloudflare-preview.yml'),
        `expected the preserved workflow in changed: ${result.changed.join(', ')}`
      )
      const updated = readFileSync(join(root, '.github/workflows/cloudflare-preview.yml'), 'utf8')
      assert.match(updated, /cloudflare-deploy\.yml@v\d+\.\d+\.\d+$/m)
      assert.doesNotMatch(updated, /@v1\.9\.12/)

      // A resync must be idempotent once the pin matches the runtime.
      const resync = syncRepository({ target: root, source: process.cwd() })
      assert.deepEqual(resync.changed, [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves intentional refs and other repositories during a dry run', () => {
    const mixed = `name: Mixed

on:
  workflow_dispatch:

jobs:
  deploy:
    uses: 0xPlayerOne/code-foundry/.github/workflows/cloudflare-deploy.yml@main
  checkout:
    runs-on: ubuntu-slim
    steps:
      - uses: actions/checkout@v4
`
    const root = consumerFixture(mixed)
    try {
      const result = syncRepository({ target: root, source: process.cwd(), dryRun: true })
      assert.ok(result.changed.includes('.github/workflows/cloudflare-preview.yml') === false)
      const untouched = readFileSync(join(root, '.github/workflows/cloudflare-preview.yml'), 'utf8')
      assert.equal(untouched, mixed)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
