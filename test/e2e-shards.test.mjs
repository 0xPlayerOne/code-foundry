import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { syncRepository } from '../src/commands/sync.mjs'

const source = process.cwd()

/** @param {Record<string, string>} extraConfig @returns {string} */
function consumerFixture(extraConfig = {}) {
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-e2e-shards-'))
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  const lines = Object.entries({
    languages: 'typescript',
    package_manager: 'bun',
    ...extraConfig,
  }).map(([key, value]) => `${key}: ${value}`)
  writeFileSync(join(root, '.github', 'code-foundry.yml'), `${lines.join('\n')}\n`)
  writeFileSync(join(root, 'src', 'index.ts'), '')
  writeFileSync(join(root, '.github', 'workflows', 'validation.yml'), 'name: caller\n')
  return root
}

/** @param {Record<string, string>} extraConfig @returns {string} */
function syncConsumer(extraConfig = {}) {
  const root = consumerFixture(extraConfig)
  syncRepository({ target: root, source })
  return root
}

test('renders a single unsharded E2E lane by default', () => {
  const caller = readFileSync(join(syncConsumer(), '.github/workflows/validation.yml'), 'utf8')
  assert.match(caller, /e2e-shard-list: '1'/)
  assert.match(caller, /e2e-total-shards: '1'/)
})

test('fans the E2E lane into one runner per configured shard', () => {
  const caller = readFileSync(
    join(syncConsumer({ e2e_shards: '2' }), '.github/workflows/validation.yml'),
    'utf8'
  )
  assert.match(caller, /e2e-shard-list: 1,2/)
  assert.match(caller, /e2e-total-shards: 2/)

  const lane = readFileSync(join(source, '.github/workflows/test.yml'), 'utf8')
  assert.match(lane, /fail-fast: false/)
  assert.match(lane, /shard: \$\{\{ fromJson\(format\('\[\{0\}\]', inputs\.e2e-shard-list\)\) \}\}/)
  assert.match(lane, /E2E_SHARD_INDEX: \$\{\{ matrix\.shard \}\}/)
  assert.match(lane, /E2E_TOTAL_SHARDS: \$\{\{ inputs\.e2e-total-shards \}\}/)
  // Per-shard task receipts must not collide on the same artifact name.
  assert.match(
    lane,
    /-e2e\$\{\{ inputs\.e2e-total-shards != '1' && format\('-s\{0\}', matrix\.shard\) \|\| '' \}\}/
  )
})

test('the orchestrator forwards the shard inputs to the test lane', () => {
  const orchestrator = readFileSync(join(source, '.github/workflows/validation.yml'), 'utf8')
  assert.match(orchestrator, /e2e-shard-list:\n\s+description:/)
  assert.match(orchestrator, /e2e-total-shards:\n\s+description:/)
  assert.match(orchestrator, /e2e-shard-list: \$\{\{ inputs\.e2e-shard-list \}\}/)
  assert.match(orchestrator, /e2e-total-shards: \$\{\{ inputs\.e2e-total-shards \}\}/)
})

test('fails closed on a malformed e2e_shards config', () => {
  for (const bad of ['0', '9', '-1', 'two', '2.5']) {
    assert.throws(
      () => syncConsumer({ e2e_shards: bad }),
      /Unsupported e2e_shards/,
      `expected ${bad} to be rejected`
    )
  }
})
