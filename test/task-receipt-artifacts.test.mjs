import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const runtime = join(root, 'src/runtime.mjs')
const workflows = {
  'ci.yml': ['format', 'lint', 'type_check', 'build'],
  'test.yml': ['unit', 'performance', 'integration', 'e2e', 'smoke'],
}

for (const [file, tasks] of Object.entries(workflows)) {
  const source = readFileSync(join(root, '.github/workflows', file), 'utf8')
  for (const task of tasks) {
    test(`${file}: ${task} retains exactly its own hidden receipt after execution or explicit skip`, () => {
      const jobId = task === 'type_check' ? 'type-check' : task
      const block = source.split(`\n  ${jobId}:\n`)[1].split(/\n  [a-z0-9-]+:\n/)[0]
      const retention = block
        .split('      - name: Retain task receipt\n')[1]
        .split('      - name:')[0]
      assert.ok(retention)
      assert.match(block, /id: execute\n/)
      assert.match(retention, /always\(\)/)
      assert.match(retention, /steps.execute.outcome == 'failure'/)
      assert.match(retention, /steps.applicability.outputs.applicable == 'false'/)
      assert.ok(retention.includes(`hashFiles('.code-foundry/results/${task}.json') != ''`))
      assert.ok(retention.includes(`path: .code-foundry/results/${task}.json\n`))
      assert.ok(
        retention.includes(
          `name: \${{ inputs.artifact-prefix }}-\${{ github.run_id }}-\${{ github.run_attempt }}-${task}\n`
        )
      )
      assert.match(retention, /include-hidden-files: true\n/)
      assert.match(retention, /if-no-files-found: error\n/)
      assert.match(retention, /retention-days: 14\n/)
      assert.doesNotMatch(retention, /continue-on-error|overwrite:|secrets|\*\*/)
      assert.equal([...block.matchAll(/Retain task receipt/g)].length, 1)
      const execution = block.slice(
        block.indexOf('        id: execute'),
        block.indexOf('      - name: Retain task receipt')
      )
      assert.match(execution, /if: steps.applicability.outputs.applicable == 'true'/)
      assert.ok(execution.includes(`ci ${task}\n`))
      assert.doesNotMatch(execution, /continue-on-error|\|\| true/)
    })
  }
  test(`${file}: caller can namespace receipts without new privileges`, () => {
    assert.match(source, /artifact-prefix:\n(?:[^\n]*\n){3}        default: task-result/)
    assert.match(source, /permissions:\n  contents: read\n/)
    assert.doesNotMatch(source, /actions: write|id-token: write|contents: write/)
  })
}

for (const file of ['validation.yml', 'validation-no-codeql.yml']) {
  test(`${file}: forwards receipt namespace to both leaf workflows`, () => {
    const source = readFileSync(join(root, '.github/workflows', file), 'utf8')
    assert.match(source, /artifact-prefix:\n(?:[^\n]*\n){3}        default: task-result/)
    for (const job of ['ci', 'test']) {
      const block = source.split(`\n  ${job}:\n`)[1].split(/\n  [a-z0-9-]+:\n/)[0]
      assert.match(block, /uses: \.\/\.github\/workflows\/(ci|test)\.yml/)
      assert.match(block, /artifact-prefix: \$\{\{ inputs\.artifact-prefix \}\}/)
    }
  })
}

function fixture(t, script) {
  const directory = mkdtempSync(join(tmpdir(), 'task-receipt-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(join(directory, '.github'))
  writeFileSync(
    join(directory, '.github/code-foundry.yml'),
    'package_manager: npm\ncoverage_enforcement: off\n'
  )
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: 'receipt-fixture',
      private: true,
      packageManager: 'npm@10.9.2',
      scripts: script ? { 'test:unit': script } : {},
    })
  )
  writeFileSync(join(directory, 'package-lock.json'), '{"lockfileVersion":3}')
  const env = {
    ...process.env,
    CI: 'true',
    GITHUB_OUTPUT: '',
    GITHUB_STEP_SUMMARY: '',
    REPO_FOUNDRY_PROFILE: '',
    REPO_FOUNDRY_LANGUAGES: '',
    REPO_FOUNDRY_PACKAGE_MANAGER: 'npm',
  }
  return { directory, env }
}

for (const [name, script, expected] of [
  ['success', 'node -e "process.exit(0)"', 'passed'],
  ['failure', 'node -e "process.exit(7)"', 'failed'],
]) {
  test(`actual runtime produces the uploaded unit receipt on ${name}`, (t) => {
    const { directory, env } = fixture(t, script)
    const before = Date.now()
    const result = spawnSync(process.execPath, [runtime, 'ci', 'unit'], {
      cwd: directory,
      env,
      encoding: 'utf8',
      timeout: 15000,
    })
    assert.equal(result.status === 0, expected === 'passed', result.stderr)
    const report = JSON.parse(
      readFileSync(join(directory, '.code-foundry/results/unit.json'), 'utf8')
    )
    assert.equal(report.kind, 'code-foundry-task-result')
    assert.equal(report.task, 'unit')
    assert.equal(report.status, expected)
    assert.ok(Date.parse(report.startedAt) >= before)
    assert.equal(report.commands[0].status === 0, expected === 'passed')
    assert.equal(Object.hasOwn(report, 'env'), false)
    assert.equal(Object.hasOwn(report, 'stdout'), false)
  })
}

test('actual optional discovery writes an explicit skip receipt at the exact upload path', (t) => {
  const { directory, env } = fixture(t)
  const result = spawnSync(process.execPath, [runtime, 'ci', 'task_profile', 'e2e'], {
    cwd: directory,
    env,
    encoding: 'utf8',
    timeout: 15000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /applicable=false/)
  const report = JSON.parse(readFileSync(join(directory, '.code-foundry/results/e2e.json'), 'utf8'))
  assert.equal(report.status, 'skipped')
  assert.equal(report.task, 'e2e')
  assert.deepEqual(report.commands, [])
})
