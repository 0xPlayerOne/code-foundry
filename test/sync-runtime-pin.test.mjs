import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { alignRuntimeRefInputs, syncRepository } from '../src/commands/sync.mjs'

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

  it('keeps each job runtime-ref input in step with its refreshed pin', () => {
    const cacheWarm = `name: Validation cache warm

on:
  push:
    branches: [main]

jobs:
  warm:
    uses: 0xPlayerOne/code-foundry/.github/workflows/test.yml@v1.9.12
    with:
      runtime-repository: 0xPlayerOne/code-foundry
      runtime-ref: v1.9.12
  pinned:
    uses: 0xPlayerOne/code-foundry/.github/workflows/test.yml@v1.9.12
    with:
      runtime-ref: 0123456789abcdef0123456789abcdef01234567
  evented:
    uses: 0xPlayerOne/code-foundry/.github/workflows/test.yml@main
    with:
      runtime-ref: v1.9.12
`
    const root = consumerFixture(cacheWarm)
    try {
      syncRepository({ target: root, source: process.cwd() })
      const updated = readFileSync(join(root, '.github/workflows/cloudflare-preview.yml'), 'utf8')
      const version = updated.match(/test\.yml@(v\d+\.\d+\.\d+)$/m)?.[1]
      assert.ok(version && version !== 'v1.9.12', 'the pin moved to the synced runtime')
      const [, warm, pinned, evented] = updated.split(/^ {2}(?=warm:|pinned:|evented:)/m)
      assert.match(warm, new RegExp(`^      runtime-ref: ${version.replaceAll('.', '\\.')}$`, 'm'))
      // SHAs and refs next to an intentional (non-semver) pin stay as written.
      assert.match(pinned, /runtime-ref: 0123456789abcdef0123456789abcdef01234567$/m)
      assert.match(evented, /runtime-ref: v1\.9\.12$/m)
      assert.deepEqual(syncRepository({ target: root, source: process.cwd() }).changed, [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('repairs a runtime-ref left behind an already current pin', () => {
    const drifted = `jobs:
  warm:
    uses: 0xPlayerOne/code-foundry/.github/workflows/test.yml@v1.53.6
    with:
      runtime-ref: 'v1.53.5'
  other:
    uses: someone/else/.github/workflows/test.yml@v2.0.0
    with:
      runtime-ref: v1.53.5
`
    const aligned = alignRuntimeRefInputs(drifted, '0xPlayerOne/code-foundry')
    assert.match(aligned, /^ {6}runtime-ref: 'v1\.53\.6'$/m)
    assert.match(aligned, /^ {2}other:[\s\S]*runtime-ref: v1\.53\.5$/m)
    assert.equal(alignRuntimeRefInputs(aligned, '0xPlayerOne/code-foundry'), aligned)
  })
})
