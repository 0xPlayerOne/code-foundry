import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { packageManagerForLockfile } from '../src/lib/lockfiles.mjs'

const mainRuleset = (enforcement) => ({
  id: 17,
  name: 'main protection',
  target: 'branch',
  ...(enforcement === undefined ? {} : { enforcement }),
  conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
  rules: [
    {
      type: 'required_status_checks',
      parameters: { required_status_checks: [{ context: 'Validation / Gate' }] },
    },
    { type: 'pull_request', parameters: { allowed_merge_methods: ['squash'] } },
  ],
})

function runGithubDoctor(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'foundry-doctor-ruleset-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.github/workflows'), { recursive: true })
  mkdirSync(join(root, 'bin'))
  writeFileSync(
    join(root, '.github/code-foundry.yml'),
    'git_workflow: direct\nrelease_type: none\n'
  )

  const state = {
    rulesets: options.rulesets ?? [],
    protection: options.protection ?? null,
    rulesetsUnavailable: options.rulesetsUnavailable ?? false,
    protectionUnavailable: options.protectionUnavailable ?? false,
    repository: {
      private: options.privateRepository ?? false,
      visibility: options.privateRepository ? 'private' : 'public',
      allow_squash_merge: true,
      allow_rebase_merge: false,
      allow_merge_commit: false,
      allow_auto_merge: false,
    },
  }
  const gh = join(root, 'bin/gh')
  writeFileSync(
    gh,
    `#!${process.execPath}
const state = ${JSON.stringify(state)}
const args = process.argv.slice(2)
if (args[0] === '--version') process.exit(0)
if (args[0] === 'api') {
  const path = args[1]
  if (path === 'repos/test/repo/rulesets') {
    if (state.rulesetsUnavailable) process.exit(1)
    console.log(JSON.stringify(state.rulesets))
  } else if (path.startsWith('repos/test/repo/rulesets/')) {
    const id = Number(path.split('/').at(-1))
    console.log(JSON.stringify(state.rulesets.find((ruleset) => ruleset.id === id) ?? {}))
  } else if (path === 'repos/test/repo/branches/main/protection') {
    if (state.protectionUnavailable) process.exit(1)
    console.log(JSON.stringify(state.protection))
  } else if (path === 'repos/test/repo/git/ref/heads/main') {
    console.log('{"object":{"sha":"abc"}}')
  } else if (path.startsWith('repos/test/repo/commits/abc/check-runs')) {
    console.log('{"check_runs":[{"name":"Validation / Gate"}]}')
  } else if (path === 'repos/test/repo') {
    console.log(JSON.stringify(state.repository))
  } else {
    console.log('{}')
  }
} else if (args[0] === 'secret' || args[0] === 'variable' || args[0] === 'pr') {
  console.log('[]')
} else {
  console.log('{}')
}
`
  )
  chmodSync(gh, 0o755)

  const entry = new URL('../src/lib/github-doctor.mjs', import.meta.url).href
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { doctorGithub } from ${JSON.stringify(entry)}; console.log(JSON.stringify(doctorGithub(process.argv[1])))`,
      root,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_REPOSITORY: 'test/repo',
        PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      },
    }
  )
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

for (const [file, manager] of [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]) {
  test(`doctor identifies ${file} as ${manager}`, () => {
    assert.equal(packageManagerForLockfile(file), manager)
  })
}

test('unknown lockfiles do not invent a package manager', () => {
  assert.equal(packageManagerForLockfile('package.json'), undefined)
  assert.equal(packageManagerForLockfile('toString'), undefined)
  assert.equal(packageManagerForLockfile(undefined), undefined)
})

test('GitHub doctor accepts an actively enforced main ruleset', (t) => {
  const report = runGithubDoctor(t, { rulesets: [mainRuleset('active')] })
  assert.deepEqual(report.details.requiredChecks, ['Validation / Gate'])
  assert.doesNotMatch(report.errors.join(' '), /main ruleset .*enforcement/i)
})

for (const [enforcement, expected] of [
  ['disabled', /main ruleset main protection is disabled.*not enforced/i],
  ['evaluate', /main ruleset main protection is evaluate-only.*not enforced/i],
]) {
  test(`GitHub doctor rejects a main ruleset in ${enforcement} mode`, (t) => {
    const report = runGithubDoctor(t, { rulesets: [mainRuleset(enforcement)] })
    assert.match(report.errors.join('\n'), expected)
    assert.deepEqual(report.details.requiredChecks, ['Validation / Gate'])
  })
}

test('GitHub doctor does not assume enforcement when the ruleset state is missing', (t) => {
  const report = runGithubDoctor(t, { rulesets: [mainRuleset(undefined)] })
  assert.match(report.warnings.join('\n'), /enforcement state.*could not be confirmed/i)
  assert.doesNotMatch(report.errors.join(' '), /main ruleset .*enforcement/i)
})

test('GitHub doctor preserves the unsupported private-plan warning path', (t) => {
  const report = runGithubDoctor(t, {
    privateRepository: true,
    rulesetsUnavailable: true,
    protectionUnavailable: true,
  })
  assert.match(
    report.warnings.join('\n'),
    /branch protection or repository rulesets are not readable/i
  )
  assert.doesNotMatch(report.errors.join(' '), /main ruleset .*enforcement/i)
  assert.deepEqual(report.details.requiredChecks, [])
})

for (const topology of ['direct', 'staging-release']) {
  test(`GitHub doctor reads ${topology} and credential policies from the shared config`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'foundry-doctor-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    mkdirSync(join(root, 'bin'))
    writeFileSync(
      join(root, '.github/code-foundry.yml'),
      [
        `git_workflow: '${topology}' # retained by the shared reader`,
        'release_type: none',
        'npm_publish: true',
        'turbo_remote: true',
        'post_release_mode: workflow-dispatch',
      ].join('\n')
    )
    const gh = join(root, 'bin/gh')
    writeFileSync(
      gh,
      `#!${process.execPath}\nconst args = process.argv.slice(2)\nif (args[0] === '--version') process.exit(0)\nif (args[0] === 'api' && args[1] === 'repos/test/repo') {\n  console.log(JSON.stringify(${JSON.stringify({ allow_squash_merge: topology === 'direct', allow_rebase_merge: topology !== 'direct', allow_merge_commit: false, allow_auto_merge: false })}))\n} else console.log('[]')\n`
    )
    chmodSync(gh, 0o755)
    const entry = new URL('../src/lib/github-doctor.mjs', import.meta.url).href
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { doctorGithub } from ${JSON.stringify(entry)}; console.log(JSON.stringify(doctorGithub(process.argv[1])))`,
        root,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_REPOSITORY: 'test/repo',
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        },
      }
    )
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.deepEqual(report.errors, [
      'post-release workflow-dispatch mode requires CODE_FOUNDRY_TOKEN to be present.',
    ])
    assert.ok(report.warnings.some((message) => message.startsWith('npm_publish is enabled')))
    assert.ok(report.warnings.some((message) => message.startsWith('turbo_remote is enabled')))
  })
}
