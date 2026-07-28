import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))

function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
}

describe('code-foundry CLI', () => {
  it('prints help without requiring a project or shell tools', () => {
    const result = run('--help')

    assert.equal(result.status, 0)
    assert.match(result.stdout, /code-foundry .* initialize and maintain/)
  })

  it('rejects unknown commands with a useful exit code', () => {
    const result = run('unknown-command')

    assert.equal(result.status, 2)
    assert.match(result.stderr, /unknown command: unknown-command/)
  })
})
