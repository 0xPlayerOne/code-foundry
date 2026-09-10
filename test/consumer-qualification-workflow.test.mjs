import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(
  new URL('../.github/workflows/consumer-qualification.yml', import.meta.url),
  'utf8'
)

test('every matrix member consumes one immutable archive from the current run attempt', () => {
  assert.equal([...workflow.matchAll(/npm pack /g)].length, 1)
  assert.match(
    workflow,
    /name: qualification-candidate-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/
  )
  assert.doesNotMatch(workflow, /overwrite: true/)
  const qualify = workflow.slice(workflow.indexOf('\n  qualify:'))
  assert.match(qualify, /needs: pack/)
  assert.match(qualify, /needs\.pack\.outputs\.filename/)
  assert.match(qualify, /gh run download "\$GITHUB_RUN_ID"/)
  assert.match(qualify, /qualification-candidate-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/)
  assert.match(qualify, /consumer-qualification-\$\{\{ github\.run_attempt \}\}-node-/)
  assert.match(qualify, /test "\$PACK_ATTEMPT" = "\$GITHUB_RUN_ATTEMPT"/)
  assert.match(qualify, /test "\$\(sha256sum .*\)" = "\$CANDIDATE_SHA256"/)
})

test('publication depends on qualification and reduced permissions admit artifact reads', () => {
  const release = readFileSync(
    new URL('../.github/workflows/release_self-ci.yml', import.meta.url),
    'utf8'
  )
  assert.match(release, /needs: qualification|needs: \[[^\]]*qualification/)
  const qualification = release.slice(
    release.indexOf('\n  qualification:'),
    release.indexOf('\n  release:')
  )
  assert.match(
    qualification,
    /billing-pause-bypass: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\['release-while-paused'\] == true \}\}/
  )
  assert.match(qualification, /actions: read/)
  assert.match(qualification, /contents: read/)
  assert.doesNotMatch(qualification, /secrets:/)
})

test('qualification runs only when a release or a stuck draft needs it', () => {
  const caller = readFileSync(
    new URL('../.github/workflows/release_self-ci.yml', import.meta.url),
    'utf8'
  )
  const qualification = caller.slice(
    caller.indexOf('\n  qualification:'),
    caller.indexOf('\n  preflight:')
  )
  // Feature merges only pay for the cheap release-please and recovery
  // probes; the matrix runs when this push created a release or recovery
  // found a stuck draft.
  assert.match(qualification, /needs: \[release, recovery\]/)
  assert.match(
    qualification,
    /needs\.release\.outputs\.release_created == 'true' \|\| needs\.recovery\.outputs\.found == 'true'/
  )
  // Release Please consumes no qualification outputs, so it runs first.
  const release = caller.slice(caller.indexOf('\n  release:'), caller.indexOf('\n  recovery:'))
  assert.match(release, /needs: \[preflight\]/)
  assert.doesNotMatch(release, /needs: \[qualification/)
  // Recovery computes its own source SHA instead of depending on
  // qualification; the stage still requires qualification success.
  const recovery = caller.slice(caller.indexOf('\n  recovery:'), caller.indexOf('\n  stage:'))
  assert.match(recovery, /needs: \[release\]/)
  assert.doesNotMatch(recovery, /needs\.qualification/)
  assert.match(recovery, /SOURCE_SHA: \$\{\{ github\.sha \}\}/)
  const stage = caller.slice(caller.indexOf('\n  stage:'), caller.indexOf('\n  publish:'))
  assert.match(stage, /needs\.qualification\.result == 'success'/)
})
