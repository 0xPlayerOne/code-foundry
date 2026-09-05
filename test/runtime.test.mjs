import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const runtime = new URL('../src/runtime.mjs', import.meta.url)

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-runtime-'))
  mkdirSync(join(root, '.github'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'tests', 'smoke'), { recursive: true })
  writeFileSync(join(root, '.github', 'code-foundry.yml'), 'languages: typescript\npackage_manager: bun\n')
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","private":true}\n')
  writeFileSync(join(root, 'src', 'value.test.ts'), '')
  writeFileSync(join(root, 'tests', 'smoke', 'health.test.ts'), '')
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  return root
}

test('task profile skips categories without discoverable tests', () => {
  const root = fixture()
  const output = execFileSync(process.execPath, [runtime.pathname, 'ci', 'task_profile', 'integration'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: '' },
  })
  assert.match(output, /applicable=false/)
})

test('smoke execution passes only smoke files to Bun', () => {
  const root = fixture()
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const log = join(root, 'bun-args.log')
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$BUN_ARGS_LOG"\n')
  execFileSync('chmod', ['+x', join(bin, 'bun')])
  execFileSync(process.execPath, [runtime.pathname, 'ci', 'smoke'], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BUN_ARGS_LOG: log },
  })
  const args = readFileSync(log, 'utf8')
  assert.match(args, /test\n/)
  assert.match(args, /tests\/smoke\/health\.test\.ts/)
  assert.doesNotMatch(args, /src\/value\.test\.ts/)
})

test('lint skips the eslint fallback without repository-owned setup', () => {
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-lint-skip-'))
  writeFileSync(join(root, '.github-code-foundry-stub'), '')
  mkdirSync(join(root, '.github'), { recursive: true })
  writeFileSync(join(root, '.github', 'code-foundry.yml'), 'languages: typescript\npackage_manager: npm\n')
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","private":true}\n')
  writeFileSync(join(root, 'package-lock.json'), '{"name":"fixture","lockfileVersion":3,"packages":{}}\n')
  writeFileSync(join(root, 'index.ts'), 'export const value = 1\n')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const log = join(root, 'npx-calls.log')
  writeFileSync(join(bin, 'npx'), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$NPX_ARGS_LOG"\nexit 0\n')
  execFileSync('chmod', ['+x', join(bin, 'npx')])
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  const result = execFileSync(process.execPath, [runtime.pathname, 'ci', 'lint'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NPX_ARGS_LOG: log },
  })
  assert.equal(result.status ?? 0, 0)
  assert.equal(existsSync(log), false, 'fallback must not invoke npx without eslint setup')
})
