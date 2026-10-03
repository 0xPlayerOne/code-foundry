import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

const PR_ONLY_CANCEL = "${{ github.event_name == 'pull_request' }}"

/** @param {string} path */
function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

/** @param {string} source */
function concurrencyBlocks(source) {
  return [
    ...source.matchAll(
      /^( *)concurrency:\n\1  group: (.+)\n(?:\1  #.*\n)*\1  cancel-in-progress: (.+)$/gm
    ),
  ].map((match) => ({ topLevel: match[1] === '', group: match[2], cancel: match[3] }))
}

/** @param {string} path */
function topLevelConcurrency(path) {
  const blocks = concurrencyBlocks(read(path)).filter(({ topLevel }) => topLevel)
  assert.equal(blocks.length, 1, `${path} must declare one top-level concurrency group`)
  return blocks[0]
}

test('pull-request callers own one group per pull request and cancel superseded runs', () => {
  for (const path of [
    '.github/workflows/validation_self-ci.yml',
    '.github/workflows/opencode-security_self-ci.yml',
    '.github/workflows/draft-control_self-ci.yml',
    '.github/workflows/draft-enforcement_self-ci.yml',
    '.github/workflows/consumer-qualification_self-ci.yml',
  ]) {
    const { group, cancel } = topLevelConcurrency(path)
    assert.match(group, /github\.event\.pull_request\.(number|head\.ref)/, path)
    assert.ok(cancel === 'true' || cancel === PR_ONLY_CANCEL, `${path}: ${cancel}`)
  }
})

test('callers that also run on push or dispatch cancel only pull-request runs', () => {
  for (const path of [
    '.github/workflows/validation_self-ci.yml',
    '.github/workflows/opencode-security_self-ci.yml',
  ]) {
    assert.equal(topLevelConcurrency(path).cancel, PR_ONLY_CANCEL, path)
  }
})

test('reusable validation lanes never cancel a superseded main push', () => {
  for (const name of ['ci', 'test', 'security', 'codeql', 'eval']) {
    const path = `.github/workflows/${name}.yml`
    const { group, cancel } = topLevelConcurrency(path)
    assert.match(group, /github\.event_name/, path)
    assert.equal(cancel, PR_ONLY_CANCEL, path)
  }
})

test('release, promotion, publication, and deployment groups never cancel in progress', () => {
  for (const path of [
    '.github/workflows/release.yml',
    '.github/workflows/release_self-ci.yml',
    '.github/workflows/release-pr.yml',
    '.github/workflows/qualified-foundry-publish.yml',
    '.github/workflows/cloudflare-delivery.yml',
    '.github/workflows/cloudflare-deploy.yml',
  ]) {
    const blocks = concurrencyBlocks(read(path))
    assert.ok(blocks.length > 0, `${path} must serialize with a concurrency group`)
    for (const { cancel } of blocks) assert.equal(cancel, 'false', path)
  }
})

test('every literal cancel-in-progress: true belongs to a workflow that cannot run on main pushes', () => {
  const allowed = new Set([
    // pull_request / pull_request_target only
    'consumer-qualification_self-ci.yml',
    'draft-control_self-ci.yml',
    'draft-enforcement_self-ci.yml',
    // push to topic branches only (feat/*, fix/*, ...)
    'draft-pr.yml',
    // schedule and workflow_dispatch audits
    'validation_audit_self-ci.yml',
  ])
  const directory = new URL('../.github/workflows/', import.meta.url)
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.yml'))) {
    const literal = concurrencyBlocks(readFileSync(new URL(file, directory), 'utf8')).some(
      ({ cancel }) => cancel === 'true'
    )
    if (literal) assert.ok(allowed.has(file), `${file} cancels unconditionally`)
  }
  const draftPrCaller = read('.github/workflows/draft-pr_self-ci.yml')
  assert.doesNotMatch(draftPrCaller.slice(0, draftPrCaller.indexOf('\njobs:')), /- main\b|\[main/)
})
