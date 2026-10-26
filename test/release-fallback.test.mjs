import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
const step = workflow.split('      - name: Create missing release objects over REST')[1]
const script = step
  .split("node <<'NODE'\n")[1]
  .split('\n          NODE')[0]
  .split('\n')
  .map((line) => line.slice(10))
  .join('\n')
const sha = 'a'.repeat(40)
const pull = {
  merged_at: '2026-10-23',
  head: { ref: 'release-please--branches--main' },
  title: 'chore(main): release 1.114.0',
  merge_commit_sha: sha,
  body: 'Release notes',
}

function run({ pages = [[]], pulls = [pull], failRead = false, failWrite = false } = {}) {
  const calls = []
  let output = ''
  let error
  try {
    runInNewContext(script, {
      require(name) {
        if (name === 'node:fs')
          return {
            readFileSync(path) {
              return path === 'config.json' ? '{"draft":true}' : '{}'
            },
            appendFileSync(_path, value) {
              output += value
            },
          }
        assert.equal(name, 'node:child_process')
        return {
          execFileSync(command, args, options) {
            assert.equal(command, 'gh', 'no sleeps or other subprocesses expected')
            calls.push({ args, options })
            const endpoint = args[1]
            if (endpoint.endsWith('/pulls')) return JSON.stringify(pulls)
            if (endpoint.endsWith('/tags')) return JSON.stringify([{ name: 'workspace-v1.114.0' }])
            assert.equal(endpoint, 'repos/example/project/releases')
            if (args.includes('POST')) {
              if (failWrite) throw Object.assign(new Error('HTTP 422'), { status: 1 })
              return '{}'
            }
            assert.ok(args.includes('--paginate'))
            assert.ok(args.includes('--slurp'))
            if (failRead) throw Object.assign(new Error('listing denied'), { status: 1 })
            return JSON.stringify(pages)
          },
        }
      },
      process: {
        env: { REPOSITORY: 'example/project', CONFIG_FILE: 'config.json', GITHUB_OUTPUT: 'output' },
      },
      console: { log() {} },
    })
  } catch (caught) {
    error = caught
  }
  return { calls, output, error }
}
const writes = (result) => result.calls.filter(({ args }) => args.includes('POST'))

test('fallback forwards release JSON stdin and preserves draft/output behavior', () => {
  const result = run()
  assert.ifError(result.error)
  assert.equal(writes(result).length, 1)
  const { args, options } = writes(result)[0]
  assert.deepEqual(Array.from(args.slice(-2)), ['--input', '-'])
  assert.deepEqual(JSON.parse(options.input), {
    tag_name: 'workspace-v1.114.0',
    name: 'workspace-v1.114.0',
    body: 'Release notes',
    draft: true,
    prerelease: false,
  })
  assert.equal(options.encoding, 'utf8')
  assert.equal(options.maxBuffer, 32 * 1024 * 1024)
  assert.match(result.output, /fallback_created=true\ntag_name=workspace-v1.114.0\nsha=/)
})

for (const draft of [false, true]) {
  test(`existing ${draft ? 'draft' : 'published'} release on later page prevents duplicate creation`, () => {
    const result = run({
      pages: [[{ tag_name: 'workspace-v9.0.0' }], [{ tag_name: 'workspace-v1.114.0', draft }]],
    })
    assert.ifError(result.error)
    assert.equal(writes(result).length, 0)
    assert.match(result.output, /fallback_created=true/)
  })
}

test('existing first-page release retains ordinary success behavior', () => {
  const result = run({ pages: [[{ tag_name: 'workspace-v1.114.0' }]] })
  assert.ifError(result.error)
  assert.equal(writes(result).length, 0)
})

test('a newly created release is remembered for duplicate candidate entries', () => {
  const result = run({ pulls: [pull, pull] })
  assert.ifError(result.error)
  assert.equal(writes(result).length, 1)
})

test('listing failure or malformed page fails closed before any write', () => {
  for (const settings of [
    { failRead: true },
    { pages: {} },
    { pages: [{}] },
    { pages: [[null]] },
    { pages: [[{ tag_name: '' }]] },
  ]) {
    const result = run(settings)
    assert.ok(result.error)
    assert.equal(writes(result).length, 0)
    assert.equal(result.output, '')
  }
})

test('creation failure and absence of eligible version PRs remain failures', () => {
  const failed = run({ failWrite: true })
  assert.match(failed.error?.message, /1 release object\(s\) could not be ensured/)
  assert.equal(writes(failed).length, 1)
  assert.equal(failed.output, '')
  const empty = run({ pulls: [] })
  assert.match(empty.error?.message, /no merged version pull request/)
  assert.equal(writes(empty).length, 0)
  assert.equal(empty.output, '')
})

test('release JSON reaches a real subprocess stdin without network', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-release-fallback-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'config.json'), '{"draft":true}')
  writeFileSync(join(root, '.release-please-manifest.json'), '{}')
  const fakeGh = join(root, 'gh')
  writeFileSync(
    fakeGh,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('POST')) {
  const input = fs.readFileSync(0, 'utf8');
  JSON.parse(input);
  fs.writeFileSync(process.env.STDIN_RECEIPT, input);
  console.log('{}');
} else if (args[1].endsWith('/pulls')) {
  console.log(process.env.PULLS);
} else if (args[1].endsWith('/tags')) {
  console.log('[{"name":"workspace-v1.114.0"}]');
} else {
  if (!args.includes('--paginate') || !args.includes('--slurp')) process.exit(9);
  console.log('[[]]');
}
`
  )
  chmodSync(fakeGh, 0o755)
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      PATH: root,
      REPOSITORY: 'example/project',
      CONFIG_FILE: 'config.json',
      GITHUB_OUTPUT: join(root, 'output'),
      STDIN_RECEIPT: join(root, 'stdin.json'),
      PULLS: JSON.stringify([pull]),
    },
  })
  assert.equal(result.status, 0, result.stderr)
  const received = JSON.parse(readFileSync(join(root, 'stdin.json'), 'utf8'))
  assert.equal(received.tag_name, 'workspace-v1.114.0')
  assert.equal(received.body, 'Release notes')
  assert.equal(received.draft, true)
  assert.match(readFileSync(join(root, 'output'), 'utf8'), /fallback_created=true/)
})
