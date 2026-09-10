import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REQUIRED_FIXTURES } from '../src/commands/qualified-publication.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const workflow = readFileSync(join(root, '.github/workflows/consumer-qualification.yml'), 'utf8')
const inline = workflow
  .match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE/)[1]
  .split('\n')
  .map((line) => line.slice(10))
  .join('\n')
const guard = workflow
  .match(
    /name: Require the complete successful matrix\n        run: \|\n([\s\S]*?)(?=\n      - name:)/
  )[1]
  .split('\n')
  .map((line) => line.slice(10))
  .join('\n')

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'qualification-handoff-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const asset = `code-foundry-${version}.tgz`
  mkdirSync(join(directory, 'package'))
  mkdirSync(join(directory, 'candidate'))
  writeFileSync(
    join(directory, 'package/package.json'),
    JSON.stringify({ name: 'code-foundry', version })
  )
  const tar = spawnSync(
    'tar',
    ['-czf', join(directory, 'candidate', asset), '-C', directory, 'package'],
    { encoding: 'utf8' }
  )
  assert.equal(tar.status, 0, tar.stderr)
  const digest = createHash('sha256')
    .update(readFileSync(join(directory, 'candidate', asset)))
    .digest('hex')
  const env = {
    ...process.env,
    RUNNER_TEMP: directory,
    PACKAGE: asset,
    SOURCE_SHA: 'a'.repeat(40),
    CANDIDATE_SHA256: digest,
    GITHUB_REPOSITORY: 'example/foundry',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_OUTPUT: join(directory, 'outputs'),
  }
  writeFileSync(env.GITHUB_OUTPUT, '')
  for (const major of ['24', '26']) {
    const path = join(directory, 'reports', major)
    mkdirSync(path, { recursive: true })
    writeFileSync(
      join(path, 'report.json'),
      JSON.stringify({
        schema_version: 1,
        source_sha: env.SOURCE_SHA,
        artifact_sha256: digest,
        node: `v${major}.0.0`,
        complete: true,
        actionlint: true,
        fixtures: REQUIRED_FIXTURES.map((name) => ({ name, status: 'passed' })),
      })
    )
  }
  return { directory, env }
}

function execute(env) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', inline], {
    cwd: root,
    env,
    encoding: 'utf8',
  })
}

test('gate executes the real publication policy and exports a source/digest-bound handoff', (t) => {
  const { directory, env } = fixture(t)
  const result = execute(env)
  assert.equal(result.status, 0, result.stderr)
  const receipt = JSON.parse(readFileSync(join(directory, 'qualification.json'), 'utf8'))
  assert.equal(receipt.sourceSha, env.SOURCE_SHA)
  assert.equal(receipt.digest, `sha256:${env.CANDIDATE_SHA256}`)
  assert.equal(receipt.run_attempt, '2')
  assert.equal(receipt.run_id, '123')
  assert.deepEqual(receipt.qualification.nodes, ['24', '26'])
  assert.match(
    readFileSync(env.GITHUB_OUTPUT, 'utf8'),
    /candidate-artifact=qualification-candidate-123-2\n/
  )
})

const mutations = {
  incomplete: (report) => {
    report.complete = false
  },
  unlinted: (report) => {
    report.actionlint = false
  },
  stale: (report) => {
    report.source_sha = 'b'.repeat(40)
  },
  'different archive': (report) => {
    report.artifact_sha256 = 'b'.repeat(64)
  },
  'skipped fixture': (report) => {
    report.fixtures[0].status = 'skipped'
  },
  'missing fixture': (report) => {
    report.fixtures.pop()
  },
  'duplicate node': (report) => {
    report.node = 'v20.0.0'
  },
}
for (const [name, mutate] of Object.entries(mutations)) {
  test(`gate refuses ${name} evidence before exporting eligibility`, (t) => {
    const { directory, env } = fixture(t)
    const path = join(directory, 'reports/24/report.json')
    const report = JSON.parse(readFileSync(path, 'utf8'))
    mutate(report)
    writeFileSync(path, JSON.stringify(report))
    assert.notEqual(execute(env).status, 0)
    assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), '')
  })
}

test('gate refuses missing evidence', (t) => {
  const { directory, env } = fixture(t)
  rmSync(join(directory, 'reports/24/report.json'))
  assert.notEqual(execute(env).status, 0)
  assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), '')
})

test('gate compares the verified digest with the pack job output', (t) => {
  const { env } = fixture(t)
  env.CANDIDATE_SHA256 = 'b'.repeat(64)
  assert.notEqual(execute(env).status, 0)
  assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), '')
})

for (const [name, overrides, status] of [
  ['complete current attempt', {}, 0],
  ['failed pack', { PACK_RESULT: 'failure' }, 1],
  ['skipped qualification', { QUALIFY_RESULT: 'skipped' }, 1],
  ['cancelled qualification', { QUALIFY_RESULT: 'cancelled' }, 1],
  ['mixed attempts', { PACK_ATTEMPT: '1' }, 1],
]) {
  test(`workflow guard rejects unsafe handoff: ${name}`, () => {
    const result = spawnSync('bash', ['-c', guard], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PACK_RESULT: 'success',
        QUALIFY_RESULT: 'success',
        PACK_ATTEMPT: '2',
        GITHUB_RUN_ATTEMPT: '2',
        ...overrides,
      },
    })
    assert.equal(result.status, status, result.stderr)
  })
}

test('only the gate exports eligibility and a failed matrix cannot skip it', () => {
  assert.match(
    workflow,
    /source-sha:\n\s+description:.*\n\s+value: \$\{\{ jobs\.gate\.outputs\.source-sha \}\}/
  )
  assert.match(workflow, /needs: \[pack, qualify\]/)
  assert.match(workflow, /always\(\) && !cancelled\(\)/)
  assert.doesNotMatch(workflow, /secrets:|id-token: write|contents: write/)
})
