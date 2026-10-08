import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
const step = workflow.slice(
  workflow.indexOf('- name: Normalize generated release PR draft state'),
  workflow.indexOf('- name: Leave release pull request for manual merge')
)
const script = step
  .split('        run: |\n')[1]
  .split('\n')
  .map((line) => line.slice(10))
  .join('\n')
const head = 'a'.repeat(40)
const branch = 'release-please--branches--main'
const repository = 'owner/repo'
const run = (status, conclusion) => ({
  id: 123,
  run_attempt: 1,
  head_sha: head,
  head_branch: branch,
  event: 'pull_request',
  path: '.github/workflows/validation.yml',
  repository: { full_name: repository },
  status,
  conclusion,
})
function execute(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'foundry-readiness-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'state.json')
  writeFileSync(
    file,
    JSON.stringify({
      draft: false,
      head,
      branch,
      views: 0,
      cancellations: 0,
      allocations: 0,
      calls: [],
      runs: [run('queued', null)],
      ...options,
    })
  )
  const fake = `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2); const file = process.env.FIXTURE_STATE; const state = JSON.parse(fs.readFileSync(file));
state.calls.push(args);
const save = () => fs.writeFileSync(file, JSON.stringify(state));
if (args[0] === 'pr' && args[1] === 'list') { console.log('17'); save(); }
else if (args[0] === 'pr' && args[1] === 'view') {
  state.views += 1;
  if (state.views > 1 && state.changeHead) state.head = 'b'.repeat(40);
  const json = args[args.indexOf('--json') + 1];
  if (json === 'isDraft') console.log(state.draft);
  else console.log([state.draft, state.head, state.branch].join('\\t'));
  save();
} else if (args[0] === 'api') {
  state.apiUsedReadToken = process.env.GH_TOKEN === 'workflow-test-token';
  save(); if (state.apiFailure) { console.error('lookup unavailable'); process.exit(1); }
  console.log(JSON.stringify(state.malformed ? {} : { workflow_runs: state.runs, total_count: state.responseCount ?? state.runs.length }));
} else if (args[0] === 'pr' && args[1] === 'ready') {
  if (args.includes('--undo')) { state.draft = true; state.cancellations += 1; }
  else { state.draft = false; state.allocations += 1; }
  save();
} else { save(); console.error('Unexpected fake gh operation'); process.exit(2); }
`
  writeFileSync(join(directory, 'gh'), fake, { mode: 0o700 })
  // macOS ships Bash 3; this test-only bridge implements the single mapfile form
  // used by the unchanged Ubuntu step. The production script runs verbatim below.
  const bridge = `if ! type mapfile >/dev/null 2>&1; then
mapfile() { [ "$1" = -t ] && [ "$2" = release_prs ] || return 2; release_prs=(); while IFS= read -r entry; do release_prs+=("$entry"); done; }
fi
`
  const result = spawnSync('bash', ['-c', bridge + script], {
    encoding: 'utf8',
    timeout: 3000,
    env: {
      PATH: directory + ':' + process.env.PATH,
      FIXTURE_STATE: file,
      GITHUB_REPOSITORY: repository,
      AUTO_MERGE: 'true',
      GH_TOKEN: 'configured-test-token',
      VALIDATION_TOKEN: 'workflow-test-token',
      ...options.env,
    },
  })
  assert.equal(result.error, undefined)
  return { ...result, state: JSON.parse(readFileSync(file, 'utf8')) }
}
test('unchanged ready release preserves its queued current-head validation', (t) => {
  const result = execute(t)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.state.draft, false)
  assert.equal(result.state.cancellations, 0)
  assert.equal(result.state.allocations, 0)
})
test('failed current-head qualification stays failed without another allocation or auto-merge step', (t) => {
  const result = execute(t, { runs: [run('completed', 'failure')] })
  assert.notEqual(result.status, 0)
  assert.equal(result.state.draft, false)
  assert.equal(result.state.cancellations, 0)
  assert.equal(result.state.allocations, 0)
})

for (const [name, owner] of [
  ['running', run('in_progress', null)],
  ['waiting', run('waiting', null)],
  ['completed successfully', run('completed', 'success')],
])
  test(`ready release preserves ${name} current-head validation`, (t) => {
    const result = execute(t, { runs: [owner] })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.state.cancellations, 0)
    assert.equal(result.state.allocations, 0)
    assert.equal(result.state.apiUsedReadToken, true)
  })
