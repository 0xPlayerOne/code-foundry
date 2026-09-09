import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import {
  executeFleetCommand,
  rolloutIdentity,
  upgradeManifestFleet,
} from '../src/lib/fleet-manifest.mjs'

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function fixture(t, mode) {
  const root = mkdtempSync(join(tmpdir(), 'foundry-source-identity-'))
  const exitCode = process.exitCode
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    process.exitCode = exitCode
  })
  const path = join(root, 'app')
  const remote = join(root, 'app.git')
  mkdirSync(path)
  git(root, 'init', '--bare', '--initial-branch=main', remote)
  git(path, 'init', '--initial-branch=main')
  git(path, 'config', 'user.name', 'Fixture')
  git(path, 'config', 'user.email', 'fixture@example.invalid')
  mkdirSync(join(path, '.github'))
  const config = join(path, '.github/code-foundry.yml')
  writeFileSync(config, 'runtime_ref: v1.0.0\ngit_workflow: direct\n')
  writeFileSync(join(path, 'source.txt'), 'original\n')
  git(path, 'add', '.')
  git(path, 'commit', '-m', 'fixture')
  git(path, 'remote', 'add', 'origin', remote)
  git(path, 'push', '-u', 'origin', 'main')
  const main = git(path, 'rev-parse', 'HEAD')
  const script =
    mode === 'read-only'
      ? 'process.exit(0)'
      : `
        const { execFileSync } = require('node:child_process')
        const { writeFileSync } = require('node:fs')
        const git = (...args) => execFileSync('git', args, { stdio: 'pipe' })
        if (${JSON.stringify(mode)} === 'commit-source') {
          writeFileSync('source.txt', 'modified during validation\\n')
          git('add', 'source.txt')
        }
        git('commit', '--allow-empty', '-m', 'unexpected validation commit')
      `
  const entry = {
    repository: 'test/app',
    path: 'app',
    cohort: 'canary',
    validation: [[process.execPath, '-e', script]],
    requiredChecks: ['Validation / Gate'],
  }
  const version = 'v1.1.0'
  writeFileSync(
    join(root, 'code-foundry-fleet.json'),
    JSON.stringify({ schemaVersion: 1, cohorts: ['canary'], repositories: [entry] })
  )
  const identity = rolloutIdentity(entry, version, 'main')
  git(path, 'switch', '-c', identity.branch)
  writeFileSync(config, `runtime_ref: ${version}\ngit_workflow: direct\n`)
  git(path, 'add', '.')
  const tree = git(path, 'write-tree')
  git(
    path,
    'commit',
    '-m',
    `chore: upgrade\n\nCode-Foundry-Rollout: ${identity.id}\nCode-Foundry-Tree: ${tree}`
  )
  const candidate = git(path, 'rev-parse', 'HEAD')
  git(path, 'switch', 'main')
  const calls = []
  const run = (cwd, argv) => {
    calls.push(argv)
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' })
    if (argv.slice(0, 4).join(' ') === 'git remote get-url origin')
      return ok('https://github.com/test/app.git')
    if (argv[0] !== 'gh') return executeFleetCommand(cwd, argv)
    if (argv[1] === 'pr' && argv[2] === 'list') return ok('[]')
    if (argv[1] === 'pr' && argv[2] === 'create') {
      assert.ok(argv.includes('--draft'))
      return ok('https://github.com/test/app/pull/1')
    }
    if (argv[1] === 'pr' && argv[2] === 'view')
      return ok(
        JSON.stringify({
          headRefOid: git(path, 'ls-remote', 'origin', `refs/heads/${identity.branch}`).split(
            /\s/
          )[0],
          headRefName: identity.branch,
          baseRefName: 'main',
          isCrossRepository: false,
          isDraft: true,
        })
      )
    throw new Error(`Unexpected fixture command: ${argv}`)
  }
  const sync = () => {
    throw new Error('Resuming a recorded candidate must not synchronize again')
  }
  return { root, path, identity, main, candidate, version, run, calls, sync }
}

for (const mode of ['commit-source', 'empty-commit']) {
  test(`resumed validation rejects ${mode} even when the worktree stays clean`, (t) => {
    const f = fixture(t, mode)
    const report = upgradeManifestFleet(
      f.root,
      f.root,
      { createPr: true, version: f.version },
      f.sync,
      f.run
    )
    assert.equal(report[0].status, 'failed')
    assert.match(report[0].reason, /Validation modified the candidate source/)
    assert.equal(
      f.calls.some((argv) => argv[0] === 'git' && argv[1] === 'push'),
      false
    )
    assert.equal(
      f.calls.some((argv) => argv[0] === 'gh' && argv[2] === 'create'),
      false
    )
    assert.equal(git(f.path, 'rev-parse', 'HEAD'), f.main)
    assert.equal(git(f.path, 'rev-parse', f.identity.branch), f.candidate)
    assert.equal(git(f.path, 'status', '--porcelain'), '')
    assert.equal(readFileSync(join(f.path, 'source.txt'), 'utf8'), 'original\n')
    assert.equal(git(f.path, 'ls-remote', 'origin', `refs/heads/${f.identity.branch}`), '')
  })
}

test('read-only validation resumes and publishes the exact recorded candidate', (t) => {
  const f = fixture(t, 'read-only')
  const report = upgradeManifestFleet(
    f.root,
    f.root,
    { createPr: true, version: f.version },
    f.sync,
    f.run
  )
  assert.equal(report[0].status, 'pr-resumed')
  assert.equal(
    git(f.path, 'ls-remote', 'origin', `refs/heads/${f.identity.branch}`).split(/\s/)[0],
    f.candidate
  )
  assert.equal(git(f.path, 'rev-parse', 'HEAD'), f.main)
  assert.equal(git(f.path, 'status', '--porcelain'), '')
})
