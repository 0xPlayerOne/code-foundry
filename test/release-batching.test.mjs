import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { renderPromoteStable, syncRepository } from '../src/commands/sync.mjs'

const source = process.cwd()

/** @param {Record<string, string>} extraConfig @returns {string} */
function consumerFixture(extraConfig = {}) {
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-release-batching-'))
  mkdirSync(join(root, '.github'), { recursive: true })
  writeFileSync(
    join(root, '.github/code-foundry.yml'),
    `languages: typescript\npackage_manager: bun\nfeatures: release\n${Object.entries(extraConfig)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n')}\n`
  )
  return root
}

/** @param {Record<string, string>} extraConfig @returns {string} */
function syncConsumer(extraConfig = {}) {
  const root = consumerFixture(extraConfig)
  syncRepository({ target: root, source })
  return root
}

test('the release caller renders the classic per-merge form without batching config', () => {
  const root = syncConsumer()
  const caller = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')
  assert.doesNotMatch(caller, /  schedule:/)
  assert.doesNotMatch(caller, /mark-prerelease/)
  assert.doesNotMatch(caller, /chore\(main\): release /)
  assert.match(
    caller,
    /if: vars\.CI_BILLING_PAUSED != 'true' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\['release-while-paused'\] == true\)/
  )
  assert.ok(!existsSync(join(root, '.github/workflows/promote-stable.yml')))
  rmSync(root, { recursive: true, force: true })
})

test('a batching schedule gates the pipeline and flags window releases', () => {
  const root = syncConsumer({ release_batching_schedule: '23 12 * * *' })
  const caller = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')
  assert.match(caller, /schedule:\n    - cron: '23 12 \* \* \*'/)
  assert.match(
    caller,
    /&& \(github\.event_name != 'push' \|\| startsWith\(github\.event\.head_commit\.message, 'chore\(main\): release '\)\)/
  )
  assert.match(caller, /mark-prerelease:\n    name: Mark the release a pre-release/)
  assert.match(caller, /gh release edit "\$tag" --repo "\$GITHUB_REPOSITORY" --prerelease/)
  assert.ok(!existsSync(join(root, '.github/workflows/promote-stable.yml')))
  rmSync(root, { recursive: true, force: true })
})

test('a malformed batching schedule fails the sync loudly', () => {
  assert.throws(
    () => syncConsumer({ release_batching_schedule: 'every morning' }),
    /Unsupported release_batching_schedule/
  )
})

test('soak hours render the batch-soak promoter and rerunning sync removes it', () => {
  const root = syncConsumer({
    release_batching_schedule: '23 12 * * *',
    release_batching_soak_hours: '96',
  })
  const promoter = readFileSync(join(root, '.github/workflows/promote-stable.yml'), 'utf8')
  assert.match(promoter, /SOAK_HOURS: '96'/)
  assert.match(promoter, /name: Promote stable/)
  assert.match(promoter, /STABLE_PROMOTION_HELD/)
  assert.match(promoter, /\.prerelease == true\)/)
  assert.match(promoter, /\.published_at > /)
  assert.match(promoter, /sort_by\(.published_at\)/)
  assert.doesNotMatch(promoter, /__SOAK_HOURS__/)

  // Dropping the key removes the generated promoter on the next sync.
  writeFileSync(
    join(root, '.github/code-foundry.yml'),
    'languages: typescript\npackage_manager: bun\nfeatures: release\nrelease_batching_schedule: "23 12 * * *"\n'
  )
  syncRepository({ target: root, source })
  assert.ok(!existsSync(join(root, '.github/workflows/promote-stable.yml')))
  rmSync(root, { recursive: true, force: true })
})

test('the promoter rejects soak hours outside the supported range', () => {
  assert.equal(renderPromoteStable({ release_batching_soak_hours: '0' }), null)
  assert.equal(renderPromoteStable({ release_batching_soak_hours: '337' }), null)
  assert.equal(renderPromoteStable({}), null)
  assert.match(renderPromoteStable({ release_batching_soak_hours: '96' }), /SOAK_HOURS: '96'/)
})
