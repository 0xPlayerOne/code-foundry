import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { appendFileSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectLanguages, recommendRunners, resolveProfile } from '../src/lib/profile.mjs'
import { approvedReleaseFiles, classifyPromotion, classifyReconciliation } from '../src/lib/release-policy.mjs'
import { buildReleaseRecoveryPlan, selectReleaseCredential, validateReleasePullRequests } from '../src/lib/release-policy.mjs'
import { validateGeneratedReleaseDiff } from '../src/lib/release-policy.mjs'
import { buildReleaseConfig, buildReleaseManifest, detectReleasePackages, validateReleaseConfig } from '../src/lib/release-manifest.mjs'
import {
  AGGREGATE_CHECK_NAME,
  RELEASE_PLEASE_PREFIX,
  VALIDATION_EVENTS,
  VALIDATION_JOBS,
  VALIDATION_MODES,
  classifyValidationMode,
  evaluateValidationGate,
  isReleasePleaseHead,
  requiredValidationJobs,
} from '../src/lib/validation-policy.mjs'
import { hasDeliveredHook, releaseDeliveryKey, selectHookDelivery } from '../src/lib/release-hook.mjs'
import { doctor } from '../src/commands/doctor.mjs'
import { doctorGithub } from '../src/lib/github-doctor.mjs'
import { reconcileRelease } from '../src/commands/release.mjs'
import { syncRepository } from '../src/commands/sync.mjs'

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
const runtime = fileURLToPath(new URL('../src/runtime.mjs', import.meta.url))
const testEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== 'GITHUB_OUTPUT')
)

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' })
}

function remoteHeadSha(root, branch) {
  const result = git(root, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])
  if (result.status !== 0) return ''
  const [sha] = result.stdout.trim().split(/\t/, 1)
  return sha || ''
}

/**
 * Assert main is an ancestor of head in the remote-tracked branch refs.
 * @param {Object} context
 * @param {Function} context.run
 * @param {string} context.base
 * @param {string} context.head
 */
function assertRemoteMainAncestor(context) {
  const { run, base, head } = context
  const fetched = run(['fetch', 'origin', base, head])
  assert.equal(fetched.status, 0, fetched.stderr)
  const ancestor = run(['merge-base', '--is-ancestor', `origin/${base}`, `origin/${head}`])
  assert.equal(ancestor.status, 0, ancestor.stderr)
}

/**
 * Run a function with temporary GitHub env variables.
 * @param {Record<string, string | undefined>} env
 * @param {Function} fn
 */
function withGitHubEnv(env, fn) {
  const previous = {
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  }
  Object.entries(env).forEach(([key, value]) => {
    if (value == null) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  })
  try {
    return fn()
  } finally {
    if (previous.GITHUB_REPOSITORY == null) {
      delete process.env.GITHUB_REPOSITORY
    } else {
      process.env.GITHUB_REPOSITORY = previous.GITHUB_REPOSITORY
    }
    if (previous.GH_TOKEN == null) {
      delete process.env.GH_TOKEN
    } else {
      process.env.GH_TOKEN = previous.GH_TOKEN
    }
    if (previous.GITHUB_TOKEN == null) {
      delete process.env.GITHUB_TOKEN
    } else {
      process.env.GITHUB_TOKEN = previous.GITHUB_TOKEN
    }
  }
}

/**
 * @param {string[]} secretNames
 * @param {Function} fn
 */
