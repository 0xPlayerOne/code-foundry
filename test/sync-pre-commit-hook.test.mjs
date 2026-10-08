import { strict as assert } from 'node:assert'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { spawnSync } from 'node:child_process'
import { syncRepository } from '../src/commands/sync.mjs'

// The generated hook probes the machine's global git config so it can chain
// to the developer's own hooks. Isolate this file from the real machine: a
// developer with a global hooksPath (secret guards, git-lfs) would otherwise
// have that guard run inside these tests.
const machineIsolation = mkdtempSync(join(tmpdir(), 'cf-hook-machine-'))
const realGlobalConfig = process.env.GIT_CONFIG_GLOBAL
process.env.GIT_CONFIG_GLOBAL = join(machineIsolation, 'gitconfig')
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '')
after(() => {
  if (realGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = realGlobalConfig
  rmSync(machineIsolation, { recursive: true, force: true })
})

function consumer() {
  const root = mkdtempSync(join(tmpdir(), 'cf-hook-'))
  mkdirSync(join(root, '.github/workflows'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"f","version":"1.0.0"}\n')
  writeFileSync(
    join(root, '.github/code-foundry.yml'),
    'languages: typescript\npackage_manager: bun\nfeatures: all\ngit_workflow: direct\nmerge_strategy: squash\nrelease_merge_strategy: squash\n'
  )
  spawnSync('git', ['init', '-q'], { cwd: root })
  return root
}
function stage(root) {
  writeFileSync(join(root, 'a.txt'), 'x\n')
  spawnSync('git', ['add', 'a.txt'], { cwd: root })
}
function gate(root) {
  const p = join(root, '.githooks/pre-commit')
  chmodSync(p, 0o755)
  return spawnSync(p, [], { cwd: root, encoding: 'utf8' })
}

describe('generated pre-commit hook', () => {
  it('never fetches anything at commit time', () => {
    const root = consumer()
    try {
      syncRepository({ target: root, source: process.cwd() })
      const h = readFileSync(join(root, '.githooks/pre-commit'), 'utf8')
      assert.doesNotMatch(h, /\bnpx\b/, 'must not shell out to npx')
      assert.doesNotMatch(h, /https?:/, 'must not reference a registry')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails the commit when the depended-on gate fails', () => {
    const root = consumer()
    try {
      syncRepository({ target: root, source: process.cwd() })
      mkdirSync(join(root, 'node_modules/.bin'), { recursive: true })
      writeFileSync(join(root, 'node_modules/.bin/code-foundry'), '#!/bin/sh\nexit 7\n')
      chmodSync(join(root, 'node_modules/.bin/code-foundry'), 0o755)
      stage(root)
      const r = gate(root)
      assert.equal(r.status, 7, `gate failure must fail the commit, got ${r.status}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to the whitespace guard when the gate is not installed', () => {
    const root = consumer()
    try {
      syncRepository({ target: root, source: process.cwd() })
      stage(root)
      const r = gate(root)
      assert.equal(r.status, 0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('blocks a commit with trailing whitespace only when the gate is absent', () => {
    const root = consumer()
    try {
      syncRepository({ target: root, source: process.cwd() })
      writeFileSync(join(root, 'b.txt'), 'trailing   \n')
      spawnSync('git', ['init', '-q'], { cwd: root })
      spawnSync('git', ['add', 'b.txt'], { cwd: root })
      const r = gate(root)
      assert.notEqual(r.status, 0, 'the fallback must still catch whitespace errors')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/** Create a machine hooks directory holding a guard hook that records it ran. */
function machineHooks(root, name = 'machine-hooks', hooks = ['pre-commit']) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const hook of hooks) {
    writeFileSync(
      join(dir, hook),
      `#!/bin/sh\necho "${hook}" >> "${join(root, 'machine-ran.log')}"\n`
    )
    chmodSync(join(dir, hook), 0o755)
  }
  return dir
}

describe('machine-level hook chaining', () => {
  it('records the replaced hooksPath and chains the machine pre-commit ahead of the gate', () => {
    const root = consumer()
    try {
      const machine = machineHooks(root)
      spawnSync('git', ['config', 'core.hooksPath', join(machine)], { cwd: root })
      syncRepository({ target: root, source: process.cwd() })
      assert.equal(
        String(
          spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root }).stdout ?? ''
        ).trim(),
        '.githooks',
        'sync still owns the hooks path'
      )
      assert.equal(
        String(
          spawnSync('git', ['config', '--get', 'code-foundry.previousHooksPath'], { cwd: root })
            .stdout ?? ''
        ).trim(),
        machine,
        'sync records what it replaced so the hook can chain to it'
      )
      mkdirSync(join(root, 'node_modules/.bin'), { recursive: true })
      writeFileSync(join(root, 'node_modules/.bin/code-foundry'), '#!/bin/sh\nexit 7\n')
      chmodSync(join(root, 'node_modules/.bin/code-foundry'), 0o755)
      stage(root)
      const ran = gate(root)
      assert.equal(ran.status, 7, 'the gate still decides the commit')
      const chained = readFileSync(join(root, 'machine-ran.log'), 'utf8').trim()
      assert.match(chained, /pre-commit/, 'the machine guard must have run before the gate')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('delegates machine hooks this repository does not own and removes stale delegates', () => {
    const root = consumer()
    try {
      const machine = machineHooks(root, 'machine-hooks', [
        'pre-commit',
        'post-checkout',
        'pre-push',
      ])
      spawnSync('git', ['config', 'core.hooksPath', join(machine)], { cwd: root })
      syncRepository({ target: root, source: process.cwd() })
      assert.match(readFileSync(join(root, '.githooks/post-checkout'), 'utf8'), /^#!/)
      assert.equal(
        spawnSync(join(root, '.githooks/post-checkout'), ['new-sha', 'old-sha', '1'], {
          cwd: root,
        }).status,
        0,
        'the delegate runs the machine hook'
      )
      assert.match(
        readFileSync(join(root, 'machine-ran.log'), 'utf8'),
        /post-checkout/,
        'the machine post-checkout must fire again after sync'
      )
      // A second sync with the machine hook gone removes the stale delegate
      // but never touches hooks it did not generate.
      rmSync(join(machine, 'post-checkout'))
      writeFileSync(join(root, '.githooks/pre-push'), '#!/bin/sh\nexit 0\n')
      chmodSync(join(root, '.githooks/pre-push'), 0o755)
      syncRepository({ target: root, source: process.cwd() })
      assert.ok(!existsSync(join(root, '.githooks/post-checkout')), 'stale delegate removed')
      assert.ok(existsSync(join(root, '.githooks/pre-push')), 'a foreign hook file is left alone')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('chains a pre-commit found in the default hooks directory without a hooksPath', () => {
    const root = consumer()
    try {
      machineHooks(root, '.git/hooks')
      syncRepository({ target: root, source: process.cwd() })
      stage(root)
      gate(root)
      assert.match(
        readFileSync(join(root, 'machine-ran.log'), 'utf8'),
        /pre-commit/,
        'git-lfs-style hooks installed in .git/hooks keep firing'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runs nothing extra when the machine has no hooks', () => {
    const root = consumer()
    try {
      syncRepository({ target: root, source: process.cwd() })
      stage(root)
      assert.equal(gate(root).status, 0, 'an unhooked machine keeps the fast path')
      assert.ok(!existsSync(join(root, '.githooks/post-checkout')))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('mutual hook delegation', () => {
  it('a machine guard that chains back to .githooks runs once instead of looping', () => {
    const root = consumer()
    try {
      const machine = join(root, 'guard-hooks')
      mkdirSync(machine, { recursive: true })
      // Mirrors the global secret-guard shape seen in the wild: run the guard
      // policy, then delegate to the repository's own hook.
      writeFileSync(
        join(machine, 'pre-commit'),
        `#!/bin/sh
echo guard >> "${join(root, 'machine-ran.log')}"
"$(${'git'} rev-parse --show-toplevel)/.githooks/pre-commit" || exit $?
`
      )
      chmodSync(join(machine, 'pre-commit'), 0o755)
      spawnSync('git', ['config', 'core.hooksPath', machine], { cwd: root })
      syncRepository({ target: root, source: process.cwd() })
      mkdirSync(join(root, 'node_modules/.bin'), { recursive: true })
      writeFileSync(
        join(root, 'node_modules/.bin/code-foundry'),
        '#!/bin/sh\necho gate >> "' + join(root, 'machine-ran.log') + '"\nexit 7\n'
      )
      chmodSync(join(root, 'node_modules/.bin/code-foundry'), 0o755)
      stage(root)
      const ran = gate(root)
      assert.equal(ran.status, 7, 'the gate decides the commit through both layers')
      const runs = readFileSync(join(root, 'machine-ran.log'), 'utf8').trim().split('\n')
      assert.equal(
        runs.filter((line) => line === 'guard').length,
        1,
        'the guard must run exactly once, not recurse'
      )
      assert.deepEqual(runs, ['guard', 'gate'], 'machine policy runs before project policy')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
