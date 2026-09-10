import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  deploymentVersions,
  digestBuild,
  httpsUrl,
  inspectBindings,
  parseArgv,
  parseUpload,
  pinnedWrangler,
  validateRollback,
} from '../src/lib/cloudflare-delivery.mjs'
import {
  deliveryCommand,
  latestDeployment,
  requestJson,
} from '../src/commands/cloudflare-delivery.mjs'

const candidate = '11111111-1111-1111-1111-111111111111'
const baseline = '22222222-2222-2222-2222-222222222222'
const deployed = '33333333-3333-3333-3333-333333333333'
const sha = 'a'.repeat(40)
const upload = {
  type: 'version-upload',
  version: 1,
  worker_name: 'site',
  version_id: candidate,
  preview_url: 'https://123-site.team.workers.dev/',
}
const policy = { schemaVersion: 1, rollbackSafe: true }
const version = (bindings = []) => ({ id: candidate, resources: { bindings } })

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'foundry-delivery-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function environment(root) {
  return {
    FOUNDRY_STATE_FILE: join(root, 'state.json'),
    GITHUB_SHA: sha,
    FOUNDRY_WORKER: 'site',
    GITHUB_REPOSITORY: 'test/repo',
    GITHUB_REF: 'refs/heads/main',
    FOUNDRY_DEFAULT_BRANCH: 'main',
    GH_TOKEN: 'fixture-github-token',
    CLOUDFLARE_API_TOKEN: 'fixture-cloudflare-token',
    CLOUDFLARE_ACCOUNT_ID: 'account',
  }
}

function state(root, extra = {}) {
  writeFileSync(
    join(root, 'state.json'),
    JSON.stringify({
      sourceSha: sha,
      worker: 'site',
      versionId: candidate,
      url: upload.preview_url,
      candidateVerified: true,
      bindingInspection: inspectBindings(version(), policy, 'production'),
      ...extra,
    })
  )
}

function respond(value) {
  return new Response(JSON.stringify(value), { status: 200 })
}

test('structured output yields exact candidate identity and URL', () => {
  const text = `${JSON.stringify({ type: 'wrangler-session' })}\n${JSON.stringify(upload)}\n`
  assert.deepEqual(parseUpload(text, 'site'), {
    worker: 'site',
    versionId: candidate,
    url: upload.preview_url,
  })
})

for (const data of [
  { ...upload, preview_url: '' },
  { ...upload, worker_name: 'other' },
  { ...upload, version_id: 'latest' },
  { ...upload, version: 2 },
  { ...upload, preview_url: 'https://evil.example/' },
]) {
  test(`invalid upload fails: ${JSON.stringify(data)}`, () =>
    assert.throws(() => parseUpload(JSON.stringify(data), 'site')))
}

test('duplicate records and explicit command failure fail closed', () => {
  assert.throws(() => parseUpload(`${JSON.stringify(upload)}\n${JSON.stringify(upload)}`, 'site'))
  assert.throws(() => parseUpload(`${JSON.stringify(upload)}\n{"type":"command-failed"}`, 'site'))
})

for (const value of ['latest', '^4.0.0', '4', '4.0.0; echo unsafe']) {
  test(`mutable Wrangler selection rejected: ${value}`, () =>
    assert.throws(() => pinnedWrangler(value)))
}

test('local Wrangler never implicitly installs and exact versions are argv', () => {
  assert.deepEqual(pinnedWrangler('local'), ['bunx', '--bun', '--no-install', 'wrangler'])
  assert.deepEqual(pinnedWrangler('4.0.0'), ['npx', '--yes', 'wrangler@4.0.0'])
  assert.deepEqual(parseArgv('["node","probe.mjs","two words; $(echo test)"]', 'probe'), [
    'node',
    'probe.mjs',
    'two words; $(echo test)',
  ])
  assert.throws(() => parseArgv('[]', 'probe'))
})

test('URL policy rejects credentials, HTTP, and fragments', () => {
  for (const url of ['http://example.com', 'https://u:p@example.com', 'https://example.com/#token'])
    assert.throws(() => httpsUrl(url))
})

test('build digest is content-sensitive and rejects external trees or symlinks', (t) => {
  const root = fixture(t)
  mkdirSync(join(root, 'dist'))
  writeFileSync(join(root, 'dist/index.html'), 'first')
  const first = digestBuild(root, 'dist')
  assert.equal(first, digestBuild(root, 'dist'))
  writeFileSync(join(root, 'dist/index.html'), 'second')
  assert.notEqual(first, digestBuild(root, 'dist'))
  assert.throws(() => digestBuild(root, '..'))
  symlinkSync('/etc/hosts', join(root, 'dist/outside'))
  assert.throws(() => digestBuild(root, 'dist'), /symlinks/)
})

test('stateless detection requires explicit rollback approval', () => {
  assert.equal(inspectBindings(version(), { schemaVersion: 1 }, 'production').rollbackSafe, false)
  assert.equal(inspectBindings(version(), policy, 'production').rollbackSafe, true)
})

