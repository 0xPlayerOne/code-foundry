import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    release.indexOf('      - name: Normalize generated release PR draft state')
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
    assert.match(block, /if: inputs\['defer-publication'\] != true &&/)
  }
  const producer = caller.split('\n  release:\n')[1].split('\n  stage:\n')[0]
  assert.match(producer, /defer-publication: true/)
  assert.doesNotMatch(producer, /NPM_TOKEN/)
  // Release Please consumes no qualification outputs: the producer runs first
  // and qualification executes only when a release (or a stuck draft) needs it.
  assert.match(producer, /needs: \[preflight\]/)
  assert.doesNotMatch(producer, /needs: \[qualification/)
})
test('staging consumes verified current-attempt bytes without a rebuild and keeps publication automatic', () => {
  const stage = caller.split('\n  stage:\n')[1].split('\n  publish:\n')[0]
  assert.doesNotMatch(stage, /environment: release/)
  assert.match(stage, /needs: \[qualification, release, recovery\]/)
  assert.match(stage, /needs\.qualification\.outputs\.candidate-artifact/)
  assert.match(stage, /test "\$\(sha256sum .*\)" = "\$CANDIDATE_SHA256"/)
  assert.match(stage, /consumer-qualification-\$GITHUB_RUN_ATTEMPT-node-/)
  assert.match(stage, /qualified-publication.mjs stage/)
  assert.doesNotMatch(stage, /npm (pack|publish|install)|bun install|secrets.NPM_TOKEN/)
  assert.match(caller, /needs: \[qualification, release, recovery, stage\]/)
  assert.match(caller, /uses: \.\/\.github\/workflows\/qualified-foundry-publish.yml/)
  assert.doesNotMatch(caller, /environment: npm/)
  assert.match(caller, /cancel-in-progress: false/)
  assert.doesNotMatch(publisher, /environment:/)
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