for (const [name, runs] of [
  ['missing', []],
  ['cancelled', [run('completed', 'cancelled')]],
  ['skipped', [run('completed', 'skipped')]],
  ['previous head', [{ ...run('queued', null), head_sha: 'b'.repeat(40) }]],
  ['other branch', [{ ...run('queued', null), head_branch: 'topic' }]],
  ['other repository', [{ ...run('queued', null), repository: { full_name: 'elsewhere/repo' } }]],
  ['main push', [{ ...run('queued', null), event: 'push' }]],
  [
    'lightweight policy workflow',
    [{ ...run('queued', null), path: '.github/workflows/review-policy.yml' }],
  ],
  [
    'latest cancelled despite older success',
    [{ ...run('completed', 'cancelled'), id: 124 }, run('completed', 'success')],
  ],
])
  test(`ready release requests validation when its owner is ${name}`, (t) => {
    const result = execute(t, { runs })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.state.draft, false)
    assert.equal(result.state.cancellations, 1)
    assert.equal(result.state.allocations, 1)
  })
test('a new draft receives its first readiness transition without an ownership lookup', (t) => {
  const result = execute(t, { draft: true })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.state.draft, false)
  assert.equal(result.state.cancellations, 0)
  assert.equal(result.state.allocations, 1)
  assert.equal(result.state.apiUsedReadToken, undefined)
})
test('invalid automation credential fallback keeps a ready release in draft', (t) => {
  const result = execute(t, { env: { AUTO_MERGE: 'false' } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.state.draft, true)
  assert.equal(result.state.cancellations, 1)
  assert.equal(result.state.allocations, 0)
  assert.equal(result.state.apiUsedReadToken, undefined)
})
for (const options of [{ apiFailure: true }, { malformed: true }, { changeHead: true }])
  test(`unconfirmed owner or changed PR state causes no readiness mutation: ${JSON.stringify(options)}`, (t) => {
    const result = execute(t, options)
    assert.notEqual(result.status, 0)
    assert.equal(result.state.cancellations, 0)
    assert.equal(result.state.allocations, 0)
  })
test('the newest current-head owner supersedes an older cancelled run', (t) => {
  const result = execute(t, {
    runs: [run('completed', 'cancelled'), { ...run('queued', null), id: 124 }],
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.state.cancellations, 0)
  assert.equal(result.state.allocations, 0)
})
for (const conclusion of ['timed_out', 'action_required'])
  test(`terminal ${conclusion} qualification blocks subsequent release steps`, (t) => {
    const result = execute(t, { runs: [run('completed', conclusion)] })
    assert.notEqual(result.status, 0)
    assert.equal(result.state.cancellations, 0)
    assert.equal(result.state.allocations, 0)
  })

test('a branch that changed outside the generated release namespace is not mutated', (t) => {
  const result = execute(t, { branch: 'ordinary-topic' })
  assert.notEqual(result.status, 0)
  assert.equal(result.state.cancellations, 0)
  assert.equal(result.state.allocations, 0)
})
test('an older live run cannot mask a newer failed qualification', (t) => {
  const result = execute(t, {
    runs: [run('in_progress', null), { ...run('completed', 'failure'), id: 124 }],
  })
  assert.notEqual(result.status, 0)
  assert.equal(result.state.cancellations, 0)
  assert.equal(result.state.allocations, 0)
})

for (const [name, owner] of [
  ['missing branch', { ...run('queued', null), head_branch: undefined }],
  ['malformed head', { ...run('queued', null), head_sha: 123 }],
  ['missing repository', { ...run('queued', null), repository: undefined }],
  ['missing workflow path', { ...run('queued', null), path: undefined }],
  ['non-object entry', null],
  ['fractional run identity', { ...run('queued', null), id: 123.5 }],
  ['unknown run state', { ...run('queued', null), status: 'unknown' }],
  ['missing active conclusion', { ...run('queued', null), conclusion: undefined }],
  ['invalid active conclusion', { ...run('queued', null), conclusion: 'failure' }],
])
  test(`malformed ownership entry fails before readiness writes: ${name}`, (t) => {
    const result = execute(t, { runs: [owner] })
    assert.notEqual(result.status, 0)
    assert.equal(result.state.cancellations, 0)
    assert.equal(result.state.allocations, 0)
  })
test('an incomplete Actions page cannot prove that validation is missing', (t) => {
  const result = execute(t, { runs: [], responseCount: 101 })
  assert.notEqual(result.status, 0)
  assert.equal(result.state.cancellations, 0)
  assert.equal(result.state.allocations, 0)
})

for (const [name, path] of [
  ['workflow ref suffix', '.github/workflows/validation.yml@main'],
  ['self-CI caller', '.github/workflows/validation_self-ci.yml'],
])
  test(`ready release preserves ${name} current-head validation`, (t) => {
    const result = execute(t, { runs: [{ ...run('queued', null), path }] })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.state.cancellations, 0)
    assert.equal(result.state.allocations, 0)
  })
