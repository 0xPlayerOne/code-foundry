import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import {
  chunkFiles,
  freshCloneBuildHint,
  parseStagedFiles,
  planPreCommit,
  preCommitBuildEnabled,
} from '../src/lib/pre-commit.mjs'

const core = new URL('../src/runtime-core.mjs', import.meta.url).pathname

describe('planPreCommit', () => {
  it('formats and lints only staged files and skips the build', () => {
    const plan = planPreCommit(['src/a.ts', 'README.md', 'LICENSE', 'src/b.jsx'])
    assert.deepEqual(plan.formatFiles, ['src/a.ts', 'README.md', 'src/b.jsx'])
    assert.deepEqual(plan.lintFiles, ['src/a.ts', 'src/b.jsx'])
    assert.equal(plan.typeCheck, true)
    assert.equal(plan.build, false)
    assert.equal(plan.formatAll, false)
    assert.equal(plan.lintAll, false)
  })

  it('type-checks only for typed sources or compiler config', () => {
    for (const file of ['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'types.d.ts', 'pkg/tsconfig.build.json'])
      assert.equal(planPreCommit([file]).typeCheck, true, file)
    for (const file of ['README.md', 'a.js', 'a.mjs', 'styles.css', 'package.json'])
      assert.equal(planPreCommit([file]).typeCheck, false, file)
  })

  it('type-checks JavaScript when the repository checks JavaScript', () => {
    assert.equal(planPreCommit(['src/cli.mjs'], { checkJs: true }).typeCheck, true)
    assert.equal(planPreCommit(['jsconfig.json'], { checkJs: true }).typeCheck, true)
    assert.equal(planPreCommit(['README.md'], { checkJs: true }).typeCheck, false)
  })

  it('widens to the whole repository only when tool configuration is staged', () => {
    assert.equal(planPreCommit(['.oxfmtrc.json']).formatAll, true)
    assert.equal(planPreCommit(['.oxlintrc.json']).lintAll, true)
    assert.equal(planPreCommit(['pyproject.toml']).pythonAll, true)
    assert.equal(planPreCommit(['packages/x/.oxfmtrc.json']).formatAll, false)
  })

  it('builds only when opted in and code is staged', () => {
    assert.equal(planPreCommit(['src/a.ts'], { build: true }).build, true)
    assert.equal(planPreCommit(['package.json'], { build: true }).build, true)
    assert.equal(planPreCommit(['README.md'], { build: true }).build, false)
  })

  it('routes Python and Rust changes to their own tools', () => {
    const plan = planPreCommit(['app/main.py', 'crate/src/lib.rs'])
    assert.deepEqual(plan.pythonFiles, ['app/main.py'])
    assert.equal(plan.rust, true)
    assert.equal(planPreCommit(['README.md']).rust, false)
  })
})

describe('pre-commit helpers', () => {
  it('parses NUL-separated staged paths', () => {
    assert.deepEqual(parseStagedFiles('a b.ts\0ü.md\0'), ['a b.ts', 'ü.md'])
    assert.deepEqual(parseStagedFiles(''), [])
  })

  it('validates pre_commit_build', () => {
    assert.equal(preCommitBuildEnabled(undefined), false)
    assert.equal(preCommitBuildEnabled(''), false)
    assert.equal(preCommitBuildEnabled('true'), true)
    assert.equal(preCommitBuildEnabled('false'), false)
    assert.throws(() => preCommitBuildEnabled('yes'), /pre_commit_build/)
  })

  it('chunks long file lists', () => {
    assert.deepEqual(chunkFiles(['a', 'b', 'c'], 2), [['a', 'b'], ['c']])
    assert.deepEqual(chunkFiles([], 2), [])
  })
})

/** @param {string} [config] */
function fixture(config = '') {
  const root = mkdtempSync(join(tmpdir(), 'cf-pre-commit-'))
  mkdirSync(join(root, '.github'), { recursive: true })
  writeFileSync(
    join(root, '.github/code-foundry.yml'),
    `languages: typescript\npackage_manager: bun\n${config}`
  )
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({
      name: 'fixture',
      private: true,
      scripts: {
        'format:check': 'oxfmt --check .',
        lint: 'oxlint --deny-warnings',
        typecheck: 'tsc --noEmit',
        build: 'tsc',
      },
      devDependencies: { oxfmt: '*', oxlint: '*' },
    })}\n`
  )
  writeFileSync(join(root, 'tsconfig.json'), '{}\n')
  const bin = join(root, '.bin')
  mkdirSync(bin)
  for (const tool of ['bun', 'bunx']) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "$CF_TOOL_LOG"\n`)
    chmodSync(join(bin, tool), 0o755)
  }
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'],
    {
      cwd: root,
    }
  )
  return root
}

