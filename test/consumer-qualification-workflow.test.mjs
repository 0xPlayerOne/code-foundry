import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(
  new URL('../.github/workflows/consumer-qualification.yml', import.meta.url),
  'utf8'
)

test('every matrix member consumes one immutable archive from the current run attempt', () => {
  assert.equal([...workflow.matchAll(/npm pack /g)].length, 1)
  assert.match(workflow, /name: qualification-candidate-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/)
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
  assert.match(qualification, /billing-pause-bypass: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\['release-while-paused'\] == true \}\}/)
  assert.match(qualification, /actions: read/)
  assert.match(qualification, /contents: read/)
  assert.doesNotMatch(qualification, /secrets:/)
})
