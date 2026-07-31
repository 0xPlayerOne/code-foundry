import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectLanguages, recommendRunners, resolveProfile } from '../src/lib/profile.mjs'
import { approvedReleaseFiles, classifyPromotion, classifyReconciliation } from '../src/lib/release-policy.mjs'
import { buildReleaseRecoveryPlan, selectReleaseCredential, validateReleasePullRequests } from '../src/lib/release-policy.mjs'
import { buildReleaseConfig, buildReleaseManifest, detectReleasePackages, validateReleaseConfig } from '../src/lib/release-manifest.mjs'
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

  it('skips root tooling when detected languages only exist in nested source trees', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-nested-source-'))
    mkdirSync(join(root, '.github'), { recursive: true })
    mkdirSync(join(root, 'sdk/typescript'), { recursive: true })
    mkdirSync(join(root, 'scripts'), { recursive: true })
    writeFileSync(join(root, 'sdk/typescript/index.ts'), 'export const value = 1\n')
    writeFileSync(join(root, 'scripts/tool.py'), 'print("tool")\n')
    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript,python\npackage_manager: none\n')

    for (const task of ['format', 'lint', 'type_check', 'build', 'unit', 'integration', 'e2e', 'smoke']) {
      const result = spawnSync(process.execPath, [runtime, 'ci', 'should_run', task], {
        cwd: root,
        encoding: 'utf8',
        env: testEnv,
      })
      assert.equal(result.status, 0, `${task}: ${result.stderr}`)
      assert.match(result.stdout, /applicable=false/)
    }
  })

  it('initializes a language-neutral repository without formatter configs', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-init-'))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/workflows/slither.yml'), 'name: Slither\n')
    syncRepository({ target: root, source: process.cwd(), init: true })

    assert.equal(resolveProfile(root).languages, 'none')
    assert.match(readFileSync(join(root, '.github/code-foundry.yml'), 'utf8'), /toolchain: auto/)
    assert.match(readFileSync(join(root, '.github/code-foundry.yml'), 'utf8'), /codeql_rust_shards: \["all"\]/)
    assert.match(readFileSync(join(root, '.github/code-foundry.yml'), 'utf8'), /codeql_rust_threads: 1/)
    assert.match(readFileSync(join(root, '.github/code-foundry.yml'), 'utf8'), /codeql_rust_max_parallel: 1/)
    assert.match(readFileSync(join(root, '.github/code-foundry.yml'), 'utf8'), /post_release_workflow:\n/)
    assert.equal(exists(join(root, 'ruff.toml')), false)
    assert.equal(exists(join(root, '.prettierrc')), false)
    assert.match(readFileSync(join(root, 'LICENSE'), 'utf8'), /GNU GENERAL PUBLIC LICENSE/)
    assert.match(
      readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'),
      /code-foundry\/\.github\/workflows\/ci\.yml@v/
    )
    assert.equal(exists(join(root, '.github/workflows/slither.yml')), true)
    assert.equal(exists(join(root, '.github/workflows/opencode-security.yml')), false)
    const codeqlWorkflow = readFileSync(join(root, '.github/workflows/codeql.yml'), 'utf8')
    assert.match(codeqlWorkflow, /rust-shards: '\["all"\]'/)
    assert.match(codeqlWorkflow, /rust-threads: '1'/)
    assert.match(codeqlWorkflow, /rust-max-parallel: 1/)
    assert.equal(exists(join(root, 'docs/EXTENSIONS.md')), true)
    doctor(root)
  })

  it('rejects unsafe Rust CodeQL parallelism configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-codeql-config-'))
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(
      join(root, '.github/code-foundry.yml'),
      "languages: rust\npackage_manager: none\ncodeql_rust_shards: '[\"../outside\"]'\n"
    )

    assert.throws(
      () => syncRepository({ target: root, source: process.cwd() }),
      /Invalid Rust CodeQL shard path/
    )
  })

  it('renders bounded Rust CodeQL parallelism from canonical configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-codeql-parallel-'))
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(
      join(root, '.github/code-foundry.yml'),
      [
        'languages: rust',
        'package_manager: none',
        "codeql_rust_shards: '[\"crates/api\",\"crates/worker\"]'",
        'codeql_rust_threads: 4',
        'codeql_rust_max_parallel: 2',
        '',
      ].join('\n')
    )

    syncRepository({ target: root, source: process.cwd() })
    const workflow = readFileSync(join(root, '.github/workflows/codeql.yml'), 'utf8')
    assert.match(workflow, /rust-shards: '\["crates\/api","crates\/worker"\]'/)
    assert.match(workflow, /rust-threads: '4'/)
    assert.match(workflow, /rust-max-parallel: 2/)
  })

  it('renders the configured unit runner independently from the test runner', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-unit-runner-'))
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(
      join(root, '.github/code-foundry.yml'),
      [
        'languages: rust',
        'package_manager: none',
        'test_runner: ubuntu-latest',
        'unit_runner: ubuntu-latest',
        '',
      ].join('\n')
    )

    syncRepository({ target: root, source: process.cwd() })
    const workflow = readFileSync(join(root, '.github/workflows/test.yml'), 'utf8')
    assert.match(workflow, /runner: ubuntu-latest/)
    assert.match(workflow, /unit-runner: ubuntu-latest/)
  })

  it('lets a manifest Release Please config own the release strategy', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8')

    assert.match(workflow, /if \(!releaseConfig\.packages && !releaseConfig\['release-type'\]\)/)
    assert.match(workflow, /legacyReleaseType = releaseType/)
    assert.match(workflow, /else if \(!fs\.existsSync\('\.release-please-manifest\.json'\)\)/)
    assert.match(workflow, /run code-foundry sync to bootstrap the release manifest/)
    assert.match(workflow, /config-file: release-please-config\.json/)
    assert.match(workflow, /release-type: \$\{\{ steps\.profile\.outputs\.legacy_release_type \}\}/)
    assert.match(workflow, /release validate-prs/)
    assert.match(workflow, /--admin/)
    assert.match(workflow, /release_merge_strategy=/)
    assert.match(workflow, /release_merge_strategy \|\| config\.merge_strategy/)
    assert.match(workflow, /\$\{\{\s*steps\.profile\.outputs\.release_merge_strategy\s*\}\}/)
    assert.match(workflow, /name: Release \/ Reconcile\n\s+needs: release\n\s+if: needs\.release\.result == 'success'/)
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
    assert.deepEqual(
      classifyReconciliation({
        mainSha: 'main',
        stagingSha: 'staging',
        mergeBaseSha: 'older',
        mainChangedPaths: [],
        stagingChangedPaths: [],
        allowed,
      }),
      { action: 'aligned', reason: 'Branches have different history but identical content.' },
    )
  })

  it('suppresses only release-only divergence from a rebased promotion', () => {
    const allowed = approvedReleaseFiles({
      packages: { web: { 'extra-files': ['src/version.ts'] } },
    })
    assert.deepEqual(
      classifyPromotion({
        mainIsAncestor: false,
        directChangedPaths: ['CHANGELOG.md', 'package.json', 'web/src/version.ts'],
        allowed,
      }),
      { releaseOnly: true, unexpected: [] },
    )
    assert.equal(
      classifyPromotion({
        mainIsAncestor: true,
        directChangedPaths: ['CHANGELOG.md'],
        allowed,
      }).releaseOnly,
      false,
    )
    assert.deepEqual(
      classifyPromotion({
        mainIsAncestor: false,
        directChangedPaths: ['CHANGELOG.md', 'src/index.ts'],
        allowed,
      }),
      { releaseOnly: false, unexpected: ['src/index.ts'] },
    )
  })

  it('guards the promotion workflow against release-only divergence', () => {
    const workflow = readFileSync('.github/workflows/release-pr.yml', 'utf8')

    assert.match(workflow, /fetch-depth: 0/)
    assert.match(workflow, /git merge-base --is-ancestor origin\/main origin\/staging/)
    assert.match(workflow, /git diff --name-only origin\/staging origin\/main/)
    assert.match(workflow, /release_only=\$RELEASE_ONLY/)
    assert.match(workflow, /steps\.check-pr\.outputs\.release_only == 'true'/)
    assert.match(workflow, /steps\.check-pr\.outputs\.release_only != 'true'/)
  })

  it('keys runtime concurrency by event so promotion PRs do not cancel push checks', () => {
    for (const workflow of ['ci', 'codeql', 'security', 'test']) {
      const runtime = readFileSync(`.github/workflows/${workflow}.yml`, 'utf8')
      assert.match(runtime, /code-foundry-\w+-\$\{\{ github\.event_name \}\}-\$\{\{ github\.event\.pull_request\.head\.repo\.full_name \|\| github\.repository \}\}/)
    }
  })

  it('attaches required checks to staging and main pull requests', () => {
    for (const workflow of ['ci', 'codeql', 'security', 'test', 'opencode-security']) {
      const caller = readFileSync(`.github/workflows/${workflow}_self-ci.yml`, 'utf8')
      assert.match(caller, /pull_request:\n\s+branches: \[main, staging\]/)
    }
  })

  it('keeps generated Rust CodeQL configuration inside the workspace', () => {
    const workflow = readFileSync('.github/workflows/codeql.yml', 'utf8')

    assert.match(workflow, /config_file="\$GITHUB_WORKSPACE\/\.github\/codeql-rust-\$scope_id\.yml"/)
    assert.doesNotMatch(workflow, /config_file="\$RUNNER_TEMP\/codeql-rust-/)
  })

  it('does not duplicate canonical checks in the release PR caller', () => {
    const caller = readFileSync('.github/workflows/release-pr_self-ci.yml', 'utf8')

    assert.match(caller, /^\s{2}release-pr:/m)
    for (const duplicate of ['ci', 'test', 'security', 'codeql']) {
      assert.doesNotMatch(caller, new RegExp(`^  ${duplicate}:`, 'm'))
    }
  })

  it('bootstraps a Release Please manifest from current package versions', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-manifest-seed-'))
    mkdirSync(join(root, 'web/src'), { recursive: true })
    mkdirSync(join(root, 'service'), { recursive: true })
    writeFileSync(join(root, 'web/package.json'), '{"name":"fixture-web","version":"1.2.3"}\n')
    writeFileSync(join(root, 'web/src/version.ts'), 'export const version = "1.2.3"\n')
    writeFileSync(join(root, 'service/Cargo.toml'), '[package]\nname = "fixture-service"\nversion = "0.4.0"\n')

    assert.deepEqual(buildReleaseManifest(root, { packages: { '.': {}, web: {}, service: {} } }), {
      '.': '0.0.0',
      web: '1.2.3',
      service: '0.4.0',
    })
    assert.deepEqual(buildReleaseManifest(root, { 'release-type': 'node' }), { '.': '0.0.0' })
    assert.equal(buildReleaseManifest(root, {}), null)
    assert.equal(buildReleaseManifest(root, { packages: {} }), null)
  })

  it('bootstraps the release manifest during sync without regressing owned versions', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-sync-manifest-'))
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"2.1.0"}\n')
    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\nrelease_type: node\n')

    syncRepository({ target: root, source: process.cwd(), init: true })
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.release-please-manifest.json'), 'utf8')), { '.': '2.1.0' })

    // A later sync must not regress a manifest that release-please owns.
    writeFileSync(join(root, '.release-please-manifest.json'), '{\n  ".": "3.0.0"\n}\n')
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"2.1.0"}\n')
    syncRepository({ target: root, source: process.cwd() })
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.release-please-manifest.json'), 'utf8')), { '.': '3.0.0' })
  })

  it('reports a missing release manifest during doctor', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-doctor-manifest-'))
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(join(root, 'release-please-config.json'), '{"release-type": "node"}\n')
    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\nrelease_type: node\n')

    const result = run('doctor', '--target', root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /\.release-please-manifest\.json.*code-foundry sync/)
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

  it('preserves an explicit Release Please packages policy', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-release-policy-'))
    mkdirSync(join(root, 'apps/web'), { recursive: true })
    mkdirSync(join(root, 'third_party/vendor'), { recursive: true })
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "1.0.0"\n')
    writeFileSync(join(root, 'apps/web/package.json'), '{"name":"fixture-web","version":"1.0.0"}\n')
    writeFileSync(join(root, 'third_party/vendor/Cargo.toml'), '[package]\nname = "vendor"\nversion = "1.0.0"\n')

    const explicit = {
      packages: { '.': { 'release-type': 'rust', 'package-name': 'fixture' } },
      'extra-files': ['apps/web/package.json'],
    }
    assert.deepEqual(buildReleaseConfig(root, explicit), explicit)
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

  it('packages the Python formatter baseline for Python consumers', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-python-init-'))
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "python-fixture"\nversion = "1.0.0"\n')
    syncRepository({ target: root, source: process.cwd(), init: true })
    assert.match(readFileSync(join(root, 'ruff.toml'), 'utf8'), /line-length = 100/)
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
