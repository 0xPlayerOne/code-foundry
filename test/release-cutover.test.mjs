import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { syncRepository } from '../src/commands/sync.mjs'
import { REQUIRED_NODES } from '../src/commands/qualified-publication.mjs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const text = (name) => readFileSync(join(root, '.github/workflows', name), 'utf8')
const release = text('release.yml')
const caller = text('release_self-ci.yml')
const publisher = text('qualified-foundry-publish.yml')
const policy = JSON.parse(readFileSync(join(root, '.github/release-please-foundry.json'), 'utf8'))
const baseline = JSON.parse(readFileSync(join(root, 'release-please-config.json'), 'utf8'))
const profile = release
  .match(/node <<'NODE'\n([\s\S]*?)\n          NODE/)[1]
  .split('\n')
  .map((line) => line.slice(10))
  .join('\n')
const stage = caller.split('\n  stage:\n')[1]
const identity = stage
  .match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE/)[1]
  .split('\n')
  .map((line) => line.slice(10))
  .join('\n')

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'release-cutover-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(join(directory, '.github'))
  writeFileSync(
    join(directory, '.github/code-foundry.yml'),
    'git_workflow: direct\nrelease_merge_strategy: squash\nrelease_type: auto\nnpm_publish: true\n'
  )
  writeFileSync(join(directory, 'package.json'), '{"name":"code-foundry","version":"1.0.0"}')
  writeFileSync(join(directory, 'release-please-config.json'), JSON.stringify(baseline))
  writeFileSync(join(directory, '.github/release-please-foundry.json'), JSON.stringify(policy))
  writeFileSync(join(directory, '.release-please-manifest.json'), '{".":"1.0.0"}')
  const output = join(directory, 'output')
  writeFileSync(output, '')
  return { directory, output }
}
function executeProfile(directory, output, env = {}) {
  return spawnSync(process.execPath, ['-e', profile], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_OUTPUT: output,
      RELEASE_CONFIG_FILE: '',
      DEFER_PUBLICATION: 'false',
      ...env,
    },
  })
}

