import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectLanguages, resolveProfile } from '../src/lib/profile.mjs'
import { doctor } from '../src/commands/doctor.mjs'
import { syncRepository } from '../src/commands/sync.mjs'

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
const runtime = fileURLToPath(new URL('../src/runtime.mjs', import.meta.url))
const testEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== 'GITHUB_OUTPUT')
)

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

  it('keeps paid GitHub security features opt-in for private repositories', () => {
    const result = spawnSync(process.execPath, [runtime, 'codeql'], {
      encoding: 'utf8',
      env: { ...testEnv, REPO_FOUNDRY_PRIVATE: 'true' },
    })

    assert.equal(result.status, 0)
    assert.match(result.stdout, /enabled=false/)
    assert.match(result.stdout, /languages=\[\]/)
  })

  it('treats internal repositories like private repositories for auto policies', () => {
    const result = spawnSync(process.execPath, [runtime, 'codeql'], {
      encoding: 'utf8',
      env: { ...testEnv, REPO_FOUNDRY_VISIBILITY: 'internal', REPO_FOUNDRY_PRIVATE: 'false' },
    })

    assert.equal(result.status, 0)
    assert.match(result.stdout, /enabled=false/)
  })

  it('profiles language-specific repositories without scanning dependencies', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-profile-'))
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "fixture"\n')
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    writeFileSync(join(root, 'node_modules/vendor.js'), 'ignored fixture content\n')

    assert.deepEqual(detectLanguages(root), ['rust'])
    assert.equal(resolveProfile(root).package_manager, 'none')
  })

  it('initializes a language-neutral repository without formatter configs', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-init-'))
    syncRepository({ target: root, source: process.cwd(), init: true })

    assert.equal(resolveProfile(root).languages, 'none')
    assert.match(readFileSync(join(root, '.github/code-foundry.yml'), 'utf8'), /toolchain: auto/)
    assert.equal(exists(join(root, 'ruff.toml')), false)
    assert.equal(exists(join(root, '.prettierrc')), false)
    assert.match(readFileSync(join(root, 'LICENSE'), 'utf8'), /GNU GENERAL PUBLIC LICENSE/)
    assert.match(
      readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'),
      /code-foundry\/\.github\/workflows\/ci\.yml@v/
    )
    doctor(root)
  })

  it('lets a manifest Release Please config own the release strategy', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8')

    assert.match(workflow, /if \(!releaseConfig\.packages && !releaseConfig\['release-type'\]\)/)
    assert.match(workflow, /legacyReleaseType = releaseType/)
    assert.match(workflow, /config-file: release-please-config\.json/)
    assert.match(workflow, /release-type: \$\{\{ steps\.profile\.outputs\.legacy_release_type \}\}/)
  })
})

function exists(file) {
  try {
    readFileSync(file)
    return true
  } catch {
    return false
  }
}
