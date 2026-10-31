import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { neutralizeClosingReferences } from '../src/lib/release-policy.mjs'

const cli = new URL('../src/cli.mjs', import.meta.url).pathname
const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')

test('release please footer references no longer close issues', () => {
  const line =
    '* **control-api:** bound list reads ([#1535](https://github.com/o/r/issues/1535)) ([09138e5](https://github.com/o/r/commit/09138e5)), closes [#187](https://github.com/o/r/issues/187)'
  assert.equal(neutralizeClosingReferences(line), line.replace(', closes [#187]', ', refs [#187]'))
})

test('every GitHub closing keyword form is neutralized', () => {
  for (const word of [
    'close',
    'Closes',
    'closed',
    'FIX',
    'fixes',
    'fixed',
    'resolve',
    'resolves',
    'Resolved',
  ]) {
    assert.equal(neutralizeClosingReferences(`${word} #12`), 'refs #12')
    assert.equal(neutralizeClosingReferences(`${word}: #12`), 'refs: #12')
    assert.equal(neutralizeClosingReferences(`${word} owner/repo#12`), 'refs owner/repo#12')
    assert.equal(
      neutralizeClosingReferences(`${word} https://github.com/o/r/issues/12`),
      'refs https://github.com/o/r/issues/12'
    )
  }
})

test('text without a closing reference is unchanged', () => {
  const text =
    '* **bootstrap:** bound each resource close so shutdown ends ([#1515](u)), fixes the hang\nprefix#12 enclosed #3'
  assert.equal(neutralizeClosingReferences(text), text)
})

test('the CLI scrubs stdin to stdout', () => {
  const result = spawnSync(process.execPath, [cli, 'release', 'scrub-pr-body'], {
    input: 'Fixes #4 and closes [#5](u)\n',
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'refs #4 and refs [#5](u)\n')
})

test('the release job scrubs generated release PR bodies before readiness and merge', () => {
  const scrub = workflow.indexOf('- name: Neutralize closing keywords in generated release PRs')
  assert.ok(scrub > workflow.indexOf('- name: Normalize Release Please outputs'))
  assert.ok(scrub < workflow.indexOf('- name: Normalize generated release PR draft state'))
  assert.ok(scrub < workflow.indexOf('- name: Merge generated version pull requests'))
  assert.match(workflow, /release scrub-pr-body < "\$body" > "\$body\.scrubbed"/)
})