test('unreviewed state and Durable Objects fail closed', () => {
  assert.throws(
    () => inspectBindings(version([{ name: 'DB', type: 'd1' }]), policy, 'preview'),
    /Unreviewed/
  )
  assert.throws(
    () =>
      inspectBindings(
        version([{ name: 'DO', type: 'durable_object_namespace' }]),
        policy,
        'preview'
      ),
    /Durable/
  )
  assert.throws(
    () =>
      inspectBindings(
        {
          resources: {
            bindings: [],
            script_runtime: { exports: { Object: { type: 'durable-object' } } },
          },
        },
        policy,
        'preview'
      ),
    /Durable/
  )
  assert.throws(() => inspectBindings({}, policy, 'preview'), /metadata/)
})

test('reviewed stateful tests never enable automatic rollback', () => {
  const inspected = inspectBindings(
    version([{ name: 'DB', type: 'd1' }]),
    { ...policy, readOnlyBindings: [{ name: 'DB', type: 'd1' }] },
    'production'
  )
  assert.equal(inspected.stateless, false)
  assert.equal(inspected.rollbackSafe, false)
})

test('isolated previews verify resource IDs and cannot be promoted', () => {
  const binding = { name: 'DB', type: 'd1', id: 'preview-id' }
  const isolated = {
    ...policy,
    isolatedBindings: [
      {
        name: 'DB',
        type: 'd1',
        expected: { id: 'preview-id' },
        production: { id: 'production-id' },
      },
    ],
  }
  assert.equal(
    inspectBindings(version([binding]), isolated, 'preview').bindings[0].policy,
    'isolated'
  )
  assert.throws(
    () => inspectBindings(version([binding]), isolated, 'production'),
    /never be promoted/
  )
  assert.throws(
    () => inspectBindings(version([{ ...binding, id: 'production-id' }]), isolated, 'preview'),
    /mismatch/
  )
})

test('canary routing preserves exact baseline and total percentage', () => {
  assert.deepEqual(deploymentVersions(candidate, 10, [{ version_id: baseline, percentage: 100 }]), [
    { version_id: candidate, percentage: 10 },
    { version_id: baseline, percentage: 90 },
  ])
  assert.throws(() => deploymentVersions(candidate, 10, []))
  for (const value of [0, 101, NaN, 0.001, 99.999])
    assert.throws(() => deploymentVersions(candidate, value, []))
  assert.throws(() => validateRollback([{ version_id: baseline, percentage: 50 }]))
})

test('deployment ordering uses timestamps rather than trusting array order', () => {
  assert.equal(
    latestDeployment({
      deployments: [
        { id: 'old', created_on: '2026-01-01T00:00:00Z' },
        { id: 'new', created_on: '2026-01-02T00:00:00Z' },
      ],
    }).id,
    'new'
  )
  assert.throws(() => latestDeployment({ deployments: [{}] }))
})

test('HTTP API failures do not disclose authorization or response bodies', async () => {
  await assert.rejects(
    requestJson(
      'https://api.example',
      'sensitive-token',
      undefined,
      async () => new Response('sensitive-response', { status: 403 })
    ),
    (error) => {
      assert.match(error.message, /403/)
      assert.doesNotMatch(error.message, /sensitive/)
      return true
    }
  )
})

test('PR deployment records use the head commit rather than the merge commit', async (t) => {
  const root = fixture(t)
  const headSha = 'b'.repeat(40)
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options })
    return respond(options.method === 'POST' ? { id: 123 } : {})
  })
  await deliveryCommand('record-start', {
    ...environment(root),
    DEPLOYMENT_ENVIRONMENT: 'Preview',
    FOUNDRY_PHASE: 'candidate',
    GITHUB_DEPLOYMENT_REF: headSha,
  })
  const body = JSON.parse(calls.find((call) => call.url.endsWith('/deployments')).options.body)
  assert.equal(body.ref, headSha)
  assert.equal(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).githubDeploymentId, 123)
})

test('production source freshness rejects newer default-branch commits', async (t) => {
  const root = fixture(t)
  state(root)
  t.mock.method(globalThis, 'fetch', async () => respond({ object: { sha: 'b'.repeat(40) } }))
  await assert.rejects(deliveryCommand('assert-current', environment(root)), /stale/)
})

