import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(
  new URL('../.github/workflows/consumer-qualification.yml', import.meta.url),
  'utf8'
)

test('every matrix member consumes the one archive produced in the current workflow run', () => {
  assert.equal([...workflow.matchAll(/npm pack /g)].length, 1)
  assert.match(
    workflow,
    /^  pack:\n    name: Pack candidate once\n    if: vars\.CI_BILLING_PAUSED != 'true' \|\| inputs\['billing-pause-bypass'\] == true$/m
  )
  const qualify = workflow.slice(workflow.indexOf('\n  qualify:'))
  assert.match(qualify, /needs: pack/)
  assert.match(
    qualify,
    /if: vars\.CI_BILLING_PAUSED != 'true' \|\| inputs\['billing-pause-bypass'\] == true/
  )
  assert.doesNotMatch(qualify, /npm pack /)
  assert.match(qualify, /needs\.pack\.outputs\.filename/)
  assert.match(qualify, /gh run download "\$GITHUB_RUN_ID"/)
  assert.match(qualify, /qualification-candidate-\$GITHUB_RUN_ID/)
  assert.match(workflow, /name: qualification-candidate-\$\{\{ github\.run_id \}\}/)
  assert.match(workflow, /overwrite: true/)
  assert.match(qualify, /consumer-qualification-\$\{\{ github\.run_attempt \}\}-node-/)
  assert.match(workflow, /actions: read/)
})

test('publication depends on qualification and reduced permissions admit artifact reads', () => {
  const release = readFileSync(
    new URL('../.github/workflows/release_self-ci.yml', import.meta.url),
    'utf8'
  )
  assert.match(release, /needs: qualification/)
  const qualification = release.slice(
    release.indexOf('\n  qualification:'),
    release.indexOf('\n  release:')
  )
  assert.match(
    qualification,
    /with:\n\s+billing-pause-bypass: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\['release-while-paused'\] == true \}\}/
  )
  assert.match(qualification, /actions: read/)
  assert.match(qualification, /contents: read/)
  assert.doesNotMatch(qualification, /secrets:/)
})
