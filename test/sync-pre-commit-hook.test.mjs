import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { syncRepository, readPackageVersion } from '../src/commands/sync.mjs'

function consumer() {
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-hook-pin-'))
  mkdirSync(join(root, '.github/workflows'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
  writeFileSync(
    join(root, '.github/code-foundry.yml'),
    'languages: typescript\npackage_manager: bun\nfeatures: all\ngit_workflow: direct\nmerge_strategy: squash\nrelease_merge_strategy: squash\n'
  )
  return root
}

describe('Generated pre-commit hook', () => {
  it('pins the gate to the version that generated it', () => {
    const root = consumer()
    try {
      syncRepository({ target: root, source: process.cwd() })
      const hook = readFileSync(join(root, '.githooks/pre-commit'), 'utf8')
      const version = readPackageVersion(process.cwd())
      assert.ok(
        hook.includes(`code-foundry@${version} pre-commit`),
        `expected the gate pinned to ${version}, got: ${hook.split('\n').find((l) => l.includes('npx')) ?? ''}`
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('never resolves the gate through a mutable dist-tag', () => {
    const root = consumer()
    try {
      syncRepository({ target: root, source: process.cwd() })
      const hook = readFileSync(join(root, '.githooks/pre-commit'), 'utf8')
      // A dist-tag here would let any publish under that tag execute code on
      // every developer's machine at commit time.
      assert.doesNotMatch(hook, /code-foundry@(latest|next|beta|canary)\b/)
      assert.doesNotMatch(hook, /__VERSION__/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the whitespace guard as an offline fallback', () => {
    const root = consumer()
    try {
      syncRepository({ target: root, source: process.cwd() })
      const hook = readFileSync(join(root, '.githooks/pre-commit'), 'utf8')
      assert.match(hook, /git diff --cached --check/)
      // The fallback must not be able to short-circuit the gate.
      assert.match(hook, /exit 0[\s\S]*npx --yes code-foundry@\d+\.\d+\.\d+ pre-commit/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
