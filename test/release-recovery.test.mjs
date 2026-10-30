import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  requireNpmVersionMissing,
  validateRecoveryTarget,
  verifyRecoveryTarget,
} from '../src/commands/release-recovery.mjs'
import { syncRepository } from '../src/commands/sync.mjs'

const publisherWorkflow = readFileSync(
  new URL('../.github/workflows/qualified-foundry-publish.yml', import.meta.url),
  'utf8'
)
const releaseCaller = readFileSync(
  new URL('../.github/workflows/release_self-ci.yml', import.meta.url),
  'utf8'
)

const sourceSha = 'a'.repeat(40)
const currentSha = 'b'.repeat(40)
const version = '1.53.1'
const tag = `v${version}`
const asset = `code-foundry-${version}.tgz`
const release = () => ({
  immutable: true,
  draft: false,
  prerelease: false,
  tag_name: tag,
  assets: [{ name: asset, state: 'uploaded', size: 319050 }],
})
const target = (changes = {}) =>
  validateRecoveryTarget({
    tag,
    version,
    release: release(),
    sourceSha,
    currentSha,
    sourceIsAncestor: true,
    ...changes,
  })

test('manual recovery is constrained to the current immutable release source and exact archive', () => {
  assert.deepEqual(target(), { tag, asset, sourceSha, version })
  assert.throws(() => target({ tag: 'v1.53.2' }), /match the current package version/)
  assert.throws(() => target({ version: '1.53.2' }), /match the current package version/)
  assert.throws(() => target({ sourceSha: 'bad' }), /exact source and current commit/)
  assert.throws(() => target({ sourceIsAncestor: false }), /contained in the trusted main checkout/)
})

for (const [label, change] of [
  ['mutable release', (value) => (value.immutable = false)],
  ['draft release', (value) => (value.draft = true)],
  ['prerelease', (value) => (value.prerelease = true)],
  ['different tag', (value) => (value.tag_name = 'v1.53.2')],
  ['missing archive', (value) => (value.assets = [])],
  ['duplicate archive', (value) => value.assets.push({ name: asset, state: 'uploaded', size: 1 })],
  ['unuploaded archive', (value) => (value.assets[0].state = 'starter')],
  ['empty archive', (value) => (value.assets[0].size = 0)],
]) {
  test(`manual recovery rejects ${label}`, () => {
    const metadata = release()
    change(metadata)
    assert.throws(
      () => target({ release: metadata }),
      /exact published immutable stable release|exactly one uploaded archive/
    )
  })
}

test('registry preflight accepts only the exact npm 404 for the requested version', () => {
  assert.equal(
    requireNpmVersionMissing({
      status: 1,
      version,
      stderr: `npm error code E404\nnpm error 404 No match found for version ${version}\n`,
    }),
    true
  )
  assert.throws(
    () => requireNpmVersionMissing({ status: 0, version, stderr: '' }),
    /already exists/
  )
  assert.throws(
    () => requireNpmVersionMissing({ status: 1, version, stderr: 'E404 network proxy error' }),
    /registry state is unverified/
  )
  assert.throws(
    () => requireNpmVersionMissing({ status: 1, version: 'latest', stderr: 'E404' }),
    /exact stable package version/
  )
})