function withFakeGh(secretNames, fn) {
  const oldPath = process.env.PATH
  const dir = mkdtempSync(join(tmpdir(), 'code-foundry-gh-'))
  const script = join(dir, 'gh')
  const payload = secretNames.map((name) => ({ name })).map((entry) => JSON.stringify(entry)).join(',\n')
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set -euo pipefail
if [ \"$1\" = \"--version\" ]; then
  echo 'gh version 2.55.0'
  exit 0
fi
if [ \"$1\" = \"secret\" ] && [ \"$2\" = \"list\" ]; then
  cat <<'JSON'
[${payload}]
JSON
  exit 0
fi
if [ \"$1\" = \"api\" ]; then
  case \"$2\" in
    repos/*/rulesets)
      echo '[]'
      ;;
    repos/*/rulesets/*)
      echo '{}'
      ;;
    repos/*/branches/main/protection)
      echo '{}'
      ;;
    repos/*/git/ref/heads/main)
      echo '{"object":{"sha":"abc"}}'
      ;;
    repos/*/commits/main/check-runs*)
      echo '{"check_runs":[]}'
      ;;
    *)
      echo '{}'
      ;;
  esac
  exit 0
fi
if [ \"$1\" = \"variable\" ] && [ \"$2\" = \"list\" ]; then
  echo '[]'
  exit 0
fi
if [ \"$1\" = \"pr\" ] && [ \"$2\" = \"list\" ]; then
  echo '[]'
  exit 0
fi
echo '{}'
`,
  )
  chmodSync(script, 0o755)
  process.env.PATH = `${dir}:${oldPath}`
  try {
    return fn()
  } finally {
    process.env.PATH = oldPath
    rmSync(dir, { recursive: true, force: true })
  }
}

function createReconcileWorkspace() {
  const remote = mkdtempSync(join(tmpdir(), 'code-foundry-remote-'))
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-workspace-'))
  git(remote, ['init', '--bare'])
  const run = (args) => git(root, args)
  run(['init', '-q'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test'])
  run(['remote', 'add', 'origin', remote])
  return { root, remote, run }
}

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
    assert.match(readFileSync(join(root, '.github/code-foundry.yml'), 'utf8'), /codeql_rust_shards: '\["all"\]'/)
    assert.match(readFileSync(join(root, '.github/code-foundry.yml'), 'utf8'), /codeql_rust_threads: 1/)
    assert.match(readFileSync(join(root, '.github/code-foundry.yml'), 'utf8'), /codeql_rust_max_parallel: 1/)
    assert.match(readFileSync(join(root, '.github/code-foundry.yml'), 'utf8'), /post_release_workflow:\n/)
    assert.equal(exists(join(root, 'ruff.toml')), false)
    assert.equal(exists(join(root, '.prettierrc')), false)
    assert.match(readFileSync(join(root, 'LICENSE'), 'utf8'), /GNU GENERAL PUBLIC LICENSE/)
    const validationCaller = readFileSync(join(root, '.github/workflows/validation.yml'), 'utf8')
    assert.match(validationCaller, /code-foundry\/\.github\/workflows\/validation\.yml@v/)
    assert.equal(exists(join(root, '.github/workflows/slither.yml')), true)
    assert.equal(exists(join(root, '.github/workflows/opencode-security.yml')), false)
    for (const legacy of ['ci', 'test', 'security', 'codeql']) {
      assert.equal(exists(join(root, `.github/workflows/${legacy}.yml`)), false, legacy)
    }
    assert.match(validationCaller, /rust-shards: '\["all"\]'/)
    assert.match(validationCaller, /rust-threads: '1'/)
    assert.match(validationCaller, /rust-max-parallel: 1/)
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
    const workflow = readFileSync(join(root, '.github/workflows/validation.yml'), 'utf8')
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
    const workflow = readFileSync(join(root, '.github/workflows/validation.yml'), 'utf8')
    assert.match(workflow, /test-runner: ubuntu-latest/)
    assert.match(workflow, /unit-runner: ubuntu-latest/)
  })

  it('migrates generated legacy callers and preserves custom workflows byte-for-byte', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-migrate-'))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\n')
    for (const stem of ['ci', 'test', 'security', 'codeql']) {
      writeFileSync(join(root, `.github/workflows/${stem}.yml`), legacyCaller(stem))
    }
    const custom = 'name: Deploy\n\non:\n  push:\n    branches: [main]\n\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n'
    writeFileSync(join(root, '.github/workflows/deploy.yml'), custom)

    const result = syncRepository({ target: root, source: process.cwd() })

    for (const stem of ['ci', 'test', 'security', 'codeql']) {
      assert.equal(exists(join(root, `.github/workflows/${stem}.yml`)), false, stem)
    }
    assert.equal(readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8'), custom)
    assert.equal(exists(join(root, '.github/workflows/validation.yml')), true)
    assert.ok(result.changed.includes('.github/workflows/ci.yml'))
    assert.ok(result.changed.includes('.github/workflows/validation.yml'))
    const caller = readFileSync(join(root, '.github/workflows/validation.yml'), 'utf8')
    assert.match(caller, /^\s+ref: v\d+\.\d+\.\d+$/m)
    assert.match(caller, /runtime-ref: v\d+\.\d+\.\d+/)
  })

  it('preserves unrecognized legacy-named callers as repository-owned workflows', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-preserve-'))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\n')
    const custom = 'name: Custom CI\n\non:\n  pull_request:\n\npermissions:\n  contents: read\n\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo custom\n'
    writeFileSync(join(root, '.github/workflows/ci.yml'), custom)

    syncRepository({ target: root, source: process.cwd() })

    assert.equal(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'), custom)
  })

  it('keeps the tiered topology idempotent across repeated syncs', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-idempotent-'))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/workflows/deploy.yml'), 'name: Deploy\n')
    syncRepository({ target: root, source: process.cwd(), init: true })

    const second = syncRepository({ target: root, source: process.cwd() })

    assert.deepEqual(second.changed, [])
    assert.equal(readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8'), 'name: Deploy\n')
  })

  it('previews legacy caller removal in dry-run without writing files', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-dryrun-'))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\n')
    writeFileSync(join(root, '.github/workflows/ci.yml'), legacyCaller('ci'))

    const preview = syncRepository({ target: root, source: process.cwd(), dryRun: true })

    assert.ok(preview.changed.includes('.github/workflows/ci.yml'))
    assert.equal(exists(join(root, '.github/workflows/ci.yml')), true)
    assert.equal(exists(join(root, '.github/workflows/validation.yml')), false)
    const real = syncRepository({ target: root, source: process.cwd() })
    assert.equal(exists(join(root, '.github/workflows/ci.yml')), false)
    assert.equal(exists(join(root, '.github/workflows/validation.yml')), true)
    assert.ok(real.changed.includes('.github/workflows/validation.yml'))
  })

  it('doctor flags stale legacy callers and unpinned or mismatched runtime refs', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-doctor-validation-'))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\n')
    syncRepository({ target: root, source: process.cwd() })
    const callerPath = join(root, '.github/workflows/validation.yml')
    const captureWarnings = (fn) => {
      /** @type {string[]} */
      const warnings = []
      const original = console.warn
      console.warn = (message) => warnings.push(String(message))
      try { fn() } finally { console.warn = original }
      return warnings
    }
    const captureErrors = (fn) => {
      /** @type {string[]} */
      const errors = []
      const original = console.error
      console.error = (message) => errors.push(String(message))
      try { fn() } catch { /* doctor throws only a summary; details are in errors */ } finally { console.error = original }
      return errors
    }
    writeFileSync(join(root, '.github/workflows/ci.yml'), legacyCaller('ci'))
    const stale = captureWarnings(() => doctor(root))
    assert.ok(stale.some((message) => /stale generated legacy caller ci\.yml/.test(message)), stale.join('\n'))

    const mismatched = readFileSync(callerPath, 'utf8').replace(/^(\s+)ref: v\d+\.\d+\.\d+$/m, '$1ref: v0.31.0')
    writeFileSync(callerPath, mismatched)
    const mismatchErrors = captureErrors(() => doctor(root))
    assert.ok(mismatchErrors.some((message) => /mismatched runtime refs/.test(message)), mismatchErrors.join('\n'))

    const unpinned = readFileSync(callerPath, 'utf8')
      .replace(/runtime-ref: v\d+\.\d+\.\d+/, 'runtime-ref: main')
      .replace(/^(\s+)ref: v\d+\.\d+\.\d+$/m, '$1ref: main')
    writeFileSync(callerPath, unpinned)
    const warning = captureWarnings(() => doctor(root))
    assert.ok(warning.some((message) => /not a released tag/.test(message)), warning.join('\n'))
  })

  it('reports both CODE_FOUNDRY_TOKEN and RELEASE_PLEASE_TOKEN states in the github doctor', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-doctor-tokens-'))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })

    const both = withFakeGh(['CODE_FOUNDRY_TOKEN', 'RELEASE_PLEASE_TOKEN'], () =>
      withGitHubEnv({ GITHUB_REPOSITORY: 'owner/repo' }, () => doctorGithub(root))
    )
    assert.equal(both.details.secrets.codeFoundryTokenPresent, true)
    assert.equal(both.details.secrets.releasePleaseTokenPresent, true)

    for (const token of ['CODE_FOUNDRY_TOKEN', 'RELEASE_PLEASE_TOKEN']) {
      const one = withFakeGh([token], () =>
        withGitHubEnv({ GITHUB_REPOSITORY: 'owner/repo' }, () => doctorGithub(root))
      )
      assert.doesNotMatch(one.warnings.join(' '), /are both absent/i)
    }

    const neither = withFakeGh([], () =>
      withGitHubEnv({ GITHUB_REPOSITORY: 'owner/repo' }, () => doctorGithub(root))
    )
    const messages = neither.warnings.join(' ')
    assert.equal(neither.details.secrets.codeFoundryTokenPresent, false)
    assert.equal(neither.details.secrets.releasePleaseTokenPresent, false)
    assert.match(messages, /are both absent/i)
    assert.match(messages, /CODE_FOUNDRY_TOKEN.*RELEASE_PLEASE_TOKEN/)
    rmSync(root, { recursive: true, force: true })
  })
  it('passes dedicated token secrets to PR creation reusable workflows', () => {
    const draftCallee = readFileSync('.github/workflows/draft-pr.yml', 'utf8')
    assert.match(draftCallee, /CODE_FOUNDRY_TOKEN:\n\s+required: false/)
    assert.match(draftCallee, /RELEASE_PLEASE_TOKEN:\n\s+required: false/)
    assert.match(draftCallee, /HAS_AUTOMATION_TOKEN: \$\{\{ secrets\.CODE_FOUNDRY_TOKEN != '' \|\| secrets\.RELEASE_PLEASE_TOKEN != '' \}\}/)
    assert.match(draftCallee, /if \[ "\$HAS_AUTOMATION_TOKEN" = true \]; then/)
    assert.match(draftCallee, /DRAFT_ARGS=\(\)/)
    assert.match(draftCallee, /\$\{DRAFT_ARGS\[\@\]\}/)

    const draftCaller = readFileSync('.github/workflows/draft-pr_self-ci.yml', 'utf8')
    assert.match(draftCaller, /secrets:\n\s+CODE_FOUNDRY_TOKEN: \$\{\{ secrets\.CODE_FOUNDRY_TOKEN \}\}/)
    assert.match(draftCaller, /secrets:\n\s+CODE_FOUNDRY_TOKEN: \$\{\{ secrets\.CODE_FOUNDRY_TOKEN \}\}\n\s+RELEASE_PLEASE_TOKEN: \$\{\{ secrets\.RELEASE_PLEASE_TOKEN \}\}/)

    const releaseCaller = readFileSync('.github/workflows/release-pr_self-ci.yml', 'utf8')
    assert.match(releaseCaller, /on:\n\s+push:\n\s+branches: \[staging\]/)
    assert.match(releaseCaller, /secrets:\n\s+CODE_FOUNDRY_TOKEN: \$\{\{ secrets\.CODE_FOUNDRY_TOKEN \}\}/)
    assert.match(releaseCaller, /RELEASE_PLEASE_TOKEN: \$\{\{ secrets\.RELEASE_PLEASE_TOKEN \}\}/)

    const validationCaller = readFileSync('.github/workflows/validation_self-ci.yml', 'utf8')
    assert.match(validationCaller, /types:\n\s+- opened\n\s+- synchronize\n\s+- reopened\n\s+- ready_for_review/)
  })
  it('fails closed on a non-squash release merge strategy and never uses --admin', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8')

    assert.match(workflow, /if \(!releaseConfig\.packages && !releaseConfig\['release-type'\]\)/)
    assert.match(workflow, /legacyReleaseType = releaseType/)
    assert.match(workflow, /else if \(!fs\.existsSync\('\.release-please-manifest\.json'\)\)/)
    assert.match(workflow, /run code-foundry sync to bootstrap the release manifest/)
    assert.match(workflow, /config-file: release-please-config\.json/)
    assert.match(workflow, /release-type: \$\{\{ steps\.profile\.outputs\.legacy_release_type \}\}/)
    assert.match(workflow, /release validate-prs/)
    assert.doesNotMatch(workflow, /--admin/)
    assert.match(workflow, /release_merge_strategy must be "squash"/)
    assert.match(workflow, /release automation never defaults to merge/)
    assert.doesNotMatch(workflow, /release_merge_strategy \|\| config\.merge_strategy/)
    assert.doesNotMatch(workflow, /\|\| 'merge'/)
    assert.match(workflow, /release_merge_strategy=\$\{releaseMergeStrategy\}/)
    assert.match(workflow, /\$\{\{\s*steps\.profile\.outputs\.release_merge_strategy\s*\}\}/)
    assert.match(workflow, /release_head=\$\(gh pr view \"\$pr\"[\s\S]*--json headRefOid[\s\S]*--jq '\.headRefOid'\)/)
    assert.match(workflow, /--match-head-commit \"\$release_head\"/)
    assert.match(workflow, /if \[ -z \"\$release_head\" \]/)
    assert.match(workflow, /name: Release \/ Reconcile\n\s+needs: release\n\s+if: needs\.release\.result == 'success'/)
    assert.match(workflow, /name: Release \/ Reconcile[\s\S]*?GH_TOKEN: \$\{\{ github\.token \}\}/)
  })

  it('doctor and sync reject merge strategies outside the audit topology', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-merge-policy-'))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    const captureErrors = (fn) => {
      /** @type {string[]} */
      const errors = []
      const original = console.error
      console.error = (message) => errors.push(String(message))
      try { fn() } catch { /* doctor throws only a summary; details are in errors */ } finally { console.error = original }
      return errors
    }

    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\nmerge_strategy: rebase\nrelease_merge_strategy: squash\n')
    syncRepository({ target: root, source: process.cwd() })
    assert.doesNotThrow(() => doctor(root))

    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\nmerge_strategy: merge\nrelease_merge_strategy: merge\n')
    const promotion = captureErrors(() => doctor(root))
    assert.ok(promotion.some((message) => /merge_strategy must be "rebase"/.test(message)), promotion.join('\n'))
    assert.ok(promotion.some((message) => /release_merge_strategy must be "squash"/.test(message)), promotion.join('\n'))
    assert.throws(() => syncRepository({ target: root, source: process.cwd() }), /Unsupported merge_strategy: merge/)

    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\nmerge_strategy: rebase\nrelease_merge_strategy: rebase\n')
    const release = captureErrors(() => doctor(root))
    assert.ok(release.some((message) => /release_merge_strategy must be "squash"/.test(message)), release.join('\n'))
    assert.throws(() => syncRepository({ target: root, source: process.cwd() }), /Unsupported release_merge_strategy: rebase/)

    // Release automation is the only consumer of release_merge_strategy;
    // a profile without the release feature never needs the key.
    writeFileSync(join(root, '.github/code-foundry.yml'), 'languages: typescript\npackage_manager: bun\nfeatures: ci,test\nmerge_strategy: rebase\n')
    assert.doesNotThrow(() => syncRepository({ target: root, source: process.cwd() }))
    rmSync(root, { recursive: true, force: true })
  })

  it('documents that GitHub Stacks is outside the merge topology', () => {
    const workflows = readFileSync('docs/WORKFLOWS.md', 'utf8')
    assert.match(workflows, /GitHub Stacks/)
    assert.match(workflows, /does\s+not reduce required workflow runs/)
    assert.match(workflows, /not part of this topology/)
  })

  it('normalizes generated release PR state when draft permissions are unavailable', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8')

    assert.match(workflow, /name: Detect release credentials/)
    assert.match(workflow, /auto_merge=false/)
    assert.match(workflow, /token: \$\{\{ secrets\.CODE_FOUNDRY_TOKEN \|\| secrets\.RELEASE_PLEASE_TOKEN \|\| github\.token \}\}/)
    assert.match(workflow, /name: Normalize generated release PR draft state/)
    assert.match(workflow, /GH_TOKEN: \$\{\{ secrets\.CODE_FOUNDRY_TOKEN \|\| secrets\.RELEASE_PLEASE_TOKEN \|\| github\.token \}\}/)
    assert.match(workflow, /gh pr ready --undo/)
    assert.match(workflow, /No CODE_FOUNDRY_TOKEN or RELEASE_PLEASE_TOKEN is configured/)
    assert.match(workflow, /name: Leave release pull request for manual merge/)
    assert.match(workflow, /steps\.credentials\.outputs\.auto_merge != 'true'/)
    assert.match(workflow, /steps\.credentials\.outputs\.auto_merge == 'true'/)
    assert.match(workflow, /RELEASE_PLEASE_TOKEN: \$\{\{ secrets\.CODE_FOUNDRY_TOKEN \|\| secrets\.RELEASE_PLEASE_TOKEN \}\}/)
    assert.match(workflow, /GH_TOKEN: \$\{\{ secrets\.CODE_FOUNDRY_TOKEN \|\| secrets\.RELEASE_PLEASE_TOKEN \|\| github\.token \}\}/)
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
        mainOnlyCommits: [{ sha: 'r1', changedPaths: ['CHANGELOG.md', 'package.json'] }],
        stagingOnlyCommits: [],
        allowed,
      }),
      { action: 'fast-forward', targetSha: 'main', reason: 'main only added approved release metadata.' },
    )
    assert.equal(
      classifyReconciliation({
        mainSha: 'main',
        stagingSha: 'staging',
        mainOnlyCommits: [{ sha: 'r1', changedPaths: ['src/index.ts'] }],
        stagingOnlyCommits: [],
        allowed,
      }).action,
      'fail',
    )
    assert.deepEqual(
      classifyReconciliation({
        mainSha: 'main',
        stagingSha: 'staging',
        mainOnlyCommits: [],
        stagingOnlyCommits: [],
        allowed,
      }),
      { action: 'aligned', targetSha: 'main', reason: 'Branches have different history but identical content.' },
    )
  })

  it('recommends replaying staging-only work even when it touches release-only files', () => {
    const allowed = approvedReleaseFiles()
    assert.deepEqual(
      classifyReconciliation({
        mainSha: 'main',
        stagingSha: 'staging',
        mainOnlyCommits: [{ sha: 'r1', changedPaths: ['package.json'] }],
        stagingOnlyCommits: [{ sha: 's1', changedPaths: ['package.json', 'bun.lock'] }],
        allowed,
      }),
      {
        action: 'rebase-staging',
        targetSha: 'main',
        mainOnly: ['r1'],
        stagingOnly: ['s1'],
        reason: 'staging contains unpromoted commits; replay them onto main.',
      },
    )
  })

  it('fails when main-only commits include non-release files', () => {
    const allowed = approvedReleaseFiles()
    assert.equal(
      classifyReconciliation({
        mainSha: 'main',
        stagingSha: 'staging',
        mainOnlyCommits: [{ sha: 'main-commit', changedPaths: ['src/index.ts'] }],
        stagingOnlyCommits: [],
        allowed,
      }).action,
      'fail',
    )
    assert.equal(
      classifyReconciliation({
        mainSha: 'main',
        stagingSha: 'staging',
        mainOnlyCommits: [{ sha: 'main-commit', changedPaths: ['src/index.ts'] }],
        stagingOnlyCommits: [{ sha: 'staging-commit', changedPaths: ['src/feature.ts'] }],
        allowed,
      }).action,
      'fail',
    )
  })

  it('surfaces exact reconciliation failure reason from local classification', () => {
    const { root, remote, run } = createReconcileWorkspace()
    const commit = (message) => {
      const result = run(['commit', '-m', message])
      assert.equal(result.status, 0, result.stderr)
      return run(['rev-parse', 'HEAD']).stdout.trim()
    }

    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n')
    run(['add', 'package.json', 'CHANGELOG.md'])
    commit('chore: initial')
    run(['branch', '-M', 'main'])

    run(['checkout', '-q', '-b', 'staging'])
    run(['checkout', '-q', 'main'])
    writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1\n')
    run(['add', 'src/index.ts'])
    commit('chore(main): touch source')

    assert.throws(
      () => reconcileRelease(root, { github: false, dryRun: false, base: 'main', head: 'staging' }),
      /main contains commits that are not release metadata\. Unexpected paths: src\/index.ts/,
    )
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  })

  it('fails when commit metadata inspection is indeterminate', () => {
    const allowed = approvedReleaseFiles()
    assert.equal(
      classifyReconciliation({
        mainSha: 'main',
        stagingSha: 'staging',
        mainOnlyCommits: [{ sha: 'main-commit', changedPaths: undefined }],
        stagingOnlyCommits: [],
        allowed,
      }).action,
      'fail',
    )
  })

  it('plans a rebase for the promotion-copy deadlock topology', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-reconcile-deadlock-'))
    const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    const readRef = (ref) => {
      const result = git(['rev-parse', ref])
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    const commit = (message) => {
      const result = git(['commit', '-m', message])
      assert.equal(result.status, 0, result.stderr)
      return readRef('HEAD')
    }
    const cherryPick = (sha) => {
      const result = git(['cherry-pick', sha])
      assert.equal(result.status, 0, result.stderr)
    }

    git(['init', '-q'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n')
    writeFileSync(join(root, 'src/index.ts'), 'export const base = 1\n')
    git(['add', 'package.json', 'CHANGELOG.md', 'src/index.ts'])
    commit('chore: initial')
    git(['branch', '-M', 'main'])

    git(['checkout', '-q', '-b', 'staging'])
    writeFileSync(join(root, 'src/feature-a.ts'), 'export const a = 1\n')
    git(['add', 'src/feature-a.ts'])
    const featureAOnStaging = commit('feat: add a')
    writeFileSync(join(root, 'src/feature-b.ts'), 'export const b = 1\n')
    git(['add', 'src/feature-b.ts'])
    const featureBOnStaging = commit('feat: add b')

    git(['checkout', '-q', 'main'])
    cherryPick(featureAOnStaging)
    cherryPick(featureBOnStaging)
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.1"}\n')
    appendFileSync(join(root, 'CHANGELOG.md'), '\n## 1.0.1\n', 'utf8')
    git(['add', 'package.json', 'CHANGELOG.md'])
    const releaseCommitSha = commit('chore(main): release 1.0.1')

    git(['checkout', '-q', 'staging'])
    writeFileSync(join(root, 'src/feature-c.ts'), 'export const c = 1\n')
    git(['add', 'src/feature-c.ts'])
    const featureOnlySha = commit('feat: add c')

    const beforeMain = readRef('main')
    const beforeStaging = readRef('staging')
    const plan = reconcileRelease(root, { github: false, dryRun: true, base: 'main', head: 'staging' })
    assert.equal(plan.action, 'rebase-staging')
    assert.deepEqual(plan.mainOnly, [releaseCommitSha])
    assert.equal(plan.stagingOnly.length, 1)
    assert.equal(plan.stagingOnly[0], featureOnlySha)
    assert.equal(beforeMain, readRef('main'))
    assert.equal(beforeStaging, readRef('staging'))
    rmSync(root, { recursive: true, force: true })
  })

  it('replays pending staging-only work on a bare remote', () => {
    const { root, remote, run } = createReconcileWorkspace()
    const readRef = (ref) => {
      const result = run(['rev-parse', ref])
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    const commit = (message) => {
      const result = run(['commit', '-m', message])
      assert.equal(result.status, 0, result.stderr)
      return readRef('HEAD')
    }

    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n')
    writeFileSync(join(root, 'src/index.ts'), 'export const base = 1\n')
    run(['add', 'package.json', 'CHANGELOG.md', 'src/index.ts'])
    commit('chore: initial')
    run(['branch', '-M', 'main'])

    run(['checkout', '-q', '-b', 'staging'])
    writeFileSync(join(root, 'src/feature-pending.ts'), 'export const pending = 1\n')
    run(['add', 'src/feature-pending.ts'])
    commit('feat: pending work')

    run(['checkout', '-q', 'main'])
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.1"}\n')
    appendFileSync(join(root, 'CHANGELOG.md'), '\n## 1.0.1\n', 'utf8')
    run(['add', 'package.json', 'CHANGELOG.md'])
    commit('chore(main): release 1.0.1')

    run(['push', '-u', 'origin', 'main'])
    run(['checkout', '-q', 'staging'])
    run(['push', '-u', 'origin', 'staging'])

    const before = remoteHeadSha(root, 'staging')
    const plan = withGitHubEnv({
      GITHUB_REPOSITORY: 'owner/repo',
      GH_TOKEN: 'token',
    }, () => reconcileRelease(root, { github: true, dryRun: false, base: 'main', head: 'staging' }))
    const after = remoteHeadSha(root, 'staging')

    assert.equal(plan.action, 'rebase-staging')
    assert.equal(plan.synchronization, 'replay')
    assert.notEqual(before, after)
    assertRemoteMainAncestor({ run, base: 'main', head: 'staging' })
    const replayFile = run(['show', `${after}:src/feature-pending.ts`])
    assert.equal(replayFile.status, 0)
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  })

  it('does not mutate remote staging when replay conflicts and leaves it unchanged', () => {
    const { root, remote, run } = createReconcileWorkspace()
    const readRef = (ref) => {
      const result = run(['rev-parse', ref])
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    const commit = (message) => {
      const result = run(['commit', '-m', message])
      assert.equal(result.status, 0, result.stderr)
      return readRef('HEAD')
    }

    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n')
    run(['add', 'package.json', 'CHANGELOG.md'])
    commit('chore: initial')
    run(['branch', '-M', 'main'])

    run(['checkout', '-q', '-b', 'staging'])
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.1-staging"}\n')
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.1-staging\n')
    run(['add', 'package.json', 'CHANGELOG.md'])
    commit('feat: pending release-only change')

    run(['checkout', '-q', 'main'])
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.1-main"}\n')
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.1-main\n')
    run(['add', 'package.json', 'CHANGELOG.md'])
    commit('chore(main): release patch')

    run(['push', '-u', 'origin', 'main'])
    run(['checkout', '-q', 'staging'])
    run(['push', '-u', 'origin', 'staging'])

    const before = remoteHeadSha(root, 'staging')
    const runReconcile = () => withGitHubEnv({
      GITHUB_REPOSITORY: 'owner/repo',
      GH_TOKEN: 'token',
    }, () => reconcileRelease(root, { github: true, dryRun: false, base: 'main', head: 'staging' }))
    assert.throws(runReconcile, /conflict|Cherry-pick|replay/)
    const after = remoteHeadSha(root, 'staging')
    assert.equal(before, after)
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  })

  it('retries stale leases without clobbering concurrent remote updates', () => {
    const { root, remote, run } = createReconcileWorkspace()
    const readRef = (ref) => {
      const result = run(['rev-parse', ref])
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    const commit = (message) => {
      const result = run(['commit', '-m', message])
      assert.equal(result.status, 0, result.stderr)
      return readRef('HEAD')
    }

    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
    writeFileSync(join(root, 'src/index.ts'), 'export const base = 1\n')
    run(['add', 'package.json', 'src/index.ts'])
    commit('chore: initial')
    run(['branch', '-M', 'main'])

    run(['checkout', '-q', '-b', 'staging'])
    writeFileSync(join(root, 'src/feature-pending.ts'), 'export const pending = 1\n')
    run(['add', 'src/feature-pending.ts'])
    commit('feat: pending work')

    run(['checkout', '-q', 'main'])
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.1"}\n')
    run(['add', 'package.json'])
    commit('chore(main): release 1.0.1')

    run(['push', '-u', 'origin', 'main'])
    run(['checkout', '-q', 'staging'])
    run(['push', '-u', 'origin', 'staging'])

    const toolDir = mkdtempSync(join(tmpdir(), 'code-foundry-git-wrapper-'))
    const wrapperScript = join(toolDir, 'git')
    const originalPath = process.env.PATH
    const originalGitPath = spawnSync('sh', ['-lc', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
    const triggerFile = join(toolDir, 'triggered')
    writeFileSync(wrapperScript, `#!/bin/sh\nif [ \"$1\" = \"push\" ] && [ \"$2\" = \"origin\" ] && [ ! -f \"$TRIGGER_FILE\" ]; then\n  printf 1 > \"$TRIGGER_FILE\"\n  \"$ORIGINAL_GIT\" -C \"$REPO_ROOT\" checkout -q staging\n  printf 'export const concurrent = true\\n' > \"$REPO_ROOT/src/concurrent.ts\"\n  \"$ORIGINAL_GIT\" -C \"$REPO_ROOT\" add src/concurrent.ts\n  \"$ORIGINAL_GIT\" -C \"$REPO_ROOT\" commit -m 'chore: concurrent staging update'\n  \"$ORIGINAL_GIT\" -C \"$REPO_ROOT\" push -q origin staging\nfi\nexec \"$ORIGINAL_GIT\" \"$@\"\n`)
    chmodSync(wrapperScript, 0o755)
    process.env.TRIGGER_FILE = triggerFile
    process.env.ORIGINAL_GIT = originalGitPath
    process.env.REPO_ROOT = root
    process.env.PATH = `${toolDir}:${originalPath}`

    const before = remoteHeadSha(root, 'staging')
    let plan
    try {
      plan = withGitHubEnv({
        GITHUB_REPOSITORY: 'owner/repo',
        GH_TOKEN: 'token',
      }, () => reconcileRelease(root, { github: true, dryRun: false, base: 'main', head: 'staging' }))
    } finally {
      process.env.PATH = originalPath
      delete process.env.TRIGGER_FILE
      delete process.env.ORIGINAL_GIT
      delete process.env.REPO_ROOT
    }

    assert.equal(plan.action, 'rebase-staging')
    assert.equal(plan.synchronization, 'replay')
    const after = remoteHeadSha(root, 'staging')
    assert.notEqual(before, after)
    assert.equal(run(['show', `${after}:src/concurrent.ts`]).status, 0)
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
    rmSync(toolDir, { recursive: true, force: true })
  })

  it('is idempotent when patch-equivalent branches are already synchronized', () => {
    const { root, remote, run } = createReconcileWorkspace()
    const readRef = (ref) => {
      const result = run(['rev-parse', ref])
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    const commit = (message) => {
      const result = run(['commit', '-m', message])
      assert.equal(result.status, 0, result.stderr)
      return readRef('HEAD')
    }

    writeFileSync(join(root, 'src.txt'), 'base\n')
    run(['add', 'src.txt'])
    commit('chore: initial')
    run(['branch', '-M', 'main'])

    run(['checkout', '-q', '-b', 'staging'])
    run(['checkout', '-q', 'main'])
    writeFileSync(join(root, 'src.txt'), 'main\n')
    run(['add', 'src.txt'])
    const mainCommit = commit('chore(main): release patch')

    run(['checkout', '-q', 'staging'])
    run(['cherry-pick', mainCommit])
    run(['push', '-u', 'origin', 'main'])
    run(['push', '-u', 'origin', 'staging'])

    const firstPlan = withGitHubEnv({
      GITHUB_REPOSITORY: 'owner/repo',
      GH_TOKEN: 'token',
    }, () => reconcileRelease(root, { github: true, dryRun: false, base: 'main', head: 'staging' }))
    assert.equal(firstPlan.action, 'aligned')
    assertRemoteMainAncestor({ run, base: 'main', head: 'staging' })

    const secondPlan = withGitHubEnv({
      GITHUB_REPOSITORY: 'owner/repo',
      GH_TOKEN: 'token',
    }, () => reconcileRelease(root, { github: true, dryRun: false, base: 'main', head: 'staging' }))
    assert.equal(secondPlan.action, 'aligned')
    assertRemoteMainAncestor({ run, base: 'main', head: 'staging' })
    assert.equal(remoteHeadSha(root, 'staging'), remoteHeadSha(root, 'main'))
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
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
    assert.match(workflow, /merge_strategy.*rebase/)
    assert.match(workflow, /never merge a promotion PR with a merge commit/)
  })

  it('keys runtime concurrency by event so promotion PRs do not cancel push checks', () => {
    for (const workflow of ['ci', 'codeql', 'security', 'test']) {
      const runtime = readFileSync(`.github/workflows/${workflow}.yml`, 'utf8')
      assert.match(runtime, /code-foundry-\w+-\$\{\{ github\.event_name \}\}-\$\{\{ github\.event\.pull_request\.head\.repo\.full_name \|\| github\.repository \}\}/)
    }
  })

  it('attaches validation and opencode-security triggers to staging and main pull requests', () => {
    for (const workflow of ['validation_self-ci', 'opencode-security_self-ci']) {
      const caller = readFileSync(`.github/workflows/${workflow}.yml`, 'utf8')
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

  it('classifies pull requests to staging as fast regardless of head shape', () => {
    for (const head of ['feature/foo', 'staging', 'main', RELEASE_PLEASE_PREFIX, `${RELEASE_PLEASE_PREFIX}--v1.2.3`]) {
      assert.equal(classifyValidationMode({ eventName: 'pull_request', baseRef: 'staging', headRef: head }), 'fast')
    }
  })

  it('classifies main pull requests from the exact Release Please prefix as release', () => {
    assert.equal(classifyValidationMode({ eventName: 'pull_request', baseRef: 'main', headRef: RELEASE_PLEASE_PREFIX }), 'release')
    assert.equal(classifyValidationMode({ eventName: 'pull_request', baseRef: 'main', headRef: `${RELEASE_PLEASE_PREFIX}--v1.2.3` }), 'release')
    assert.equal(classifyValidationMode({ eventName: 'pull_request', baseRef: 'main', headRef: `${RELEASE_PLEASE_PREFIX}--v1.2.3--rc.1` }), 'release')
    assert.equal(classifyValidationMode({ eventName: 'pull_request', baseRef: 'main', headRef: `${RELEASE_PLEASE_PREFIX}--` }), 'release')
  })

  it('rejects malicious lookalikes that miss the exact Release Please prefix boundary', () => {
    const lookalikes = [
      `${RELEASE_PLEASE_PREFIX}x`,
      `${RELEASE_PLEASE_PREFIX}s`,
      `${RELEASE_PLEASE_PREFIX}-v1.2.3`,
      `${RELEASE_PLEASE_PREFIX}_v1.2.3`,
      `${RELEASE_PLEASE_PREFIX}/v1.2.3`,
      `${RELEASE_PLEASE_PREFIX} `,
      ` ${RELEASE_PLEASE_PREFIX}`,
      'Release-please--branches--main--v1.2.3',
      'release-please--branches--MAIN--v1.2.3',
      'release-please--branches--staging--v1.2.3',
      'release-please--branches--mains--v1.2.3',
      'release-please--branches--mainx/v1.2.3',
    ]
    for (const head of lookalikes) {
      assert.equal(isReleasePleaseHead(head), false, head)
      assert.equal(classifyValidationMode({ eventName: 'pull_request', baseRef: 'main', headRef: head }), 'audit', head)
    }
  })

  it('classifies every other main pull request as audit, including promotion PRs', () => {
    for (const head of ['feature/foo', 'staging', 'main', 'release-please--branches--staging--v1.2.3', 'chore(main): release 1.2.3']) {
      assert.equal(classifyValidationMode({ eventName: 'pull_request', baseRef: 'main', headRef: head }), 'audit', head)
    }
  })

  it('classifies schedule and workflow_dispatch as audit', () => {
    assert.equal(classifyValidationMode({ eventName: 'schedule' }), 'audit')
    assert.equal(classifyValidationMode({ eventName: 'workflow_dispatch' }), 'audit')
  })

  it('rejects unsupported events so canonical validation never runs off-trigger', () => {
    for (const eventName of ['push', 'pull_request_target', 'merge_group', 'release', '']) {
      assert.throws(() => classifyValidationMode({ eventName, baseRef: 'main', headRef: 'staging' }), /Unsupported validation event/, eventName)
    }
    assert.throws(() => classifyValidationMode({}), /Unsupported validation event/)
    assert.throws(() => classifyValidationMode({ eventName: 'push' }), /Unsupported validation event/)
  })

  it('rejects pull_request classification without base or head refs', () => {
    assert.throws(() => classifyValidationMode({ eventName: 'pull_request', headRef: 'feature/x' }), /requires base_ref/)
    assert.throws(() => classifyValidationMode({ eventName: 'pull_request', baseRef: 'main' }), /requires head_ref/)
    assert.throws(() => classifyValidationMode({ eventName: 'pull_request', baseRef: '', headRef: 'feature/x' }), /requires base_ref/)
    assert.throws(() => classifyValidationMode({ eventName: 'pull_request', baseRef: 'main', headRef: '' }), /requires head_ref/)
  })

  it('rejects unsupported base branches instead of guessing a mode', () => {
    for (const baseRef of ['release', 'dev', 'feature/x', 'refs/heads/staging', 'refs/heads/main']) {
      assert.throws(() => classifyValidationMode({ eventName: 'pull_request', baseRef, headRef: 'feature/x' }), /Unsupported pull_request base branch/, baseRef)
    }
  })

  it('matches only the exact Release Please prefix boundary', () => {
    assert.equal(isReleasePleaseHead(RELEASE_PLEASE_PREFIX), true)
    assert.equal(isReleasePleaseHead(`${RELEASE_PLEASE_PREFIX}--v1.2.3`), true)
    assert.equal(isReleasePleaseHead(`${RELEASE_PLEASE_PREFIX}--v1.2.3--rc.1`), true)
    assert.equal(isReleasePleaseHead(`${RELEASE_PLEASE_PREFIX}--`), true)
    for (const head of [
      `${RELEASE_PLEASE_PREFIX}x`, `${RELEASE_PLEASE_PREFIX}s`, `${RELEASE_PLEASE_PREFIX}-v1.2.3`,
      `${RELEASE_PLEASE_PREFIX}_v1.2.3`, `${RELEASE_PLEASE_PREFIX}/v1.2.3`, `${RELEASE_PLEASE_PREFIX} `,
      ' release-please--branches--main', 'Release-please--branches--main', 'release-please--branches--MAIN',
      'release-please--branches--staging--v1.0.0', 'release-please--branches--mainx', 'main', 'staging', '',
    ]) {
      assert.equal(isReleasePleaseHead(head), false, head)
    }
    assert.equal(isReleasePleaseHead(undefined), false)
    assert.equal(isReleasePleaseHead(null), false)
    assert.equal(isReleasePleaseHead(42), false)
  })

  it('keeps one required-job truth table per mode', () => {
    assert.deepEqual(requiredValidationJobs('fast'), ['ci', 'test'])
    assert.deepEqual(requiredValidationJobs('audit'), ['ci', 'test', 'security', 'codeql'])
    assert.deepEqual(requiredValidationJobs('release'), ['release-policy'])
    assert.deepEqual(VALIDATION_MODES, ['fast', 'audit', 'release'])
    assert.deepEqual(VALIDATION_EVENTS, ['pull_request', 'schedule', 'workflow_dispatch'])
    assert.deepEqual(VALIDATION_JOBS, ['ci', 'test', 'security', 'codeql', 'release-policy'])
    assert.equal(AGGREGATE_CHECK_NAME, 'Validation / Gate')
    assert.throws(() => requiredValidationJobs('unknown'), /Unknown validation mode/)
    assert.throws(() => requiredValidationJobs(), /Unknown validation mode/)
    assert.deepEqual(requiredValidationJobs('fast'), ['ci', 'test'])
  })

  it('passes the gate only when every job required for the mode succeeded', () => {
    assert.deepEqual(evaluateValidationGate({ mode: 'fast', results: { ci: 'success', test: 'success' } }), {
      valid: true,
      required: ['ci', 'test'],
      failures: [],
    })
    assert.deepEqual(evaluateValidationGate({ mode: 'audit', results: { ci: 'success', test: 'success', security: 'success', codeql: 'success' } }), {
      valid: true,
      required: ['ci', 'test', 'security', 'codeql'],
      failures: [],
    })
    assert.deepEqual(evaluateValidationGate({ mode: 'release', results: { 'release-policy': 'success' } }), {
      valid: true,
      required: ['release-policy'],
      failures: [],
    })
  })

  it('lets expected skips of non-required jobs pass the gate', () => {
    assert.equal(evaluateValidationGate({ mode: 'fast', results: { ci: 'success', test: 'success', security: 'skipped', codeql: 'skipped', 'release-policy': 'skipped' } }).valid, true)
    assert.equal(evaluateValidationGate({ mode: 'audit', results: { ci: 'success', test: 'success', security: 'success', codeql: 'success', 'release-policy': 'skipped' } }).valid, true)
    assert.equal(evaluateValidationGate({ mode: 'release', results: { 'release-policy': 'success', ci: 'skipped', test: 'skipped', security: 'skipped', codeql: 'skipped' } }).valid, true)
    // Non-required jobs never influence the gate, even when they fail.
    assert.equal(evaluateValidationGate({ mode: 'fast', results: { ci: 'success', test: 'success', codeql: 'failure' } }).valid, true)
    assert.equal(evaluateValidationGate({ mode: 'fast', results: {} }).valid, false)
  })

  it('fails closed on failure, cancellation, unexpected skip, and unknown results', () => {
    assert.deepEqual(evaluateValidationGate({ mode: 'fast', results: { ci: 'failure', test: 'success' } }), {
      valid: false,
      required: ['ci', 'test'],
      failures: [{ job: 'ci', result: 'failure' }],
    })
    assert.deepEqual(evaluateValidationGate({ mode: 'audit', results: { ci: 'success', test: 'success', security: 'success', codeql: 'cancelled' } }).failures, [
      { job: 'codeql', result: 'cancelled' },
    ])
    assert.deepEqual(evaluateValidationGate({ mode: 'release', results: { 'release-policy': 'skipped' } }).failures, [
      { job: 'release-policy', result: 'skipped' },
    ])
    assert.deepEqual(evaluateValidationGate({ mode: 'fast', results: { ci: 'success', test: 'weird' } }).failures, [
      { job: 'test', result: 'weird' },
    ])
  })

  it('fails closed on missing results and unknown modes', () => {
    assert.deepEqual(evaluateValidationGate({ mode: 'fast', results: { ci: 'success' } }).failures, [{ job: 'test', result: 'missing' }])
    assert.deepEqual(evaluateValidationGate({ mode: 'audit', results: {} }).failures, [
      { job: 'ci', result: 'missing' },
      { job: 'test', result: 'missing' },
      { job: 'security', result: 'missing' },
      { job: 'codeql', result: 'missing' },
    ])
    assert.deepEqual(evaluateValidationGate({ mode: 'fast', results: { ci: 'success', test: null } }).failures, [{ job: 'test', result: 'missing' }])
    assert.deepEqual(evaluateValidationGate({ mode: 'fast', results: { ci: 'success', test: undefined } }).failures, [{ job: 'test', result: 'missing' }])
    const unknown = evaluateValidationGate({ mode: 'unknown', results: {} })
    assert.equal(unknown.valid, false)
    assert.deepEqual(unknown.required, [])
    assert.equal(unknown.failures.length, 1)
    assert.equal(unknown.failures[0].job, 'mode')
    assert.match(unknown.failures[0].result, /Unknown validation mode/)
  })

  it('generates one validation caller with PR, schedule, and dispatch triggers only', () => {
    const caller = readFileSync('.github/workflows/validation_self-ci.yml', 'utf8')
    assert.doesNotMatch(caller, /^  push:/m)
    assert.match(caller, /pull_request:\n\s+branches: \[main, staging\]/)
    assert.match(caller, /schedule:/)
    assert.match(caller, /workflow_dispatch:/)
    assert.match(caller, /code-foundry-validation-\$\{\{ github\.event_name \}\}/)
    assert.match(caller, /cancel-in-progress: true/)
  })

  it('classifies the validation mode through the pinned runtime in the caller', () => {
    const caller = readFileSync('.github/workflows/validation_self-ci.yml', 'utf8')
    assert.match(caller, /FOUNDRY_EVENT_NAME: \$\{\{ github\.event_name \}\}/)
    assert.match(caller, /FOUNDRY_BASE_REF: \$\{\{ github\.event\.pull_request\.base\.ref \}\}/)
    assert.match(caller, /FOUNDRY_HEAD_REF: \$\{\{ github\.event\.pull_request\.head\.ref \}\}/)
    assert.match(caller, /validation mode/)
    assert.match(caller, /mode: \$\{\{ needs\.mode\.outputs\.mode \}\}/)
    assert.match(caller, /uses: \.\/\.github\/workflows\/validation\.yml/)
    assert.match(caller, /secrets:\n\s+TURBO_TOKEN: \$\{\{ secrets\.TURBO_TOKEN \}\}\n\s+NEXTAUTH_SECRET: \$\{\{ secrets\.NEXTAUTH_SECRET \}\}/)
    assert.doesNotMatch(caller, /secrets:\s*inherit/)
    // Least-permission union needed for the CodeQL chain; no extra write scopes.
    assert.match(caller, /security-events: write/)
    assert.doesNotMatch(caller, /pull-requests: write/)
    assert.doesNotMatch(caller, /contents: write/)
  })

  it('passes only consumed secrets through validation workflow-call boundaries', () => {
    const caller = readFileSync('.github/workflows/validation_self-ci.yml', 'utf8')
    const orchestrator = readFileSync('.github/workflows/validation.yml', 'utf8')
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
    const test = readFileSync('.github/workflows/test.yml', 'utf8')
    const security = readFileSync('.github/workflows/security.yml', 'utf8')
    const codeql = readFileSync('.github/workflows/codeql.yml', 'utf8')

    assert.match(caller, /uses: \.\/\.github\/workflows\/validation\.yml/)
    assert.match(caller, /secrets:\n\s+TURBO_TOKEN: \$\{\{ secrets\.TURBO_TOKEN \}\}\n\s+NEXTAUTH_SECRET: \$\{\{ secrets\.NEXTAUTH_SECRET \}\}/)
    assert.doesNotMatch(caller, /secrets:\s*inherit/)

    assert.match(orchestrator, /secrets:\n\s+TURBO_TOKEN:\n\s+required: false\n\s+NEXTAUTH_SECRET:\n\s+required: false/)
    assert.match(ci, /secrets:\n\s+TURBO_TOKEN:\n\s+required: false\n\s+NEXTAUTH_SECRET:\n\s+required: false/)
    assert.match(test, /secrets:\n\s+TURBO_TOKEN:\n\s+required: false/)
    assert.doesNotMatch(test, /NEXTAUTH_SECRET/)
    assert.doesNotMatch(security, /^    secrets:/m)
    assert.doesNotMatch(codeql, /^    secrets:/m)

    assert.match(orchestrator, /ci:\n[\s\S]*?secrets:\n\s+TURBO_TOKEN: \$\{\{ secrets\.TURBO_TOKEN \}\}\n\s+NEXTAUTH_SECRET: \$\{\{ secrets\.NEXTAUTH_SECRET \}\}/)
    assert.match(orchestrator, /test:\n[\s\S]*?secrets:\n\s+TURBO_TOKEN: \$\{\{ secrets\.TURBO_TOKEN \}\}/)
    assert.doesNotMatch(orchestrator, /security:\n[\s\S]*?runner: \$\{\{ inputs\.security-runner \}\}\n\s+secrets:/)
    assert.doesNotMatch(orchestrator, /codeql:\n[\s\S]*?rust-max-parallel: \$\{\{ inputs\.rust-max-parallel \}\}\n\s+secrets:/)
    assert.doesNotMatch(orchestrator, /secrets:\s*inherit/)
  })

  it('requires persist-credentials: false for every external checkout action in workflow YAML', () => {
    const workflowFiles = readdirSync('.github/workflows').filter((file) => file.endsWith('.yml')).sort()

    const violations = workflowFiles.flatMap((workflow) => {
      const path = `.github/workflows/${workflow}`
      return listCheckoutStepsWithoutPersistCredentialsFalse(path)
    })

    assert.equal(violations.length, 0, `checkout actions missing persist-credentials: false:\n${violations.map((entry) => `${entry.file}:${entry.line}`).join('\n')}`)
  })

  it('prepares git authentication immediately before the reconcile CLI in the Release / Reconcile job', () => {
    const release = readFileSync('.github/workflows/release.yml', 'utf8').split(/\r?\n/)
    const configureIndex = release.findIndex((line) => line.includes('name: Configure git for trusted reconcile'))
    const reconcileIndex = release.findIndex((line) => line.includes('name: Reconcile release metadata'))

    assert.notEqual(configureIndex, -1)
    assert.notEqual(reconcileIndex, -1)
    assert.equal(reconcileIndex > configureIndex, true)

    const nextStepAfterConfigure = release.findIndex((line, index) => index > configureIndex && /^\s{6}- name: /.test(line))
    assert.equal(nextStepAfterConfigure, reconcileIndex)

    assert.match(
      release.slice(configureIndex, nextStepAfterConfigure + 1).join('\n'),
      /name: Configure git for trusted reconcile[\s\S]*?run: gh auth setup-git/,
    )
  })

  it('exposes exactly one stable Validation / Gate aggregate check that always runs', () => {
    const caller = readFileSync('.github/workflows/validation_self-ci.yml', 'utf8')
    const orchestrator = readFileSync('.github/workflows/validation.yml', 'utf8')
    assert.match(caller, /^  validation:\n    name: Validation/m)
    assert.match(orchestrator, /^  gate:\n    name: Gate/m)
    assert.match(orchestrator, /needs: \[ci, test, security, codeql, release-policy\]/)
    assert.match(orchestrator, /if: always\(\)/)
    assert.match(orchestrator, /validation gate/)
    assert.match(orchestrator, /FOUNDRY_CI: \$\{\{ needs\.ci\.result \}\}/)
    assert.match(orchestrator, /FOUNDRY_RELEASE_POLICY: \$\{\{ needs\.release-policy\.result \}\}/)
    assert.doesNotMatch(orchestrator, /^on:\n  push:/m)
  })

  it('runs only the mode-required tier jobs in the orchestrator', () => {
    const orchestrator = readFileSync('.github/workflows/validation.yml', 'utf8')
    for (const job of ['ci', 'test', 'security', 'codeql', 'release-policy']) {
      assert.match(orchestrator, new RegExp(`^  ${job}:`, 'm'))
    }
    assert.match(orchestrator, /if: inputs.mode == 'fast' \|\| inputs.mode == 'audit'/)
    assert.match(orchestrator, /if: inputs.mode == 'audit'/)
    assert.match(orchestrator, /if: inputs.mode == 'release'/)
    assert.match(orchestrator, /unit-only: \$\{\{ inputs.mode == 'fast' \}\}/)
    assert.match(orchestrator, /validation release_diff/)
    assert.match(orchestrator, /ci:\n[\s\S]*?secrets:\n\s+TURBO_TOKEN: \$\{\{ secrets\.TURBO_TOKEN \}\}\n\s+NEXTAUTH_SECRET: \$\{\{ secrets\.NEXTAUTH_SECRET \}\}/)
    assert.match(orchestrator, /test:\n[\s\S]*?secrets:\n\s+TURBO_TOKEN: \$\{\{ secrets\.TURBO_TOKEN \}\}/)
    assert.doesNotMatch(orchestrator, /secrets:\s*inherit/)
    assert.match(orchestrator, /FOUNDRY_HEAD_REPO: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}/)
    assert.match(orchestrator, /FOUNDRY_REPOSITORY: \$\{\{ github\.repository \}\}/)
  })

  it('pins all external workflow/action refs to immutable SHAs', () => {
    const workflows = [
      '.github/workflows/validation_self-ci.yml',
      '.github/workflows/validation.yml',
      '.github/workflows/ci.yml',
      '.github/workflows/test.yml',
      '.github/workflows/security.yml',
      '.github/workflows/codeql.yml',
      '.github/workflows/release.yml',
      '.github/workflows/release-pr.yml',
      '.github/workflows/opencode-security_self-ci.yml',
    ].reduce((acc, file) => acc + readFileSync(file), '')

    const expectedPins = [
      'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6',
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7',
      'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7',
      'github/codeql-action/init@f205ea1c3313d32999d8d6a48b4f6530d4437b38 # v4',
      'github/codeql-action/analyze@f205ea1c3313d32999d8d6a48b4f6530d4437b38 # v4',
      'googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7 # v5',
      'taiki-e/install-action@6a1bd70eaac3c8bdf093356838d7ee09fda951cf # v2',
      'actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294 # v5',
      '0xPlayerOne/opencode-security/.github/workflows/opencode-security.yml@b3dce823322672b285fbe99b870ea984c01826cb # main',
    ]
    for (const pin of expectedPins) {
      assert.match(workflows, new RegExp(pin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }

    assert.doesNotMatch(workflows, /uses: actions\/checkout@v[0-9]+/)
    assert.doesNotMatch(workflows, /uses: actions\/setup-node@v[0-9]+/)
    assert.doesNotMatch(workflows, /uses: actions\/upload-artifact@v[0-9]+/)
    assert.doesNotMatch(workflows, /uses: github\/codeql-action\/(init|analyze)@v[0-9]+/)
    assert.doesNotMatch(workflows, /uses: googleapis\/release-please-action@v[0-9]+/)
    assert.doesNotMatch(workflows, /uses: taiki-e\/install-action@v[0-9]+/)
    assert.doesNotMatch(workflows, /uses: actions\/dependency-review-action@v[0-9]+/)
    assert.doesNotMatch(workflows, /uses: 0xPlayerOne\/opencode-security\/\.github\/workflows\/opencode-security\.yml@main/)
  })

  it('keeps the reusable test interface backward compatible with an additive unit-only input', () => {
    const test = readFileSync('.github/workflows/test.yml', 'utf8')
    assert.match(test, /unit-only:\n\s+description:/)
    assert.match(test, /type: boolean/)
    assert.match(test, /default: false/)
    for (const job of ['integration', 'e2e', 'smoke']) {
      assert.match(test, new RegExp(`^  ${job}:\n    name: [A-Za-z0-9]+\n    if: inputs\.unit-only != true`, 'm'))
    }
    for (const input of ['runtime-repository', 'runtime-ref', 'runner', 'unit-runner']) {
      assert.match(test, new RegExp(`^      ${input}:`, 'm'))
    }
  })

  it('classifies real event metadata through the runtime mode task', () => {
    const run = (env) => spawnSync(process.execPath, [runtime, 'validation', 'mode'], {
      encoding: 'utf8',
      env: { ...testEnv, ...env },
    })
    assert.match(run({ FOUNDRY_EVENT_NAME: 'pull_request', FOUNDRY_BASE_REF: 'staging', FOUNDRY_HEAD_REF: 'feature/x' }).stdout, /^mode=fast$/m)
    assert.match(run({ FOUNDRY_EVENT_NAME: 'pull_request', FOUNDRY_BASE_REF: 'main', FOUNDRY_HEAD_REF: 'release-please--branches--main--v1.2.3' }).stdout, /^mode=release$/m)
    assert.match(run({ FOUNDRY_EVENT_NAME: 'pull_request', FOUNDRY_BASE_REF: 'main', FOUNDRY_HEAD_REF: 'staging' }).stdout, /^mode=audit$/m)
    assert.match(run({ FOUNDRY_EVENT_NAME: 'pull_request', FOUNDRY_BASE_REF: 'main', FOUNDRY_HEAD_REF: 'feature/x' }).stdout, /^mode=audit$/m)
    assert.match(run({ FOUNDRY_EVENT_NAME: 'workflow_dispatch' }).stdout, /^mode=audit$/m)
    assert.match(run({ FOUNDRY_EVENT_NAME: 'schedule' }).stdout, /^mode=audit$/m)
    const push = run({ FOUNDRY_EVENT_NAME: 'push', FOUNDRY_BASE_REF: 'main', FOUNDRY_HEAD_REF: 'staging' })
    assert.notEqual(push.status, 0)
    assert.match(push.stderr, /Unsupported validation event/)
  })

  it('evaluates the aggregate gate through the runtime gate task', () => {
    const run = (env) => spawnSync(process.execPath, [runtime, 'validation', 'gate'], {
      encoding: 'utf8',
      env: { ...testEnv, ...env },
    })
    const audit = run({ FOUNDRY_MODE: 'audit', FOUNDRY_CI: 'success', FOUNDRY_TEST: 'success', FOUNDRY_SECURITY: 'success', FOUNDRY_CODEQL: 'success', FOUNDRY_RELEASE_POLICY: 'skipped' })
    assert.equal(audit.status, 0)
    assert.match(audit.stdout, /gate passed/)
    const fast = run({ FOUNDRY_MODE: 'fast', FOUNDRY_CI: 'success', FOUNDRY_TEST: 'success', FOUNDRY_SECURITY: 'skipped', FOUNDRY_CODEQL: 'skipped', FOUNDRY_RELEASE_POLICY: 'skipped' })
    assert.equal(fast.status, 0)
    const release = run({ FOUNDRY_MODE: 'release', FOUNDRY_CI: 'skipped', FOUNDRY_TEST: 'skipped', FOUNDRY_SECURITY: 'skipped', FOUNDRY_CODEQL: 'skipped', FOUNDRY_RELEASE_POLICY: 'success' })
    assert.equal(release.status, 0)
    const failed = run({ FOUNDRY_MODE: 'fast', FOUNDRY_CI: 'failure', FOUNDRY_TEST: 'success', FOUNDRY_SECURITY: 'skipped', FOUNDRY_CODEQL: 'skipped', FOUNDRY_RELEASE_POLICY: 'skipped' })
    assert.notEqual(failed.status, 0)
    assert.match(failed.stderr, /::error::ci: failure/)
    const cancelled = run({ FOUNDRY_MODE: 'audit', FOUNDRY_CI: 'success', FOUNDRY_TEST: 'success', FOUNDRY_SECURITY: 'success', FOUNDRY_CODEQL: 'cancelled', FOUNDRY_RELEASE_POLICY: 'skipped' })
    assert.notEqual(cancelled.status, 0)
    assert.match(cancelled.stderr, /::error::codeql: cancelled/)
    const unknown = run({ FOUNDRY_MODE: 'bogus', FOUNDRY_CI: 'success', FOUNDRY_TEST: 'success', FOUNDRY_SECURITY: 'success', FOUNDRY_CODEQL: 'success', FOUNDRY_RELEASE_POLICY: 'success' })
    assert.notEqual(unknown.status, 0)
    assert.match(unknown.stderr, /Unknown validation mode/)
  })

  it('enforces the strict generated-release diff and version policy', () => {
    const base = { headRef: 'release-please--branches--main--v1.0.0', headRepo: 'owner/repo', repository: 'owner/repo' }
    assert.equal(validateGeneratedReleaseDiff({ ...base, changedPaths: ['package.json', 'CHANGELOG.md'] }).valid, true)
    const unexpected = validateGeneratedReleaseDiff({ ...base, changedPaths: ['package.json', 'src/index.ts'] })
    assert.equal(unexpected.valid, false)
    assert.match(unexpected.errors.join(' '), /unexpected paths: src\/index\.ts/)
    assert.equal(validateGeneratedReleaseDiff({ ...base, headRef: 'release-please--branches--mainx--v1.0.0', changedPaths: ['package.json'] }).valid, false)
    assert.equal(validateGeneratedReleaseDiff({ ...base, headRepo: 'evil/fork', changedPaths: ['package.json'] }).valid, false)
    // Missing repository identity fails closed, not just mismatched identity.
    assert.equal(validateGeneratedReleaseDiff({ ...base, headRepo: '', changedPaths: ['package.json'] }).valid, false)
    assert.equal(validateGeneratedReleaseDiff({ ...base, repository: '', changedPaths: ['package.json'] }).valid, false)
    assert.equal(validateGeneratedReleaseDiff({ ...base, headRepo: undefined, repository: undefined, changedPaths: ['package.json'] }).valid, false)
    assert.equal(validateGeneratedReleaseDiff({ ...base, changedPaths: [] }).valid, false)
    const noBump = validateGeneratedReleaseDiff({ ...base, changedPaths: ['CHANGELOG.md'] })
    assert.equal(noBump.valid, false)
    assert.match(noBump.errors.join(' '), /no version metadata/)
    const extraFile = validateGeneratedReleaseDiff({
      ...base,
      changedPaths: ['src/version.ts', 'CHANGELOG.md'],
      config: { 'extra-files': ['src/version.ts'] },
    })
    assert.equal(extraFile.valid, true)
    assert.deepEqual(extraFile.changedPaths, ['src/version.ts', 'CHANGELOG.md'])
  })

  it('validates generated release diffs through the runtime release_diff task', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-release-diff-'))
    const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    git(['init', '-q'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'base'])
    const baseSha = git(['rev-parse', 'HEAD']).stdout.trim()
    git(['checkout', '-q', '-b', 'release-please--branches--main--v1.0.0'])
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.1.0"}\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'chore(main): release 1.1.0'])
    const run = (env) => spawnSync(process.execPath, [runtime, 'validation', 'release_diff'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...testEnv, ...env },
    })
    const valid = run({ FOUNDRY_BASE_SHA: baseSha, FOUNDRY_HEAD_REF: 'release-please--branches--main--v1.0.0', FOUNDRY_HEAD_REPO: 'owner/repo', FOUNDRY_REPOSITORY: 'owner/repo' })
    assert.equal(valid.status, 0, valid.stderr)
    assert.match(valid.stdout, /Release policy passed/)
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src/index.ts'), 'export const value = 1\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'sneak'])
    const sneaky = run({ FOUNDRY_BASE_SHA: baseSha, FOUNDRY_HEAD_REF: 'release-please--branches--main--v1.0.0', FOUNDRY_HEAD_REPO: 'owner/repo', FOUNDRY_REPOSITORY: 'owner/repo' })
    assert.notEqual(sneaky.status, 0)
    assert.match(sneaky.stderr, /unexpected paths: src\/index\.ts/)
    const fork = run({ FOUNDRY_BASE_SHA: baseSha, FOUNDRY_HEAD_REF: 'release-please--branches--main--v1.0.0', FOUNDRY_HEAD_REPO: 'evil/fork', FOUNDRY_REPOSITORY: 'owner/repo' })
    assert.notEqual(fork.status, 0)
    assert.match(fork.stderr, /same-repository/)
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

/** @param {string} stem */
/**
 * @param {string} file
 * @returns {Array<{ file: string, line: number }>} checkout steps that lack persist-credentials: false
 */
function listCheckoutStepsWithoutPersistCredentialsFalse(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const checkoutPattern = /^\s*uses:\s*actions\/checkout@/
  const stepStartPattern = /^(\s*)-\s+/
  const issues = []

  for (let i = 0; i < lines.length; i++) {
    const checkoutMatch = lines[i].match(checkoutPattern)
    if (!checkoutMatch) continue

    const usesIndent = (lines[i].match(/^\s*/) || [''])[0].length
    let stepIndent = usesIndent
    for (let k = i - 1; k >= 0; k--) {
      const stepMatch = lines[k].match(stepStartPattern)
      if (stepMatch) {
        stepIndent = stepMatch[1].length
        break
      }
    }

    let hasWith = false
    let inWith = false
    let withIndent = -1
    let persistValue = null

    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j]
      if (!raw.trim()) continue

      const stepMatch = raw.match(stepStartPattern)
      if (stepMatch && stepMatch[1].length <= stepIndent) break
      if (/^\S/.test(raw)) break

      const indent = (raw.match(/^\s*/) || [''])[0].length
      const trimmed = raw.trim()

      if (trimmed === 'with:') {
        if (indent === usesIndent) {
          hasWith = true
          inWith = true
          withIndent = indent
        }
        continue
      }

      if (!inWith) continue
      if (indent <= withIndent) {
        inWith = false
        continue
      }

      const match = trimmed.match(/^persist-credentials:\s*(.+)$/)
      if (match) {
        persistValue = match[1].trim()
      }
    }

    if (!hasWith || persistValue !== 'false') {
      issues.push({ file, line: i + 1 })
    }
  }

  return issues
}

function legacyCaller(stem) {
  return [
    'name: Code Foundry',
    '',
    'on:',
    '  push:',
    '    branches: [main, staging]',
    '  pull_request:',
    '    branches: [main, staging]',
    '  workflow_dispatch:',
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    `  ${stem}:`,
    `    name: ${stem}`,
    `    uses: 0xPlayerOne/code-foundry/.github/workflows/${stem}.yml@v0.31.12`,
    '    with:',
    '      runtime-repository: 0xPlayerOne/code-foundry',
    '      runtime-ref: v0.31.12',
    '      runner: ubuntu-latest',
    '    secrets: inherit',
    '',
  ].join('\n')
}

function exists(file) {
  try {
    readFileSync(file)
    return true
  } catch {
    return false
  }
}
