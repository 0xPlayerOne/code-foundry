import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'

import { renderPromoteStable, syncRepository } from '../src/commands/sync.mjs'

const source = process.cwd()

/** @param {Record<string, string>} extraConfig @returns {string} */
function consumerFixture(extraConfig = {}) {
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-release-batching-'))
  mkdirSync(join(root, '.github'), { recursive: true })
  writeFileSync(
    join(root, '.github/code-foundry.yml'),
    `languages: typescript\npackage_manager: bun\nfeatures: release\n${Object.entries(extraConfig)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n')}\n`
  )
  return root
}

/** @param {Record<string, string>} extraConfig @returns {string} */
function syncConsumer(extraConfig = {}) {
  const root = consumerFixture(extraConfig)
  syncRepository({ target: root, source })
  return root
}

test('the release caller renders the classic per-merge form without batching config', () => {
  const root = syncConsumer()
  const caller = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')
  assert.doesNotMatch(caller, /  schedule:/)
  assert.doesNotMatch(caller, /mark-prerelease/)
  assert.doesNotMatch(caller, /chore\(main\): release /)
  assert.match(
    caller,
    /if: vars\.CI_BILLING_PAUSED != 'true' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\['release-while-paused'\] == true\)/
  )
  assert.ok(!existsSync(join(root, '.github/workflows/promote-stable.yml')))
  rmSync(root, { recursive: true, force: true })
})

test('a batching schedule gates the pipeline and stages window releases', () => {
  const root = syncConsumer({ release_batching_schedule: '23 12 * * *' })
  const caller = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')
  assert.match(caller, /schedule:\n    - cron: '23 12 \* \* \*'/)
  assert.match(
    caller,
    /&& \(github\.event_name != 'push' \|\| startsWith\(github\.event\.head_commit\.message, 'chore\(main\): release '\)\)/
  )
  assert.doesNotMatch(caller, /mark-prerelease/)
  assert.match(caller, /prerelease: \$\{\{ github.event_name != 'workflow_dispatch' \}\}/)
  assert.ok(!existsSync(join(root, '.github/workflows/promote-stable.yml')))
  rmSync(root, { recursive: true, force: true })
})

test('a malformed batching schedule fails the sync loudly', () => {
  assert.throws(
    () => syncConsumer({ release_batching_schedule: 'every morning' }),
    /Unsupported release_batching_schedule/
  )
})

test('soak hours render the batch-soak promoter and rerunning sync removes it', () => {
  const root = syncConsumer({
    release_batching_schedule: '23 12 * * *',
    release_batching_soak_hours: '96',
  })
  const promoter = readFileSync(join(root, '.github/workflows/promote-stable.yml'), 'utf8')
  assert.match(promoter, /SOAK_HOURS: '96'/)
  assert.match(promoter, /name: Promote stable/)
  assert.match(promoter, /STABLE_PROMOTION_HELD/)
  assert.match(promoter, /\.prerelease == true\)/)
  assert.match(promoter, /\.published_at > \$last_stable_published/)
  assert.match(promoter, /sort_by\(.published_at\)/)
  assert.doesNotMatch(promoter, /__SOAK_HOURS__/)

  // Dropping the key removes the generated promoter on the next sync.
  writeFileSync(
    join(root, '.github/code-foundry.yml'),
    'languages: typescript\npackage_manager: bun\nfeatures: release\nrelease_batching_schedule: "23 12 * * *"\n'
  )
  syncRepository({ target: root, source })
  assert.ok(!existsSync(join(root, '.github/workflows/promote-stable.yml')))
  rmSync(root, { recursive: true, force: true })
})

test('the promoter rejects soak hours outside the supported range', () => {
  assert.equal(renderPromoteStable({ release_batching_soak_hours: '0' }), null)
  assert.equal(renderPromoteStable({ release_batching_soak_hours: '337' }), null)
  assert.equal(renderPromoteStable({}), null)
  assert.match(renderPromoteStable({ release_batching_soak_hours: '96' }), /SOAK_HOURS: '96'/)
})

