import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORKFLOW = '.github/workflows/draft-enforcement_self-ci.yml'

const guardScript = () =>
  readFileSync(WORKFLOW, 'utf8')
    .split('        run: |\n')[1]
    .split('\n')
    .map((line) => line.replace(/^          /, ''))
    .join('\n')

// A fake gh that serves the pull-request lookup, the timeline lookup and the
// draft mutation from environment fixtures, and logs every call.
const FAKE_GH = `#!/bin/bash
printf '%s\\n' "$*" >> "$GH_LOG"
case "$*" in
  *graphql*) printf '%s\\ttrue\\n' "$FAKE_NODE_ID" ;;
  *"/timeline"*) printf '%s' "$FAKE_READY_EVENTS" ;;
  *"/pulls/"*) printf '%s\\n' "$FAKE_PR_TSV" ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`

const runGuard = ({ eventDraft, current, readyEvents = '' }) => {
  const root = mkdtempSync(join(tmpdir(), 'foundry-draft-guard-'))
  try {
    const log = join(root, 'gh.log')
    writeFileSync(join(root, 'gh'), FAKE_GH, { mode: 0o755 })
    const result = spawnSync('bash', ['-c', guardScript()], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        GH_LOG: log,
        GITHUB_REPOSITORY: 'example/repo',
        PR_NUMBER: '1572',
        EVENT_DRAFT: eventDraft,
        EVENT_HEAD_SHA: 'abc123',
        EVENT_UPDATED_AT: '2026-10-31T14:37:26Z',
        FAKE_NODE_ID: 'PR_node',
        FAKE_PR_TSV: [current.draft, 'feature/x', 'abc123', current.updatedAt, 'PR_node'].join(
          '\t'
        ),
        FAKE_READY_EVENTS: readyEvents,
      },
    })
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
    return { ...result, calls }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const converted = (calls) => calls.some((call) => call.includes('convertPullRequestToDraft'))

test('draft guard grants the push permission GitHub requires for draft mutations', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8')
  const header = workflow.slice(0, workflow.indexOf('\njobs:'))
  assert.match(header, /permissions:\n {2}contents: write\n {2}pull-requests: write\n/)
  assert.doesNotMatch(workflow, /actions\/checkout/)
  assert.match(workflow, /EVENT_DRAFT: \$\{\{ github\.event\.pull_request\.draft \}\}/)
})

test('a PR created as a draft and readied in the same second is left ready', () => {
  // control-plane #1572: created as a draft at 14:37:24Z, marked ready about
  // two seconds later, and the event updated_at matched the current one.
  const result = runGuard({
    eventDraft: 'true',
    current: { draft: 'false', updatedAt: '2026-10-31T14:37:26Z' },
    readyEvents: '2026-10-31T14:37:26Z\n',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /deliberate ready_for_review/)
  assert.equal(converted(result.calls), false)
})

test('a ready_for_review at or after the event supersedes it', () => {
  for (const readyAt of ['2026-10-31T14:37:26Z', '2026-10-31T14:37:27Z']) {
    const result = runGuard({
      eventDraft: 'false',
      current: { draft: 'false', updatedAt: '2026-10-31T14:37:26Z' },
      readyEvents: `2026-10-30T09:00:00Z\n${readyAt}\n`,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /superseding this 2026-10-31T14:37:26Z event/)
    assert.equal(converted(result.calls), false)
  }
})

test('an ordinary PR opened ready is still converted to draft', () => {
  const result = runGuard({
    eventDraft: 'false',
    current: { draft: 'false', updatedAt: '2026-10-31T14:37:26Z' },
    readyEvents: '2026-10-30T09:00:00Z\n',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Converted ordinary pull request #1572 to draft/)
  assert.equal(converted(result.calls), true)
})

test('a missing or malformed event draft value fails before calling GitHub', () => {
  for (const eventDraft of ['', 'yes']) {
    const result = runGuard({
      eventDraft,
      current: { draft: 'false', updatedAt: '2026-10-31T14:37:26Z' },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stdout, /Draft guard cannot verify event state/)
    assert.deepEqual(result.calls, [])
  }
})