const deferred = {
  RELEASE_CONFIG_FILE: '.github/release-please-foundry.json',
  DEFER_PUBLICATION: 'true',
}
test('legacy consumers keep root configuration and ordinary publication defaults', (t) => {
  const { directory, output } = fixture(t)
  const result = executeProfile(directory, output)
  assert.equal(result.status, 0, result.stderr)
  assert.match(readFileSync(output, 'utf8'), /legacy_release_type=node\nnpm_publish=true/)
  assert.equal(baseline.draft, undefined)
  assert.equal(baseline['force-tag-creation'], undefined)
  assert.equal(baseline.packages, undefined)
  assert.match(release, /config-file:\n(?:[^\n]*\n){3}        default: release-please-config.json/)
  assert.match(release, /defer-publication:\n(?:[^\n]*\n){3}        default: false/)
})
test('self configuration selects root manifest mode with draft and pre-created tag', (t) => {
  const { directory, output } = fixture(t)
  const result = executeProfile(directory, output, deferred)
  assert.equal(result.status, 0, result.stderr)
  assert.match(readFileSync(output, 'utf8'), /legacy_release_type=\nnpm_publish=true/)
  assert.deepEqual(Object.keys(policy.packages), ['.'])
  assert.equal(policy.packages['.'].draft, true)
  assert.equal(policy.packages['.']['force-tag-creation'], true)
  assert.equal(policy.packages['.']['include-component-in-tag'], false)
})
for (const [name, mutate] of [
  [
    'non-draft',
    (value) => {
      value.packages['.'].draft = false
    },
  ],
  [
    'lazy tag',
    (value) => {
      value.packages['.']['force-tag-creation'] = false
    },
  ],
  [
    'multiple packages',
    (value) => {
      value.packages.extra = {}
    },
  ],
  [
    'no root package',
    (value) => {
      value.packages = { other: {} }
    },
  ],
]) {
  test(`deferred publication rejects ${name} before any write`, (t) => {
    const { directory, output } = fixture(t)
    const value = structuredClone(policy)
    mutate(value)
    writeFileSync(join(directory, deferred.RELEASE_CONFIG_FILE), JSON.stringify(value))
    const result = executeProfile(directory, output, deferred)
    assert.notEqual(result.status, 0)
    assert.equal(readFileSync(output, 'utf8'), '')
  })
}
for (const path of ['../other.json', '/tmp/other.json', 'bad\npath.json', '.github/missing.json']) {
  test(`configuration rejects unsafe or missing path ${JSON.stringify(path)}`, (t) => {
    const { directory, output } = fixture(t)
    assert.notEqual(
      executeProfile(directory, output, { ...deferred, RELEASE_CONFIG_FILE: path }).status,
      0
    )
  })
}
test('configuration cannot escape the checkout through a symlink', (t) => {
  const { directory, output } = fixture(t)
  const outside = mkdtempSync(join(tmpdir(), 'release-cutover-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  writeFileSync(join(outside, 'policy.json'), JSON.stringify(policy))
  symlinkSync(join(outside, 'policy.json'), join(directory, '.github/escape.json'))
  const result = executeProfile(directory, output, {
    ...deferred,
    RELEASE_CONFIG_FILE: '.github/escape.json',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /inside the repository/)
})
test('manifest mode still rejects missing version manifest', (t) => {
  const { directory, output } = fixture(t)
  rmSync(join(directory, '.release-please-manifest.json'))
  assert.notEqual(executeProfile(directory, output, deferred).status, 0)
})

function identityEnv() {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  return {
    ...process.env,
    SOURCE_SHA: 'a'.repeat(40),
    GITHUB_SHA: 'a'.repeat(40),
    RELEASE_SHA: 'a'.repeat(40),
    RELEASE_TAG: `v${version}`,
    PACKAGE: `code-foundry-${version}.tgz`,
    CANDIDATE_SHA256: 'b'.repeat(64),
    GITHUB_RUN_ID: '12',
    GITHUB_RUN_ATTEMPT: '3',
    CANDIDATE_ARTIFACT: 'qualification-candidate-12-3',
  }
}
function executeIdentity(env) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', identity], {
    cwd: root,
    env,
    encoding: 'utf8',
  })
}
test('staging accepts only an exact current qualification handoff', () => {
  const result = executeIdentity(identityEnv())
  assert.equal(result.status, 0, result.stderr)
})
for (const [key, value] of [
  ['SOURCE_SHA', 'main'],
  ['GITHUB_SHA', 'c'.repeat(40)],
  ['RELEASE_SHA', 'c'.repeat(40)],
  ['RELEASE_TAG', 'v0.0.0'],
  ['PACKAGE', '../unsafe.tgz'],
  ['CANDIDATE_SHA256', ''],
  ['CANDIDATE_ARTIFACT', 'qualification-candidate-12-2'],
]) {
  test(`staging rejects changed ${key} before retrieving assets or writing releases`, () => {
    assert.notEqual(executeIdentity({ ...identityEnv(), [key]: value }).status, 0)
  })
}

