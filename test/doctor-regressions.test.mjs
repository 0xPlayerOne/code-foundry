import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { packageManagerForLockfile } from '../src/lib/lockfiles.mjs'

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

for (const topology of ['direct', 'staging-release']) {
  test(`GitHub doctor reads ${topology} and credential policies from the shared config`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'foundry-doctor-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, '.github/code-foundry.yml'), [
      `git_workflow: '${topology}' # retained by the shared reader`,
      'release_type: none',
      'npm_publish: true',
      'turbo_remote: true',
      'post_release_mode: workflow-dispatch',
    ].join('\n'))
    const gh = join(root, 'bin/gh')
    writeFileSync(gh, `#!${process.execPath}\nconst args = process.argv.slice(2)\nif (args[0] === '--version') process.exit(0)\nif (args[0] === 'api' && args[1] === 'repos/test/repo') {\n  console.log(JSON.stringify(${JSON.stringify({ allow_squash_merge: topology === 'direct', allow_rebase_merge: topology !== 'direct', allow_merge_commit: false, allow_auto_merge: false })}))\n} else console.log('[]')\n`)
    chmodSync(gh, 0o755)
    const entry = new URL('../src/lib/github-doctor.mjs', import.meta.url).href
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { doctorGithub } from ${JSON.stringify(entry)}; console.log(JSON.stringify(doctorGithub(process.argv[1])))`, root], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_REPOSITORY: 'test/repo', PATH: `${join(root, 'bin')}:${process.env.PATH}` },
    })
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.deepEqual(report.errors, ['post-release workflow-dispatch mode requires CODE_FOUNDRY_TOKEN to be present.'])
    assert.ok(report.warnings.some((message) => message.startsWith('npm_publish is enabled')))
    assert.ok(report.warnings.some((message) => message.startsWith('turbo_remote is enabled')))
  })
}
