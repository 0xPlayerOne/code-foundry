import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

test('package entry declarations expose the runtime exports to TypeScript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'code-foundry-types-'))
  try {
    mkdirSync(join(dir, 'node_modules'))
    symlinkSync(resolve('.'), join(dir, 'node_modules', 'code-foundry'), 'dir')
    writeFileSync(
      join(dir, 'consumer.mts'),
      `import { taskProfile, runRuntime } from 'code-foundry'
const applicable: boolean = taskProfile('.', 'unit').applicable
const result: number = runRuntime(['ci', 'plan'])
// @ts-expect-error invalid argument
runRuntime('ci')
`
    )
    const runtime = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "import { taskProfile, runRuntime } from 'code-foundry'; if (typeof taskProfile !== 'function' || typeof runRuntime !== 'function') process.exit(1)",
      ],
      { cwd: dir, encoding: 'utf8' }
    )
    assert.equal(runtime.status, 0, runtime.stderr)
    const result = spawnSync(
      process.execPath,
      [
        resolve('node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--strict',
        '--module',
        'nodenext',
        '--moduleResolution',
        'nodenext',
        join(dir, 'consumer.mts'),
      ],
      { encoding: 'utf8' }
    )
    assert.equal(result.status, 0, result.stdout + result.stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