test('Release Please outputs preserve the exact SHA for both credential routes', () => {
  const normalize = release.slice(
    release.indexOf('      - name: Normalize Release Please outputs'),
    release.indexOf('      - name: Publish batched draft with atomic visibility')
  )
  const shell = normalize
    .split('        run: |\n')[1]
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n')
  for (const mode of ['AUTOMATION', 'WORKFLOW']) {
    const directory = mkdtempSync(join(tmpdir(), 'release-output-'))
    try {
      const output = join(directory, 'out')
      const env = { ...process.env, GITHUB_OUTPUT: output }
      for (const prefix of ['AUTOMATION', 'WORKFLOW'])
        for (const key of ['RELEASE_CREATED', 'TAG_NAME', 'SHA', 'PRS_CREATED'])
          env[`${prefix}_${key}`] = ''
      Object.assign(env, {
        [`${mode}_RELEASE_CREATED`]: 'true',
        [`${mode}_TAG_NAME`]: 'v1.0.0',
        [`${mode}_SHA`]: 'a'.repeat(40),
      })
      const result = spawnSync('bash', ['-c', shell], { env, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      assert.match(readFileSync(output, 'utf8'), new RegExp(`sha=${'a'.repeat(40)}\\n`))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('staging reuses the producer credential selection', () => {
  assert.match(
    release,
    /token_source:\n\s+description: Credential selected for release operations\.\n\s+value: \$\{\{ jobs\.release\.outputs\.token_source \}\}/
  )
  assert.match(
    caller,
    /GH_TOKEN: \$\{\{ needs\.release\.outputs\.token_source == 'configured' && secrets\.CODE_FOUNDRY_TOKEN \|\| github\.token \}\}/
  )
  const preflight = caller.split('\n  preflight:\n')[1].split('\n  release:\n')[0]
  assert.match(preflight, /GH_TOKEN="\$CODE_FOUNDRY_TOKEN" gh api/)
  assert.match(preflight, /if \[ -n "\$CODE_FOUNDRY_TOKEN" \]/)
})

test('all legacy downstream jobs are disabled together during external publication', () => {
  for (const job of ['reconcile', 'post-release', 'npm']) {
    const block = release.split(`\n  ${job}:\n`)[1].split(/\n  [a-z-]+:\n/)[0]
    assert.match(block, /if: .*inputs\['defer-publication'\] != true &&/)
  }
  const producer = caller.split('\n  release:\n')[1].split('\n  stage:\n')[0]
  assert.match(producer, /defer-publication: true/)
  assert.doesNotMatch(producer, /NPM_TOKEN/)
  // Release Please consumes no qualification outputs: the producer runs first
  // and qualification executes only when a release (or a stuck draft) needs it.
  assert.match(producer, /needs: \[preflight\]/)
  assert.doesNotMatch(producer, /needs: \[qualification/)
  assert.doesNotMatch(caller, /NPM_TOKEN/)
  assert.match(caller, /id-token: write/)
  assert.doesNotMatch(publisher, /NPM_TOKEN|NODE_AUTH_TOKEN|token publishing/i)
  assert.match(publisher, /id-token: write/)
})

test('staging consumes verified current-attempt bytes without a rebuild and keeps publication automatic', () => {
  const stageBlock = caller.split('\n  stage:\n')[1].split('\n  publish:\n')[0]
  assert.doesNotMatch(stageBlock, /environment: release/)
  assert.match(stageBlock, /needs: \[qualification, release, recovery\]/)
  assert.match(stageBlock, /needs\.qualification\.outputs\.candidate-artifact/)
  assert.match(stageBlock, /test "\$\(sha256sum .*\)" = "\$CANDIDATE_SHA256"/)
  assert.match(stageBlock, /consumer-qualification-\$GITHUB_RUN_ATTEMPT-node-/)
  assert.match(stageBlock, /qualified-publication.mjs stage/)
  assert.doesNotMatch(stageBlock, /npm (pack|publish|install)|bun install|secrets.NPM_TOKEN/)
  assert.match(caller, /needs: \[qualification, release, recovery, stage\]/)
  assert.match(caller, /uses: \.\/\.github\/workflows\/qualified-foundry-publish.yml/)
  assert.doesNotMatch(caller, /environment: npm/)
  assert.match(caller, /cancel-in-progress: false/)
  assert.doesNotMatch(publisher, /environment:/)
})

test('qualified self publication uses caller-bound OIDC without a publishing token', () => {
  const publish = caller.split('\n  publish:\n')[1]
  assert.match(publish, /uses: \.\/\.github\/workflows\/qualified-foundry-publish\.yml/)
  assert.match(publish, /id-token: write/)
  assert.doesNotMatch(publish, /secrets:\s+NPM_TOKEN|NPM_TOKEN/)
  assert.doesNotMatch(publisher, /secrets:\s+NPM_TOKEN|HAS_NPM_TOKEN/)
  assert.match(publisher, /qualified-publication\.mjs publish/)
  assert.doesNotMatch(publisher, /NODE_AUTH_TOKEN/)
})

test('generated consumers select npm auth explicitly and keep read credentials separate', (t) => {
  for (const [mode, expectsPublishToken] of [
    ['auto', true],
    ['token', true],
    ['oidc', false],
  ]) {
    const { directory } = fixture(t)
    writeFileSync(
      join(directory, '.github/code-foundry.yml'),
      `git_workflow: direct\nrelease_merge_strategy: squash\nrelease_type: auto\nnpm_publish: true\nnpm_publish_auth: ${mode}\n`
    )
    syncRepository({ target: directory, source: root })
    const generated = readFileSync(join(directory, '.github/workflows/release.yml'), 'utf8')
    assert.match(generated, new RegExp(`npm-publish-auth: ${mode}`))
    assert.match(generated, /NPM_READ_TOKEN: \$\{\{ secrets\.NPM_READ_TOKEN \}\}/)
    assert.equal(/NPM_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/.test(generated), expectsPublishToken)
    assert.match(release, /npm-publish-auth:\n\s+description:/)
    assert.match(release, /NPM_READ_TOKEN:\n\s+required: false/)
  }

  const { directory } = fixture(t)
  writeFileSync(
    join(directory, '.github/code-foundry.yml'),
    'git_workflow: direct\nrelease_merge_strategy: squash\nrelease_type: auto\nnpm_publish: false\nnpm_publish_auth: auto\n'
  )
  syncRepository({ target: directory, source: root })
  const disabled = readFileSync(join(directory, '.github/workflows/release.yml'), 'utf8')
  assert.doesNotMatch(disabled, /NPM_TOKEN|NPM_READ_TOKEN/)
})

test('consumer private-read credentials stay inside install and never reach OIDC publish', () => {
  const npm = release.split('\n  npm:\n')[1]
  const install = npm
    .split('- name: Install dependencies\n')[1]
    .split('- name: Publish npm with token')[0]
  const tokenPublish = npm
    .split('- name: Publish npm with token\n')[1]
    .split('- name: Publish npm with trusted publishing')[0]
  const oidcPublish = npm.split('- name: Publish npm with trusted publishing\n')[1]
  assert.match(install, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_READ_TOKEN \|\|/)
  assert.match(install, /inputs\['npm-publish-auth'\] != 'oidc' && secrets\.NPM_TOKEN/)
  assert.match(install, /NPM_CONFIG_USERCONFIG/)
  assert.match(tokenPublish, /if: inputs\['npm-publish-auth'\] == 'token'/)
  assert.match(tokenPublish, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/)
  assert.match(oidcPublish, /if: inputs\['npm-publish-auth'\] == 'oidc'/)
  assert.doesNotMatch(oidcPublish, /NODE_AUTH_TOKEN|secrets\.NPM_TOKEN/)
})

test('token publication resolves npmjs auth from a temporary publish-step config', async (t) => {
  const npm = release.split('\n  npm:\n')[1]
  const tokenPublish = npm
    .split('- name: Publish npm with token\n')[1]
    .split('\n      - name: Publish npm with trusted publishing')[0]
  const publishScript = tokenPublish
    .split('\n        run: |\n')[1]
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n')
  const directory = mkdtempSync(join(tmpdir(), 'release-npm-token-config-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const bin = join(directory, 'bin')
  mkdirSync(bin)
  const capturedConfig = join(directory, 'captured.npmrc')
  const globalConfig = join(directory, 'global.npmrc')
  writeFileSync(globalConfig, '')
  const fakeNpm = join(bin, 'npm')
  writeFileSync(
    fakeNpm,
    `#!/bin/sh
set -eu
if [ "$1" != publish ]; then
  echo 'unexpected npm command' >&2
  exit 2
fi
if [ -z "\${NPM_CONFIG_USERCONFIG:-}" ] || [ ! -f "$NPM_CONFIG_USERCONFIG" ]; then
  echo 'publish step did not receive its temporary npm config' >&2
  exit 3
fi
cp "$NPM_CONFIG_USERCONFIG" "$CAPTURE_CONFIG"
chmod 600 "$CAPTURE_CONFIG"
printf 'captured publish config\\n'
`
  )
  chmodSync(fakeNpm, 0o755)
  const dummyToken = 'test-only-npm-token-never-published'
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', publishScript], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      CAPTURE_CONFIG: capturedConfig,
      NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_LOGS_DIR: '/tmp/code-foundry-npm-oidc-npm-logs',
      NPM_CONFIG_USERCONFIG: '/dev/null',
      NPM_CONFIG_CACHE: '/tmp/code-foundry-npm-oidc-npm-cache',
      NODE_AUTH_TOKEN: dummyToken,
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: directory,
    },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /captured publish config/)
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(dummyToken))
  assert.deepEqual(readdirSync(directory).toSorted(), ['bin', 'captured.npmrc', 'global.npmrc'])

  const npmGlobalRoot = execFileSync('npm', ['root', '-g'], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      HOME: directory,
      NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_LOGS_DIR: '/tmp/code-foundry-npm-oidc-npm-logs',
      NPM_CONFIG_USERCONFIG: '/dev/null',
      NPM_CONFIG_CACHE: '/tmp/code-foundry-npm-oidc-npm-cache',
      PATH: process.env.PATH,
    },
  }).trim()
  const npmPath = join(npmGlobalRoot, 'npm')
  const npmRequire = createRequire(join(npmPath, 'lib/npm.js'))
  const NpmConfig = npmRequire('@npmcli/config')
  const definitions = npmRequire('@npmcli/config/lib/definitions')
  const config = new NpmConfig({
    definitions: definitions.definitions,
    flatten: definitions.flatten,
    nerfDarts: definitions.nerfDarts,
    shorthands: definitions.shorthands,
    npmPath,
    argv: [],
    cwd: directory,
    env: {
      HOME: directory,
      NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_USERCONFIG: capturedConfig,
    },
    excludeNpmCwd: true,
    warn: false,
  })
  await config.load()
  assert.equal(config.get('//registry.npmjs.org/:_authToken'), dummyToken)
})

test('sync rejects an unsupported npm publication auth mode before writing', (t) => {
  const { directory } = fixture(t)
  writeFileSync(
    join(directory, '.github/code-foundry.yml'),
    'git_workflow: direct\nrelease_merge_strategy: squash\nrelease_type: auto\nnpm_publish_auth: bearer\n'
  )
  assert.throws(
    () => syncRepository({ target: directory, source: root }),
    /Unsupported npm_publish_auth: bearer; use auto, oidc, or token\./
  )
  assert.equal(existsSync(join(directory, '.github/workflows/release.yml')), false)
})
test('staging and publication download and pass one report per required node', () => {
  // The report arguments are hand-maintained next to the download loops, so
  // both must track REQUIRED_NODES or publication rejects the evidence set.
  for (const workflow of [caller, publisher]) {
    const loops = [...workflow.matchAll(/for node in ([\d ]+); do/g)].map((match) =>
      match[1].trim().split(/ +/)
    )
    assert.ok(loops.length >= 1)
    for (const nodes of loops) assert.deepEqual(nodes, [...REQUIRED_NODES])
    const reports = [...workflow.matchAll(/\$RUNNER_TEMP\/reports\/(\d+)\/report\.json/g)].map(
      (match) => match[1]
    )
    assert.deepEqual(reports, [...REQUIRED_NODES])
  }
})
test('post-release hook arguments are passed through environment variables', () => {
  const postRelease = release.split('\n  post-release:\n')[1].split('\n  npm:\n')[0]
  assert.match(postRelease, /RELEASE_TAG: \$\{\{ needs\.release\.outputs\.tag_name \}\}/)
  assert.match(postRelease, /POST_RELEASE_WORKFLOW: \$\{\{ steps\.hook\.outputs\.workflow \}\}/)
  assert.match(postRelease, /POST_RELEASE_MODE: \$\{\{ steps\.hook\.outputs\.mode \}\}/)
  assert.match(postRelease, /--tag "\$RELEASE_TAG"/)
  assert.match(postRelease, /--workflow "\$POST_RELEASE_WORKFLOW"/)
  assert.match(postRelease, /--mode "\$POST_RELEASE_MODE"/)
  assert.doesNotMatch(postRelease, /--(?:tag|workflow|mode) '\$\{\{/)
})
test('failed release creation reruns recover only an exact source-bound draft', () => {
  const recovery = caller.split('\n  recovery:\n')[1].split('\n  stage:\n')[0]
  // Recovery runs on the release result alone and computes its own source
  // SHA, so it can gate qualification for a stuck draft from an earlier push.
  assert.match(recovery, /needs: \[release\]/)
  assert.doesNotMatch(recovery, /needs: \[qualification/)
  assert.match(recovery, /RELEASE_CREATED/)
  assert.match(recovery, /resolveTagCommit/)
  assert.match(recovery, /releases\?per_page=100/)
  assert.match(recovery, /--paginate.*--slurp/)
  assert.match(recovery, /release\.draft !== true/)
  assert.match(recovery, /sourceSha\.toLowerCase\(\) !== process\.env\.SOURCE_SHA\.toLowerCase\(\)/)
  assert.match(caller, /needs\.recovery\.outputs\.found == 'true'/)
  assert.match(
    caller,
    /tag: \$\{\{ needs\.release\.outputs\.tag_name \|\| needs\.recovery\.outputs\.tag \}\}/
  )
})
test('release recovery uses a shell-safe Node heredoc', () => {
  const recovery = caller.split('\n  recovery:\n')[1].split('\n  stage:\n')[0]
  const script = recovery
    .split("node --input-type=module <<'NODE'\n")[1]
    ?.split('\n          NODE')[0]
  assert.ok(script, 'recovery must contain its inline Node heredoc')
  assert.match(script, /GitHub's get-by-tag endpoint/)
})
test('immutable activation is checked before release writes and can never toggle the setting', () => {
  const preflight = caller.split('\n  preflight:\n')[1].split('\n  release:\n')[0]
  assert.match(preflight, /test "\$REQUIRE_IMMUTABLE_RELEASES" = true/)
  assert.match(preflight, /release-integrity.mjs settings --repo/)
  assert.doesNotMatch(preflight, /gh api.*(?:--method|-X)|gh release (?:create|edit|upload)/)
})
test('pause override is explicit, manual-only and never permits non-main publication', () => {
  assert.equal(
    [
      ...publisher.matchAll(
        /github\.event_name == 'workflow_dispatch' && inputs\['billing-pause-bypass'\] == true/g
      ),
    ].length,
    2
  )
  assert.equal([...publisher.matchAll(/github\.ref == 'refs\/heads\/main'/g)].length, 2)
  assert.match(publisher, /billing-pause-bypass:\n(?:[^\n]*\n){3}        default: false/)
  assert.equal([...caller.matchAll(/if: github\.ref == 'refs\/heads\/main'/g)].length, 3)
})

test('consumer release callers keep a standalone release job', (t) => {
  const consumerRoot = mkdtempSync(join(tmpdir(), 'release-cutover-consumer-'))
  t.after(() => rmSync(consumerRoot, { recursive: true, force: true }))
  mkdirSync(join(consumerRoot, '.github'), { recursive: true })
  writeFileSync(join(consumerRoot, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
  writeFileSync(
    join(consumerRoot, '.github/code-foundry.yml'),
    'languages: typescript\npackage_manager: bun\nfeatures: release\ngit_workflow: direct\nmerge_strategy: squash\nrelease_merge_strategy: squash\n'
  )
  execFileSync('git', ['init', '-q'], { cwd: consumerRoot })
  syncRepository({ target: consumerRoot, source: process.cwd() })
  const consumer = readFileSync(join(consumerRoot, '.github/workflows/release.yml'), 'utf8')
  const job = consumer.split('\n  release:\n')[1].split(/\n  [a-z-]+:\n/)[0]
  assert.doesNotMatch(job, /needs: \[qualification/)
  assert.doesNotMatch(job, /needs: \[preflight\]/)
  assert.match(job, /uses: 0xPlayerOne\/code-foundry\/\.github\/workflows\/release\.yml@v/)
})
