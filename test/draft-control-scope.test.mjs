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

test('consumer sync renders the same PR-scoped cancellation workflow', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { syncRepository } = await import('../src/commands/sync.mjs')
  const root = mkdtempSync(join(tmpdir(), 'foundry-consumer-'))
  try {
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\nfeatures: validation\n')
    syncRepository({ target: root, source: process.cwd(), configureHooks: false })
    const rendered = readFileSync(join(root, '.github/workflows/draft-control.yml'), 'utf8')
    const template = readFileSync('.github/workflows/draft-control_self-ci.yml', 'utf8')
    assert.equal(rendered, template.replace('branches: [main, staging]', 'branches: [main]'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('malformed PR numbers fail before calling GitHub', async () => {
  const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'foundry-draft-control-'))
  try {
    const marker = join(root, 'called')
    writeFileSync(join(root, 'gh'), '#!/bin/sh\ntouch "$GH_CALLED"\n', { mode: 0o755 })
    const workflow = readFileSync('.github/workflows/draft-control_self-ci.yml', 'utf8')
    const body = workflow.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n')
    for (const invalid of ['', '1; echo bad', '-1', '1.5']) {
      const result = spawnSync('bash', ['-c', body], {
        encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}`, GH_CALLED: marker, PR_NUMBER: invalid },
      })
      assert.notEqual(result.status, 0)
      assert.match(result.stdout, /cannot verify pull request/)
      assert.equal(existsSync(marker), false)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