test('ordinary unpaused pushes are excluded from the batched release gate', () => {
  const root = syncConsumer({ release_batching_schedule: '23 12 * * *' })
  try {
    const caller = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')
    const condition = caller.match(/    if: >-\n      (.*)/)[1]
    const evaluate = (event, paused, message = 'fix: normal change', bypass = false) => {
      const expression = condition
        .replaceAll('vars.CI_BILLING_PAUSED', JSON.stringify(String(paused)))
        .replaceAll('github.event_name', JSON.stringify(event))
        .replaceAll("inputs['release-while-paused']", String(bypass))
        .replaceAll('github.event.head_commit.message', JSON.stringify(message))
      return Function(
        'startsWith',
        'return ' + expression
      )((value, prefix) => value.startsWith(prefix))
    }
    assert.equal(evaluate('push', false), false)
    assert.equal(evaluate('push', false, 'chore(main): release 1.2.3'), true)
    assert.equal(evaluate('schedule', false), true)
    assert.equal(evaluate('schedule', true), false)
    assert.equal(evaluate('workflow_dispatch', true, '', true), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('batching stages releases as drafts and delegates atomic visibility to the reusable producer', () => {
  const root = syncConsumer({ release_batching_schedule: '23 12 * * *' })
  try {
    const config = JSON.parse(readFileSync(join(root, 'release-please-config.json'), 'utf8'))
    assert.equal(config.draft, true)
    assert.equal(config['force-tag-creation'], true)
    const caller = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')
    assert.doesNotMatch(caller, /mark-prerelease/)
    assert.match(caller, /prerelease: \$\{\{ github.event_name != 'workflow_dispatch' \}\}/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Execute the generated shell with only its external API and clock replaced.
// jq, bash, filtering and note stitching are the real workflow implementation.
function runPromotion({
  releases,
  held = false,
  force = false,
  version = '',
  qualification = '',
  conclusion = 'missing',
  apiFailure = false,
}) {
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-promotion-'))
  try {
    const workflow = renderPromoteStable({
      release_batching_soak_hours: '96',
      release_batching_qualification_workflow: qualification,
    })
    const script = workflow
      .split('        run: |\n')[1]
      .split('\n')
      .map((line) => line.slice(10))
      .join('\n')
    writeFileSync(join(root, 'releases.json'), JSON.stringify([releases]))
    writeFileSync(
      join(root, 'gh'),
      `#!/bin/sh
if [ "$1" = api ]; then
  [ "$API_FAILURE" = true ] && exit 1
  case "$*" in *commits*) printf '%s\\n' 'qualified-source-sha';; *--slurp*) cat "$FIXTURE/releases.json";; *) jq 'add' "$FIXTURE/releases.json";; esac
elif [ "$1" = run ]; then printf '%s\\n' "$CONCLUSION"; printf '%s\\n' "$*" >> "$FIXTURE/qualification-calls"
else printf '%s\\n' "$*" >> "$FIXTURE/edits"; fi
`,
      { mode: 0o755 }
    )
    writeFileSync(
      join(root, 'date'),
      `#!/usr/bin/env node
console.log(process.argv[2] === '-d' ? Date.parse(process.argv[3]) / 1000 : Date.parse('2026-10-03T12:00:00Z') / 1000)
`,
      { mode: 0o755 }
    )
    const result = spawnSync('bash', ['-c', script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: root + ':' + process.env.PATH,
        FIXTURE: root,
        GITHUB_REPOSITORY: 'example/app',
        GITHUB_STEP_SUMMARY: join(root, 'summary'),
        SOAK_HOURS: '96',
        QUALIFICATION_WORKFLOW: qualification,
        CONCLUSION: conclusion,
        API_FAILURE: String(apiFailure),
        STABLE_PROMOTION_HELD: String(held),
        FORCE: String(force),
        VERSION: version,
        HOLD: '',
      },
    })
    return {
      ...result,
      qualificationCalls: existsSync(join(root, 'qualification-calls'))
        ? readFileSync(join(root, 'qualification-calls'), 'utf8')
        : '',
      edits: existsSync(join(root, 'edits')) ? readFileSync(join(root, 'edits'), 'utf8') : '',
      notes: existsSync(join(root, 'batch-notes.md'))
        ? readFileSync(join(root, 'batch-notes.md'), 'utf8')
        : '',
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const release = (tag, published, prerelease = true) => ({
  tag_name: tag,
  published_at: published,
  prerelease,
  draft: false,
  body: tag + ' notes',
})

test('promotion stitches only candidates newer than stable and excludes dev releases', () => {
  const result = runPromotion({
    releases: [
      release('v1.4.0', '2026-10-03T09:00:00Z'),
      release('v1.3.0', '2026-09-28T09:00:00Z'),
      release('v1.2.0', '2026-09-27T09:00:00Z', false),
      release('v1.1.0', '2026-09-26T09:00:00Z'),
      release('v1.5.0-dev.1', '2026-10-03T10:00:00Z'),
    ],
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.edits, /release edit v1.4.0/)
  assert.match(result.notes, /v1.3.0 notes/)
  assert.match(result.notes, /v1.4.0 notes/)
  assert.doesNotMatch(result.notes, /v1.1.0|v1.2.0|dev/)
})

test('scheduled and named promotions respect the hold unless forced', () => {
  for (const version of ['', '1.4.0']) {
    const result = runPromotion({
      held: true,
      version,
      releases: [release('v1.4.0', '2026-09-26T09:00:00Z')],
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.edits, '')
  }
})

test('a batch younger than the soak does not promote', () => {
  const result = runPromotion({ releases: [release('v1.4.0', '2026-10-03T09:00:00Z')] })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.edits, '')
})

test('malformed cron fields and invalid soak fail before any sync writes', () => {
  for (const config of [
    { release_batching_schedule: '23' },
    { release_batching_schedule: '99 25 * * *' },
    { release_batching_schedule: '23 12 * * *', release_batching_soak_hours: '0' },
  ]) {
    const root = consumerFixture(config)
    try {
      assert.throws(() => syncRepository({ target: root, source }), /Unsupported release_batching/)
      assert.ok(!existsSync(join(root, 'release-please-config.json')))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('disabling batching restores public releases without rewriting unrelated draft policy', () => {
  const root = syncConsumer({ release_batching_schedule: '23 12 * * *' })
  try {
    writeFileSync(
      join(root, '.github/code-foundry.yml'),
      'languages: typescript\nfeatures: release\ngit_workflow: direct\nmerge_strategy: squash\nrelease_merge_strategy: squash\n'
    )
    syncRepository({ target: root, source })
    const config = JSON.parse(readFileSync(join(root, 'release-please-config.json'), 'utf8'))
    assert.equal(config.draft, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('force can override the soak and hold and invalid named versions cannot edit releases', () => {
  const releases = [release('v1.4.0', '2026-10-03T09:00:00Z')]
  const forced = runPromotion({ releases, held: true, force: true })
  assert.equal(forced.status, 0, forced.stderr)
  assert.match(forced.edits, /release edit v1.4.0/)
  const invalid = runPromotion({ releases, version: '1.4.0-dev.1' })
  assert.notEqual(invalid.status, 0)
  assert.equal(invalid.edits, '')
})

test('the producer requires a private forced-tag draft before batched publication', () => {
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-batch-profile-'))
  try {
    mkdirSync(join(root, '.github'))
    writeFileSync(
      join(root, '.github/code-foundry.yml'),
      'release_type: node\nrelease_merge_strategy: squash\nrelease_batching_schedule: 23 12 * * *\n'
    )
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}')
    writeFileSync(join(root, '.release-please-manifest.json'), '{".":"1.0.0"}')
    const workflow = readFileSync(join(source, '.github/workflows/release.yml'), 'utf8')
    const script = workflow
      .split("          node <<'NODE'\n")[1]
      .split('\n          NODE')[0]
      .split('\n')
      .map((line) => line.slice(10))
      .join('\n')
    const env = {
      ...process.env,
      GITHUB_OUTPUT: join(root, 'output'),
      DEFER_PUBLICATION: 'false',
      RELEASE_CONFIG_FILE: 'release-please-config.json',
    }
    writeFileSync(
      join(root, 'release-please-config.json'),
      '{"packages":{".":{"release-type":"node"}}}'
    )
    const invalid = spawnSync('node', ['-e', script], { cwd: root, env, encoding: 'utf8' })
    assert.notEqual(invalid.status, 0)
    assert.match(invalid.stderr, /draft and force-tag-creation/)
    writeFileSync(
      join(root, 'release-please-config.json'),
      '{"packages":{".":{"release-type":"node","draft":true,"force-tag-creation":true}}}'
    )
    const valid = spawnSync('node', ['-e', script], { cwd: root, env, encoding: 'utf8' })
    assert.equal(valid.status, 0, valid.stderr)
    assert.match(readFileSync(join(root, 'output'), 'utf8'), /batched_publication=true/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the producer publishes a draft and its final visibility in one API update', () => {
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-batch-publish-'))
  try {
    const workflow = readFileSync(join(source, '.github/workflows/release.yml'), 'utf8')
    const block = workflow
      .split('      - name: Publish batched draft with atomic visibility\n')[1]
      .split('      - name:')[0]
    const script = block
      .split('        run: |\n')[1]
      .trimEnd()
      .split('\n')
      .map((line) => line.slice(10))
      .join('\n')
    writeFileSync(join(root, 'gh'), '#!/bin/sh\nprintf "%s\\n" "$*"\n', { mode: 0o755 })
    for (const prerelease of ['true', 'false']) {
      const result = spawnSync('bash', ['-c', script], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: root + ':' + process.env.PATH,
          PRERELEASE: prerelease,
          RELEASE_TAG: 'v1.2.3',
          GITHUB_REPOSITORY: 'example/app',
        },
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout.trim().split('\n').length, 1)
      assert.match(result.stdout, /--draft=false/)
      assert.match(result.stdout, new RegExp('--prerelease=' + prerelease))
      assert.match(
        result.stdout,
        new RegExp('--latest=' + (prerelease === 'true' ? 'false' : 'true'))
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('asset qualification holds soaked and forced batches until the exact candidate succeeds', () => {
  const releases = [release('v1.4.0', '2026-09-26T09:00:00Z')]
  for (const conclusion of ['failure', 'missing', 'cancelled', '']) {
    for (const version of ['', '1.4.0']) {
      const result = runPromotion({
        releases,
        qualification: 'release-assets.yml',
        conclusion,
        force: true,
        version,
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.edits, '')
    }
  }
  const unavailable = runPromotion({
    releases,
    qualification: 'release-assets.yml',
    apiFailure: true,
    version: '1.4.0',
  })
  assert.equal(unavailable.edits, '')
  const passed = runPromotion({
    releases,
    qualification: 'release-assets.yml',
    conclusion: 'success',
  })
  assert.equal(passed.status, 0, passed.stderr)
  assert.match(passed.edits, /release edit v1.4.0/)
  assert.match(passed.qualificationCalls, /--commit qualified-source-sha/)
  assert.match(passed.qualificationCalls, /--event release/)
})

test('asset workflow identity rejects path and shell injection before synchronization', () => {
  const root = consumerFixture({
    release_batching_schedule: '23 12 * * *',
    release_batching_soak_hours: '96',
    release_batching_qualification_workflow: '../release-assets.yml',
  })
  try {
    assert.throws(
      () => syncRepository({ target: root, source }),
      /Unsupported release_batching_qualification_workflow/
    )
    assert.ok(!existsSync(join(root, 'release-please-config.json')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the dev channel rides on the release caller and disappears when the key is gone', () => {
  const root = syncConsumer({
    release_batching_schedule: "'23 12 * * *'",
    release_batching_dev_channel: true,
    release_batching_dev_workflow: 'release-assets.yml',
  })
  const dev = readFileSync(join(root, '.github/workflows/dev-channel.yml'), 'utf8')
  assert.match(dev, /^# Generated by Code Foundry sync from release_batching_dev_channel/)
  assert.match(dev, /name: Publish dev channel/)
  assert.match(dev, /DEV_WORKFLOW: 'release-assets\.yml'/)
  assert.match(dev, /-dev\.\$\{GITHUB_RUN_NUMBER\}/, 'derives the tag from the run number')
  assert.match(
    dev,
    /gh workflow run "\$DEV_WORKFLOW" .* -f version="\$tag"/,
    'dispatches the app-provided asset lane'
  )
  assert.match(
    dev,
    /test\("\^v\[0-9\]\+\[\.\]\[0-9\]\+\[\.\]\[0-9\]\+-dev\[\.\]\[0-9\]\+\$"\)/,
    'prunes only dev-channel tags'
  )
  assert.match(
    dev,
    /vars\.CI_BILLING_PAUSED != 'true'/,
    'auto dev builds respect the billing pause'
  )
  assert.match(
    dev,
    /github\.event_name == 'workflow_dispatch'/,
    'the repair dispatch bypasses the pause'
  )
  rmSync(root, { recursive: true, force: true })

  const disabled = syncConsumer({
    release_batching_schedule: "'23 12 * * *'",
  })
  writeFileSync(join(disabled, '.github/workflows/dev-channel.yml'), 'stale: true\n')
  syncRepository({ target: disabled, source })
  assert.ok(
    !existsSync(join(disabled, '.github/workflows/dev-channel.yml')),
    'a disabled channel removes the generated workflow'
  )
  rmSync(disabled, { recursive: true, force: true })
})

test('the dev channel requires its asset lane and the lane requires the channel', () => {
  assert.throws(
    () => syncConsumer({ release_batching_dev_channel: true }),
    /Unsupported release_batching_dev_workflow/
  )
  assert.throws(
    () =>
      syncConsumer({
        release_batching_dev_channel: true,
        release_batching_dev_workflow: '../escape',
      }),
    /Unsupported release_batching_dev_workflow/
  )
  assert.throws(
    () => syncConsumer({ release_batching_dev_workflow: 'release-assets.yml' }),
    /Unsupported release_batching_dev_workflow: requires release_batching_dev_channel: true\./
  )
  assert.throws(
    () =>
      syncConsumer({
        release_batching_dev_channel: 'maybe',
        release_batching_dev_workflow: 'release-assets.yml',
      }),
    /Unsupported release_batching_dev_channel/
  )
})
