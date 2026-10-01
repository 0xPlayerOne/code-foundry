import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { spawnSync } from 'node:child_process'
import { syncRepository } from '../src/commands/sync.mjs'

function consumer() {
  const root = mkdtempSync(join(tmpdir(), 'cf-hook-'))
  mkdirSync(join(root, '.github/workflows'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"f","version":"1.0.0"}\n')
  writeFileSync(
    join(root, '.github/code-foundry.yml'),
    'languages: typescript\npackage_manager: bun\nfeatures: all\ngit_workflow: direct\nmerge_strategy: squash\nrelease_merge_strategy: squash\n'
  )
  return root
}
function stage(root) {
  writeFileSync(join(root, 'a.txt'), 'x\n')
  spawnSync('git', ['init', '-q'], { cwd: root })
  spawnSync('git', ['add', 'a.txt'], { cwd: root })
}
function gate(root) {
  const p = join(root, '.githooks/pre-commit')
  chmodSync(p, 0o755)
  return spawnSync(p, [], { cwd: root, encoding: 'utf8' })
}

describe('generated pre-commit hook', () => {
  it('never fetches anything at commit time', () => {
    const root = consumer()
    try {
      syncRepository({ target: root, source: process.cwd() })
      const h = readFileSync(join(root, '.githooks/pre-commit'), 'utf8')
      assert.doesNotMatch(h, /\bnpx\b/, 'must not shell out to npx')
      assert.doesNotMatch(h, /https?:/, 'must not reference a registry')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails the commit when the depended-on gate fails', () => {
    const root = consumer()
    try {
      syncRepository({ target: root, source: process.cwd() })
      mkdirSync(join(root, 'node_modules/.bin'), { recursive: true })
      writeFileSync(join(root, 'node_modules/.bin/code-foundry'), '#!/bin/sh\nexit 7\n')
      chmodSync(join(root, 'node_modules/.bin/code-foundry'), 0o755)
      stage(root)
      const r = gate(root)
      assert.equal(r.status, 7, `gate failure must fail the commit, got ${r.status}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to the whitespace guard when the gate is not installed', () => {
    const root = consumer()
    try {
      syncRepository({ target: root, source: process.cwd() })
      stage(root)
      const r = gate(root)
      assert.equal(r.status, 0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('blocks a commit with trailing whitespace only when the gate is absent', () => {
    const root = consumer()
    try {
      syncRepository({ target: root, source: process.cwd() })
      writeFileSync(join(root, 'b.txt'), 'trailing   \n')
      spawnSync('git', ['init', '-q'], { cwd: root })
      spawnSync('git', ['add', 'b.txt'], { cwd: root })
      const r = gate(root)
      assert.notEqual(r.status, 0, 'the fallback must still catch whitespace errors')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
