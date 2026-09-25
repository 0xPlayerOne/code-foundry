import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const runtime = fileURLToPath(new URL('../src/runtime.mjs', import.meta.url))

/**
 * Build a Python repository whose `uv` stub replays the exact report and exit
 * status a real pip-audit run produced, so the gate decision can be asserted
 * without installing the tool.
 */
function fixture(t, { exitCode, stdout, stderr = '' }) {
  const root = mkdtempSync(join(tmpdir(), 'foundry-python-audit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, content) => {
    const destination = join(root, path)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, content)
  }
  write('.github/code-foundry.yml', 'languages: python\npackage_manager: none\n')
  write('pyproject.toml', '[project]\nname = "fixture"\nversion = "0.1.0"\n')
  write(
    'bin/uv',
    [
      '#!' + process.execPath,
      '// `commandExists` probes with --version; only the audit run may fail.',
      "if (process.argv.slice(2).includes('--version')) process.exit(0)",
      'process.stdout.write(process.env.FAKE_STDOUT)',
      'process.stderr.write(process.env.FAKE_STDERR)',
      'process.exit(Number(process.env.FAKE_EXIT))',
      '',
    ].join('\n')
  )
  chmodSync(join(root, 'bin', 'uv'), 0o755)
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  return spawnSync(process.execPath, [runtime, 'security', 'audit', 'python'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      GITHUB_OUTPUT: '',
      GITHUB_STEP_SUMMARY: '',
      REPO_FOUNDRY_PYTHON_REQUIREMENT: 'project',
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      FAKE_EXIT: String(exitCode),
      FAKE_STDOUT: stdout,
      FAKE_STDERR: stderr,
    },
  })
}

test('audit passes when the tool reports no known vulnerabilities despite a non-zero exit', (t) => {
  const result = fixture(t, {
    exitCode: 1,
    stdout: 'No known vulnerabilities found\n',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /No known vulnerabilities found/)
  assert.match(result.stderr, /::warning::uv exited 1 with no known vulnerabilities/)
})

test('audit fails when the tool reports a vulnerability and exits non-zero', (t) => {
  const result = fixture(t, {
    exitCode: 1,
    stdout: [
      'Found 1 known vulnerability in 1 package',
      'NAME    VERSION  ID',
      'demo    1.0.0    PYSEC-2024-1',
      '',
    ].join('\n'),
  })
  assert.equal(result.status, 1)
  assert.doesNotMatch(result.stdout, /::warning::/)
})

test('audit fails on a non-zero exit that reports neither a clean nor a vulnerable result', (t) => {
  const result = fixture(t, { exitCode: 2, stdout: '', stderr: 'ERROR: resolution failed\n' })
  assert.equal(result.status, 2)
  assert.doesNotMatch(result.stdout, /::warning::/)
})

test('a clean marker alongside an advisory identifier still fails', (t) => {
  const result = fixture(t, {
    exitCode: 1,
    stdout: 'No known vulnerabilities found\nGHSA-abcd-1234-efgh\n',
  })
  assert.equal(result.status, 1)
  assert.doesNotMatch(result.stdout, /::warning::/)
})

test('a zero exit passes without emitting a warning', (t) => {
  const result = fixture(t, { exitCode: 0, stdout: 'No known vulnerabilities found\n' })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /::warning::/)
})

test('the clean marker is recognised on stderr as well as stdout', (t) => {
  const result = fixture(t, {
    exitCode: 1,
    stdout: '',
    stderr: 'No known vulnerabilities found\n',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /::warning::/)
})