test('verification receives the exact version identity without credentials', async (t) => {
  const root = fixture(t)
  state(root)
  const probe = join(root, 'probe.mjs')
  const observed = join(root, 'observed.json')
  writeFileSync(
    probe,
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(observed)}, JSON.stringify({\n  expected: process.env.FOUNDRY_EXPECTED_VERSION_ID,\n  deployment: process.env.FOUNDRY_DEPLOYMENT_ID,\n  phase: process.env.FOUNDRY_DEPLOYMENT_PHASE,\n  token: process.env.CLOUDFLARE_API_TOKEN,\n  github: process.env.GH_TOKEN,\n}))\n`
  )
  t.mock.method(globalThis, 'fetch', async () => new Response('ok', { status: 200 }))
  await deliveryCommand('verify', {
    ...environment(root),
    VERIFY_COMMAND: JSON.stringify([process.execPath, probe]),
  })
  assert.deepEqual(JSON.parse(readFileSync(observed, 'utf8')), {
    expected: candidate,
    deployment: '',
    phase: 'candidate',
  })
})

test('promotion activates the verified UUID without executing a build', async (t) => {
  const root = fixture(t)
  state(root)
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options })
    if (String(url).includes('/versions/')) return respond({ success: true, result: version() })
    if (options.method === 'GET')
      return respond({
        success: true,
        result: {
          deployments: [
            {
              id: baseline,
              created_on: '2026-01-01T00:00:00Z',
              versions: [{ version_id: baseline, percentage: 100 }],
            },
          ],
        },
      })
    return respond({ success: true, result: { id: deployed } })
  })
  await deliveryCommand('activate', environment(root))
  const posted = JSON.parse(calls.find((call) => call.options.method === 'POST').options.body)
  assert.deepEqual(posted.versions, [{ version_id: candidate, percentage: 100 }])
  assert.equal(
    JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).cloudflareDeploymentId,
    deployed
  )
})

test('rollback cannot undo another concurrent deployment', async (t) => {
  const root = fixture(t)
  state(root, {
    cloudflareDeploymentId: deployed,
    previous: [{ version_id: baseline, percentage: 100 }],
  })
  t.mock.method(globalThis, 'fetch', async () =>
    respond({
      success: true,
      result: { deployments: [{ id: candidate, created_on: '2026-01-02T00:00:00Z' }] },
    })
  )
  await assert.rejects(
    deliveryCommand('rollback', { ...environment(root), AUTO_ROLLBACK: 'true' }),
    /another rollout/
  )
})

test('source mismatch and unverified candidates cannot initialize production', async (t) => {
  const root = fixture(t)
  await assert.rejects(deliveryCommand('init-production', environment(root)), /verification/)
  await assert.rejects(
    deliveryCommand('init-production', {
      ...environment(root),
      CANDIDATE_VERIFIED: 'true',
      CANDIDATE_SOURCE_SHA: 'b'.repeat(40),
    }),
    /SHA mismatch/
  )
})

test('workflow keeps approvals, identities, and secrets separated', () => {
  const yaml = readFileSync(
    new URL('../.github/workflows/cloudflare-delivery.yml', import.meta.url),
    'utf8'
  )
  assert.match(yaml, /cancel-in-progress: false/)
  assert.match(yaml, /draft-protection:[\s\S]*?type: boolean[\s\S]*?default: true/)
  assert.match(yaml, /inputs\['draft-protection'\] != true/)
  assert.match(yaml, /name: Production/)
  assert.match(yaml, /name: Preview/)
  assert.match(yaml, /turbo-filter:[\s\S]*?type: string[\s\S]*?default: auto/)
  assert.match(yaml, /name: Check Turbo delivery impact/)
  assert.match(yaml, /name: Resolve Turbo package/)
  assert.match(yaml, /TURBO_FILTER: \$\{\{ inputs\.turbo-filter \}\}/)
  assert.match(yaml, /github\.event_name == 'push'/)
  assert.match(yaml, /github\.event\.before/)
  assert.match(yaml, /fetch-depth: 0/)
  assert.match(yaml, /needs: affected/)
  assert.match(yaml, /needs\.affected\.outputs\.should_deploy == 'true'/)
  assert.equal((yaml.match(/deployment: false/g) ?? []).length, 2)
  assert.match(
    yaml,
    /inputs\.mode != 'preview' \|\| !startsWith\(github\.event\.pull_request\.head\.ref, 'release-please--branches--main'\)/
  )
  assert.match(
    yaml,
    /GITHUB_DEPLOYMENT_REF: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/
  )
  assert.match(yaml, /RUNTIME_REF.*inputs\.runtime-ref/)
  assert.match(yaml, /\^\[0-9a-fA-F\]\{40\}\$/)
  assert.match(yaml, /canary-verify-command/)
  assert.match(yaml, /VERIFY_COMMAND: \$\{\{ inputs\.canary-verify-command \}\}/)
  assert.match(yaml, /needs: candidate/)
  assert.match(yaml, /candidate\.outputs\.verified == 'true'/)
  assert.match(yaml, /pull_request_target/)
  assert.doesNotMatch(yaml, /CODE_FOUNDRY_DRAFT_PROTECTION/)
  assert.doesNotMatch(yaml, /wrangler deploy|wrangler@latest|continue-on-error: true/)
  assert.equal((yaml.match(/run: node "\$FOUNDRY_EXECUTOR" assert-current/g) ?? []).length, 3)
})