test('manual recovery dispatch calls the normal qualification and OIDC publication workflow', () => {
  assert.match(releaseCaller, /^on:\n  push:[\s\S]*  workflow_dispatch:/m)
  assert.match(releaseCaller, /recover-npm-tag:[\s\S]*required: false[\s\S]*default: ''/)
  assert.match(releaseCaller, /name: Verify npm recovery target/)
  assert.match(releaseCaller, /name: Requalify and publish recovered archive/)
  assert.match(releaseCaller, /github\.ref == 'refs\/heads\/main'/)
  assert.match(releaseCaller, /vars\.CI_BILLING_PAUSED != 'true'/)
  assert.match(releaseCaller, /fetch-depth: 0/)
  assert.match(releaseCaller, /uses: \.\/\.github\/workflows\/qualified-foundry-publish\.yml/)
  assert.match(
    releaseCaller,
    /source-sha: \$\{\{ needs\.npm_recovery_target\.outputs\['source-sha'\] \}\}/
  )
  assert.match(releaseCaller, /RELEASE_TAG: \$\{\{ inputs\['recover-npm-tag'\] \}\}/)
  assert.match(releaseCaller, /node src\/commands\/release-recovery\.mjs verify-target/)
  assert.doesNotMatch(releaseCaller, /npm publish/)
  assert.equal((releaseCaller.match(/inputs\['recover-npm-tag'\] != ''/g) ?? []).length, 7)
  assert.match(publisherWorkflow, /name: Qualify Node \$\{\{ matrix\.node \}\}/)
  assert.match(
    publisherWorkflow,
    /source-sha:\n        required: false\n        type: string\n        default: ''/
  )
  assert.match(
    publisherWorkflow,
    /RELEASE_SOURCE_SHA: \$\{\{ inputs\['source-sha'\] \|\| github\.sha \}\}/
  )
  assert.match(
    publisherWorkflow,
    /name: qualified-\$\{\{ github\.run_attempt \}\}-node-\$\{\{ matrix\.node \}\}/
  )
  assert.match(publisherWorkflow, /--name "qualified-\$GITHUB_RUN_ATTEMPT-node-\$node"/)
  assert.match(publisherWorkflow, /"\$RELEASE_TAG" "\$RELEASE_SOURCE_SHA" "\$RELEASE_ASSET"/)
  assert.match(
    publisherWorkflow,
    /"\$RUNNER_TEMP\/candidate\/\$RELEASE_ASSET" "\$RELEASE_SOURCE_SHA"/
  )
  assert.match(publisherWorkflow, /id-token: write/)
  const packageManifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  )
  assert.ok(packageManifest.files.includes('!src/commands/release-recovery.mjs'))
  assert.ok(packageManifest.files.includes('!.github/workflows/qualified-foundry-publish.yml'))
  assert.ok(!packageManifest.files.includes('!.github/workflows/release_self-ci.yml'))
})

test('recovery preflight writes outputs only after tag, immutable asset, ancestry, and npm absence pass', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-foundry-recovery-output-'))
  const outputPath = join(directory, 'github-output')
  try {
    const runCalls = []
    const result = verifyRecoveryTarget(
      { repository: '0xPlayerOne/code-foundry', tag, currentSha, outputPath },
      {
        resolveTagCommit: (repository, resolvedTag) => {
          assert.equal(repository, '0xPlayerOne/code-foundry')
          assert.equal(resolvedTag, tag)
          return sourceSha
        },
        runGh: (args) => {
          runCalls.push(args)
          return { status: 0, stdout: JSON.stringify(release()) }
        },
        spawnSync: (command, args) => {
          runCalls.push([command, ...args])
          if (command === 'git') return { status: 0 }
          return {
            status: 1,
            stderr: `npm error code E404\nnpm error 404 No match found for version ${version}\n`,
          }
        },
      }
    )
    assert.deepEqual(result, { tag, asset, sourceSha, version })
    assert.equal(
      readFileSync(outputPath, 'utf8'),
      `tag=${tag}\nasset=${asset}\nsource-sha=${sourceSha}\n`
    )
    assert.equal(runCalls.filter((args) => args[0] === 'npm').length, 1)

    rmSync(outputPath)
    writeFileSync(outputPath, '')
    assert.throws(
      () =>
        verifyRecoveryTarget(
          { repository: '0xPlayerOne/code-foundry', tag, currentSha, outputPath },
          {
            resolveTagCommit: () => sourceSha,
            runGh: () => ({ status: 0, stdout: JSON.stringify(release()) }),
            spawnSync: (command) => (command === 'git' ? { status: 0 } : { status: 0, stderr: '' }),
          }
        ),
      /already exists/
    )
    assert.equal(readFileSync(outputPath, 'utf8'), '')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('consumer release rendering strips the self-only recovery selector and jobs', () => {
  const targetDir = mkdtempSync(join(tmpdir(), 'code-foundry-npm-recovery-render-'))
  try {
    mkdirSync(join(targetDir, '.github'), { recursive: true })
    writeFileSync(
      join(targetDir, '.github/code-foundry.yml'),
      'languages: typescript\npackage_manager: bun\nfeatures: release\n'
    )
    syncRepository({ target: targetDir, source: process.cwd(), configureHooks: false })
    const consumer = readFileSync(join(targetDir, '.github/workflows/release.yml'), 'utf8')
    assert.doesNotMatch(consumer, /recover-npm-tag|npm_recovery_target|npm_recovery_publish/)
    assert.match(
      consumer,
      /if: vars\.CI_BILLING_PAUSED != 'true' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\['release-while-paused'\] == true\)/
    )
  } finally {
    rmSync(targetDir, { recursive: true, force: true })
  }
})