/** @param {string} root @param {Record<string, string>} files */
function stage(root, files) {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  execFileSync('git', ['add', '--', ...Object.keys(files)], { cwd: root })
}

/** @param {string} root */
function gate(root) {
  const log = join(root, 'tools.log')
  const result = spawnSync(process.execPath, [core, 'pre-commit'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(root, '.bin')}:${process.env.PATH}`,
      CF_TOOL_LOG: log,
    },
  })
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []
  return { status: result.status, calls, stderr: result.stderr }
}

describe('freshCloneBuildHint', () => {
  it('explains the fresh-clone failure mode only when the build is disabled but exists', () => {
    const hint = freshCloneBuildHint({ build: false, buildScript: true, packageManager: 'bun' })
    assert.match(hint, /"bun run build"/)
    assert.match(hint, /pre_commit_build: true/)
    assert.equal(
      freshCloneBuildHint({ build: true, buildScript: true, packageManager: 'bun' }),
      undefined
    )
    assert.equal(
      freshCloneBuildHint({ build: false, buildScript: false, packageManager: 'bun' }),
      undefined
    )
  })
})

describe('change-aware pre-commit gate', () => {
  it('does nothing when nothing is staged', () => {
    const root = fixture()
    try {
      const { status, calls } = gate(root)
      assert.equal(status, 0)
      assert.deepEqual(calls, [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('checks staged files, type-checks TypeScript, and never builds by default', () => {
    const root = fixture()
    try {
      // The fixture's whole-repo files must not be passed to the tools.
      writeFileSync(join(root, 'untouched.ts'), 'export {}\n')
      stage(root, { 'src/a.ts': 'export const a = 1\n', 'README.md': '# x\n', 'notes.txt': 'n\n' })
      const { status, calls } = gate(root)
      assert.equal(status, 0)
      assert.deepEqual(calls, [
        'bunx --no-install oxfmt --check --no-error-on-unmatched-pattern README.md src/a.ts',
        'bunx --no-install oxlint --deny-warnings --no-error-on-unmatched-pattern src/a.ts',
        'bun run typecheck',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips lint and type-check when only docs are staged', () => {
    const root = fixture()
    try {
      stage(root, { 'docs/guide.md': '# guide\n' })
      const { status, calls } = gate(root)
      assert.equal(status, 0)
      assert.deepEqual(calls, [
        'bunx --no-install oxfmt --check --no-error-on-unmatched-pattern docs/guide.md',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runs the repository format script when formatter configuration is staged', () => {
    const root = fixture()
    try {
      stage(root, { '.oxfmtrc.json': '{}\n' })
      const { calls } = gate(root)
      assert.deepEqual(calls, ['bun run format:check'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('builds at commit time only when pre_commit_build is true', () => {
    const root = fixture('pre_commit_build: true\n')
    try {
      stage(root, { 'src/a.ts': 'export const a = 1\n' })
      const { status, calls } = gate(root)
      assert.equal(status, 0)
      assert.equal(calls.filter((call) => call === 'bun run build').length, 1)
      assert.ok(
        calls.indexOf('bun run build') < calls.indexOf('bun run typecheck'),
        'the build must precede type-check, mirroring CI'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('still blocks whitespace errors before running any tool', () => {
    const root = fixture()
    try {
      stage(root, { 'src/a.ts': 'export const a = 1   \n' })
      const { status, calls } = gate(root)
      assert.notEqual(status, 0)
      assert.deepEqual(calls, [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runs no tools for a deletion-only commit', () => {
    const root = fixture()
    try {
      stage(root, { 'src/a.ts': 'export const a = 1\n' })
      execFileSync(
        'git',
        ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'a'],
        {
          cwd: root,
        }
      )
      execFileSync('git', ['rm', '-q', 'src/a.ts'], { cwd: root })
      const { status, calls } = gate(root)
      assert.equal(status, 0)
      assert.deepEqual(calls, [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('builds before lint and type-check when pre_commit_build opts in', () => {
    const root = fixture('pre_commit_build: true\n')
    try {
      stage(root, { 'src/a.ts': 'export const a = 1\n' })
      const { status, calls } = gate(root)
      assert.equal(status, 0)
      assert.deepEqual(calls, [
        'bunx --no-install oxfmt --check --no-error-on-unmatched-pattern src/a.ts',
        'bun run build',
        'bunx --no-install oxlint --deny-warnings --no-error-on-unmatched-pattern src/a.ts',
        'bun run typecheck',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
