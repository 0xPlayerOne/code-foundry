import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectLanguages, recommendRunners, resolveProfile } from '../src/lib/profile.mjs'
import { approvedReleaseFiles, classifyReconciliation } from '../src/lib/release-policy.mjs'
import { buildReleaseRecoveryPlan, selectReleaseCredential, validateReleasePullRequests } from '../src/lib/release-policy.mjs'
import { buildReleaseConfig, detectReleasePackages, validateReleaseConfig } from '../src/lib/release-manifest.mjs'
import { hasDeliveredHook, releaseDeliveryKey, selectHookDelivery } from '../src/lib/release-hook.mjs'
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
    assert.match(workflow, /release validate-prs/)
    assert.match(workflow, /--admin/)
    assert.match(workflow, /--rebase/)
  })

  it('leaves release pull requests open when auto-merge credentials are unavailable', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8')

    assert.match(workflow, /name: Detect release credentials/)
    assert.match(workflow, /echo "auto_merge=false"/)
    assert.match(workflow, /name: Leave release pull request for manual merge/)
    assert.match(workflow, /steps\.credentials\.outputs\.auto_merge != 'true'/)
    assert.match(workflow, /steps\.credentials\.outputs\.auto_merge == 'true'/)
    assert.match(workflow, /GH_TOKEN: \$\{\{ secrets\.RELEASE_PLEASE_TOKEN \}\}/)
  })

  it('allows only release metadata during post-release reconciliation', () => {
    const allowed = approvedReleaseFiles({
      'extra-files': ['version.txt'],
      packages: { web: { 'extra-files': ['src/version.ts'] } },
    })
    assert.deepEqual(
      classifyReconciliation({
        mainSha: 'main',
        stagingSha: 'staging',
        mergeBaseSha: 'staging',
        mainChangedPaths: ['CHANGELOG.md', 'package.json'],
        stagingChangedPaths: [],
        allowed,
      }),
      { action: 'fast-forward', targetSha: 'main', reason: 'main only added approved release metadata.' },
    )
    assert.equal(
      classifyReconciliation({
        mainSha: 'main',
        stagingSha: 'staging',
        mergeBaseSha: 'staging',
        mainChangedPaths: ['src/index.ts'],
        allowed,
      }).action,
      'fail',
    )
  })

  it('generates a mixed-language Release Please manifest without losing custom fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-release-manifest-'))
    mkdirSync(join(root, 'web/src'), { recursive: true })
    mkdirSync(join(root, 'service'), { recursive: true })
    writeFileSync(join(root, 'web/package.json'), '{"name":"fixture-web","version":"1.0.0"}\n')
    writeFileSync(join(root, 'web/src/version.ts'), 'export const version = "1.0.0"\n')
    writeFileSync(join(root, 'service/Cargo.toml'), '[package]\nname = "fixture-service"\nversion = "1.0.0"\n')
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "fixture-python"\nversion = "1.0.0"\n')

    const packages = detectReleasePackages(root)
    assert.deepEqual(packages.map(({ directory, releaseType }) => [directory, releaseType]), [
      ['.', 'python'],
      ['service', 'rust'],
      ['web', 'node'],
    ])
    const config = buildReleaseConfig(root, { 'changelog-sections': [{ type: 'feat', section: 'Features' }] })
    assert.deepEqual(config['changelog-sections'], [{ type: 'feat', section: 'Features' }])
    assert.equal(config.packages['web']['release-type'], 'node')
    assert.deepEqual(config.packages['web']['extra-files'], ['src/version.ts'])
    assert.deepEqual(validateReleaseConfig(root, config), [])
  })

  it('selects one token-aware post-release delivery and prevents duplicate tags', () => {
    assert.equal(selectHookDelivery({ mode: 'auto', tokenPresent: true }).delivery, 'workflow-dispatch')
    assert.equal(selectHookDelivery({ mode: 'auto', tokenPresent: false }).delivery, 'release-event')
    assert.equal(selectHookDelivery({ mode: 'disabled', tokenPresent: true }).delivery, 'disabled')
    const key = releaseDeliveryKey('owner/repo', 'v1.2.3')
    assert.match(key, /^[a-f0-9]{24}$/)
    assert.equal(hasDeliveredHook([{ headBranch: 'v1.2.3', status: 'completed' }], 'v1.2.3'), true)
    assert.equal(hasDeliveredHook([{ headBranch: 'v1.2.4', status: 'completed' }], 'v1.2.3'), false)
  })

  it('keeps release policy decisions executable and deterministic', () => {
    assert.equal(selectReleaseCredential({ releasePleaseToken: 'secret', githubToken: 'fallback' }).source, 'release-please-token')
    assert.equal(selectReleaseCredential({ githubToken: 'fallback' }).autoMerge, false)
    assert.equal(selectReleaseCredential({}).source, 'missing')
    const allowed = new Set(['CHANGELOG.md', 'package.json'])
    const generated = [{ number: 42, title: 'chore(main): release 1.2.3', headRefName: 'release-please--branches--main' }]
    const valid = validateReleasePullRequests(generated, new Map([[42, ['CHANGELOG.md', 'package.json']]]), allowed)
    assert.equal(valid.valid, true)
    assert.equal(validateReleasePullRequests(generated, new Map([[42, ['src/index.ts']]]), allowed).valid, false)
    assert.equal(validateReleasePullRequests(generated, new Map([[42, []]]), allowed).valid, false)
    assert.equal(validateReleasePullRequests([], new Map(), allowed).valid, false)
    assert.equal(validateReleasePullRequests([{ number: 7, title: 'chore(main): release 1.2.3' }], new Map([[7, ['CHANGELOG.md']]]), allowed).valid, false)
  })

  it('recommends full runners for native-toolchain repositories', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-runner-'))
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "runner-fixture"\n')
    assert.equal(recommendRunners(root).unit_runner, 'ubuntu-latest')
    assert.equal(recommendRunners(root).security_runner, 'ubuntu-slim')
    const browser = mkdtempSync(join(tmpdir(), 'code-foundry-browser-'))
    writeFileSync(join(browser, 'playwright.config.ts'), 'export default {}\n')
    assert.equal(recommendRunners(browser).test_runner, 'ubuntu-latest')
  })

  it('produces a non-destructive release recovery plan', () => {
    const plan = buildReleaseRecoveryPlan({
      tags: ['v1.0.0', 'v1.1.0'],
      releases: [{ tagName: 'v1.0.0' }],
      releasePrs: [{ number: 9, title: 'chore(main): release 1.1.0' }],
      packageVersions: ['1.1.0'],
    })
    assert.deepEqual(plan.missingGitHubReleases, ['v1.1.0'])
    assert.deepEqual(plan.pendingReleasePullRequests, [{ number: 9, title: 'chore(main): release 1.1.0' }])
    assert.equal(plan.packageVersionMismatch, false)
    assert.match(plan.actions[0], /v1\.1\.0/)
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
