import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  findQualificationReceipt,
  produceQualificationReceipt,
  readArtifactReceipt,
} from '../src/commands/qualification-receipt.mjs'
import {
  QUALIFICATION_RECEIPT_ARTIFACT_PREFIX,
  QUALIFICATION_RECEIPT_KIND,
  QUALIFICATION_RECEIPT_SCHEMA_VERSION,
} from '../src/lib/qualification-receipt.mjs'

const now = Date.parse('2026-10-29T12:00:00.000Z')
const sha = (digit) => digit.repeat(40)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const requiredJobNames = ['Validation / Gate']

function jobResults(runId, headSha, names = requiredJobNames) {
  return names.map((name, index) => ({
    id: index + 1,
    run_id: runId,
    head_sha: headSha,
    name,
    status: 'completed',
    conclusion: 'success',
  }))
}

function response(value) {
  return { ok: true, status: 200, json: async () => value }
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function sourceFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'foundry-receipt-source-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  execFileSync('git', ['init', '--quiet', directory])
  mkdirSync(join(directory, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(directory, '.github', 'workflows', 'validation.yml'), 'name: Validation\n')
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'fixture-consumer', version: '1.0.0' })
  )
  writeFileSync(join(directory, '.release-please-manifest.json'), JSON.stringify({ '.': '1.0.0' }))
  writeFileSync(
    join(directory, 'release-please-config.json'),
    JSON.stringify({ 'release-type': 'node' })
  )
  execFileSync('git', ['-C', directory, 'add', '.'])
  execFileSync('git', [
    '-C',
    directory,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ])
  const commit = git(directory, ['rev-parse', 'HEAD'])
  return {
    directory,
    commit,
    tree: git(directory, ['rev-parse', `${commit}^{tree}`]),
    workflowBlob: git(directory, ['rev-parse', `${commit}:.github/workflows/validation.yml`]),
  }
}

function mergedSourceFixture(t) {
  const source = sourceFixture(t)
  const baseCommit = source.commit
  execFileSync('git', ['-C', source.directory, 'switch', '-c', 'receipt-pr-head'])
  writeFileSync(join(source.directory, 'src.mjs'), 'export const tested = true\n')
  execFileSync('git', ['-C', source.directory, 'add', 'src.mjs'])
  execFileSync('git', [
    '-C',
    source.directory,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'PR head',
  ])
  const headCommit = git(source.directory, ['rev-parse', 'HEAD'])
  execFileSync('git', ['-C', source.directory, 'switch', '-c', 'receipt-base', baseCommit])
  execFileSync('git', [
    '-C',
    source.directory,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'merge',
    '--no-ff',
    '--no-edit',
    'receipt-pr-head',
  ])
  const mergeCommit = git(source.directory, ['rev-parse', 'HEAD'])
  return {
    ...source,
    baseCommit,
    headCommit,
    commit: mergeCommit,
    tree: git(source.directory, ['rev-parse', `${mergeCommit}^{tree}`]),
  }
}

test('producer binds the receipt to the tested merge tree, run attempt, and exact PR identity', async (t) => {
  const source = mergedSourceFixture(t)
  const eventPath = join(source.directory, 'event.json')
  const sourceHead = source.headCommit
  const sourceEvent = {
    pull_request: {
      number: 18,
      base: { ref: 'main', sha: source.baseCommit, repo: { full_name: 'acme/consumer' } },
      head: { ref: 'fix/source', sha: sourceHead, repo: { full_name: 'acme/consumer' } },
    },
  }
  writeFileSync(eventPath, JSON.stringify(sourceEvent))
  const run = {
    id: 303,
    run_attempt: 2,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    head_sha: sourceHead,
    head_branch: 'fix/source',
    workflow_id: 42,
    path: '.github/workflows/validation.yml',
    repository: { full_name: 'acme/consumer' },
    created_at: '2026-10-29T10:00:00.000Z',
    pull_requests: [{ number: 18 }],
  }
  const associatedPullRequest = {
    number: 18,
    base: { repo: { full_name: 'acme/consumer' }, ref: 'main' },
    head: { repo: { full_name: 'acme/consumer' }, ref: 'fix/source', sha: sourceHead },
  }
  const fetchImpl = async (url) => {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/actions/workflows/validation.yml')) {
      return response({ id: 42, path: '.github/workflows/validation.yml', state: 'active' })
    }
    if (parsed.pathname.endsWith('/actions/runs/303')) return response(run)
    if (parsed.pathname.endsWith(`/commits/${sourceHead}/pulls`)) {
      return response([associatedPullRequest])
    }
    if (parsed.pathname.endsWith('/actions/runs/303/attempts/2/jobs')) {
      return response({ total_count: requiredJobNames.length, jobs: jobResults(303, sourceHead) })
    }
    throw new Error(`Unexpected API request: ${parsed.pathname}`)
  }
  const env = {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: 'acme/consumer',
    GITHUB_API_URL: 'https://api.github.com',
    GITHUB_WORKFLOW_REF: 'acme/consumer/.github/workflows/validation.yml@refs/pull/18/merge',
    GITHUB_WORKFLOW_SHA: source.commit,
    GITHUB_SHA: source.commit,
    GITHUB_RUN_ID: '303',
    GITHUB_RUN_ATTEMPT: '2',
    FOUNDRY_MODE: 'audit',
    FOUNDRY_JOB_RESULTS_JSON: JSON.stringify({
      ci: 'success',
      test: 'success',
      security: 'success',
      codeql: 'success',
      eval: 'success',
      gate: 'success',
    }),
    FOUNDRY_REQUIRED_JOB_NAMES_JSON: JSON.stringify(requiredJobNames),
    GITHUB_TOKEN: 'fixture-token',
    RUNTIME_PATH: root,
    RUNTIME_REPOSITORY: 'acme/code-foundry',
  }

  const receipt = await produceQualificationReceipt(env, { fetchImpl, cwd: source.directory })
  assert.equal(receipt.pull_request.number, 18)
  assert.equal(receipt.run.attempt, 2)
  assert.equal(receipt.tested.tree_sha, source.tree)

  run.pull_requests = []
  const receiptWithoutRunAssociation = await produceQualificationReceipt(env, {
    fetchImpl,
    cwd: source.directory,
  })
  assert.equal(receiptWithoutRunAssociation.pull_request.number, 18)

  writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: {
        ...sourceEvent.pull_request,
        base: { ...sourceEvent.pull_request.base, sha: sha('4') },
      },
    })
  )
  await assert.rejects(
    produceQualificationReceipt(env, { fetchImpl, cwd: source.directory }),
    /Tested merge commit does not match the source event/
  )

  writeFileSync(eventPath, JSON.stringify(sourceEvent))
  run.pull_requests = [{ number: 19 }]
  await assert.rejects(
    produceQualificationReceipt(env, { fetchImpl, cwd: source.directory }),
    /does not map uniquely/
  )
})

test('finds a receipt only from the exact workflow run and attempt for the current main tree', async (t) => {
  const source = sourceFixture(t)
  const runtimeSha = git(root, ['rev-parse', 'HEAD'])
  const runtimeTreeSha = git(root, ['rev-parse', 'HEAD^{tree}'])
  const createdAt = '2026-10-28T10:00:00.000Z'
  const run = {
    id: 202,
    run_attempt: 1,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    head_sha: sha('3'),
    head_branch: 'fix/source-tree',
    workflow_id: 42,
    path: '.github/workflows/validation.yml',
    repository: { full_name: 'acme/consumer' },
    head_repository: { full_name: 'acme/consumer' },
    created_at: createdAt,
    updated_at: '2026-10-28T11:00:00.000Z',
    pull_requests: [],
  }
  const artifact = {
    id: 900,
    name: `${QUALIFICATION_RECEIPT_ARTIFACT_PREFIX}-202-1`,
    expired: false,
    size_in_bytes: 400,
    created_at: '2026-10-28T11:00:00.000Z',
    expires_at: '2026-11-04T11:00:00.000Z',
    digest: `sha256:${'a'.repeat(64)}`,
    archive_download_url: 'https://api.github.com/repos/acme/consumer/actions/artifacts/900/zip',
    workflow_run: { id: 202, head_sha: sha('3') },
  }
  const receipt = {
    schema_version: QUALIFICATION_RECEIPT_SCHEMA_VERSION,
    kind: QUALIFICATION_RECEIPT_KIND,
    repository: 'acme/consumer',
    workflow: {
      id: 42,
      path: '.github/workflows/validation.yml',
      sha: source.commit,
      blob_sha: source.workflowBlob,
    },
    run: {
      id: 202,
      attempt: 1,
      event: 'pull_request',
      head_sha: sha('3'),
      created_at: createdAt,
      required_job_names: requiredJobNames,
    },
    pull_request: {
      number: 17,
      base_repository: 'acme/consumer',
      base_ref: 'main',
      base_sha: source.commit,
      head_repository: 'acme/consumer',
      head_ref: 'fix/source-tree',
      head_sha: sha('3'),
    },
    mode: 'audit',
    tested: { sha: source.commit, tree_sha: source.tree },
    runtime: { repository: 'acme/code-foundry', sha: runtimeSha, tree_sha: runtimeTreeSha },
    jobs: {
      ci: 'success',
      test: 'success',
      security: 'success',
      codeql: 'success',
      eval: 'success',
      gate: 'success',
    },
  }
  const sourcePullRequest = {
    number: 17,
    state: 'closed',
    merged: true,
    merged_at: '2026-10-28T12:00:00.000Z',
    base: { repo: { full_name: 'acme/consumer' }, ref: 'main', sha: source.commit },
    head: {
      repo: { full_name: 'acme/consumer' },
      ref: 'fix/source-tree',
      sha: sha('3'),
    },
  }
  const eventPath = join(source.directory, 'event.json')
  writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: {
        number: 18,
        base: { ref: 'main', sha: source.commit, repo: { full_name: 'acme/consumer' } },
        head: {
          ref: 'release-please--branches--main',
          sha: sha('5'),
          repo: { full_name: 'acme/consumer' },
        },
      },
    })
  )

  const apiCalls = []
  const jobPages = []
  let associatedPullRequests = [sourcePullRequest]
  const fetchImpl = async (url) => {
    const parsed = new URL(url)
    apiCalls.push(parsed.pathname)
    if (parsed.pathname.endsWith('/actions/workflows/validation.yml')) {
      return response({ id: 42, path: '.github/workflows/validation.yml', state: 'active' })
    }
    if (parsed.pathname.endsWith('/actions/workflows/42/runs')) {
      return response({ total_count: 1, workflow_runs: [run] })
    }
    if (parsed.pathname.endsWith('/actions/runs/202/artifacts')) {
      return response({ total_count: 1, artifacts: [artifact] })
    }
    if (parsed.pathname.endsWith('/actions/runs/202')) return response(run)
    if (parsed.pathname.endsWith(`/commits/${run.head_sha}/pulls`)) {
      return response(associatedPullRequests)
    }
    if (parsed.pathname.endsWith('/pulls/17')) return response(sourcePullRequest)
    if (parsed.pathname.endsWith('/actions/runs/202/attempts/1/jobs')) {
      const page = Number(parsed.searchParams.get('page'))
      jobPages.push(page)
      if (page === 1) {
        return response({
          total_count: 101,
          jobs: Array.from({ length: 100 }, (_, index) => ({
            ...jobResults(202, run.head_sha)[0],
            id: index + 1,
            name: `Validation / Optional ${index + 1}`,
          })),
        })
      }
      return response({ total_count: 101, jobs: jobResults(202, run.head_sha) })
    }
    throw new Error(`Unexpected API request: ${parsed.pathname}`)
  }

  const result = await findQualificationReceipt(
    {
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: 'acme/consumer',
      GITHUB_API_URL: 'https://api.github.com/api/v3',
      GITHUB_WORKFLOW_REF: 'acme/consumer/.github/workflows/validation.yml@refs/pull/18/merge',
      GITHUB_WORKFLOW_SHA: source.commit,
      FOUNDRY_MODE: 'release',
      FOUNDRY_CODEQL_ENABLED: 'true',
      FOUNDRY_REQUIRED_JOB_NAMES_JSON: JSON.stringify(requiredJobNames),
      GITHUB_TOKEN: 'fixture-token',
      RUNTIME_PATH: root,
      RUNTIME_REPOSITORY: 'acme/code-foundry',
    },
    {
      fetchImpl,
      cwd: source.directory,
      now,
      readArtifact: async (candidate) => {
        assert.equal(candidate.id, artifact.id)
        return { receipt, digest_verified: true }
      },
    }
  )

  assert.equal(result.verified, true, `${result.reason}\n${apiCalls.join('\n')}`)
  assert.deepEqual(apiCalls, [
    '/api/v3/repos/acme/consumer/actions/workflows/validation.yml',
    '/api/v3/repos/acme/consumer/actions/workflows/42/runs',
    '/api/v3/repos/acme/consumer/actions/runs/202/artifacts',
    '/api/v3/repos/acme/consumer/actions/runs/202',
    `/api/v3/repos/acme/consumer/commits/${run.head_sha}/pulls`,
    '/api/v3/repos/acme/consumer/pulls/17',
    '/api/v3/repos/acme/consumer/actions/runs/202/attempts/1/jobs',
    '/api/v3/repos/acme/consumer/actions/runs/202/attempts/1/jobs',
  ])
  assert.deepEqual(jobPages, [1, 2])

  associatedPullRequests = [sourcePullRequest, { ...sourcePullRequest, number: 19 }]
  const ambiguous = await findQualificationReceipt(
    {
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: 'acme/consumer',
      GITHUB_API_URL: 'https://api.github.com/api/v3',
      GITHUB_WORKFLOW_REF: 'acme/consumer/.github/workflows/validation.yml@refs/pull/18/merge',
      GITHUB_WORKFLOW_SHA: source.commit,
      FOUNDRY_MODE: 'release',
      FOUNDRY_CODEQL_ENABLED: 'true',
      FOUNDRY_REQUIRED_JOB_NAMES_JSON: JSON.stringify(requiredJobNames),
      GITHUB_TOKEN: 'fixture-token',
      RUNTIME_PATH: root,
      RUNTIME_REPOSITORY: 'acme/code-foundry',
    },
    {
      fetchImpl,
      cwd: source.directory,
      now,
      readArtifact: async () => ({ receipt, digest_verified: true }),
    }
  )
  assert.equal(ambiguous.verified, false)
})

test('unsupported package and release layouts fall back before any receipt API lookup', async (t) => {
  const unsupportedLayouts = [
    { packageManifest: { name: 'fixture-consumer', version: '1.0.0', private: true } },
    { packageManifest: { name: 'fixture-consumer', version: '1.0.0', workspaces: ['packages/*'] } },
    {
      releaseConfig: {
        'release-type': 'node',
        'extra-files': [{ type: 'json', path: 'package.json', jsonpath: '$.release' }],
      },
    },
    {
      packageManifest: {
        name: 'fixture-consumer',
        version: '1.0.0',
        scripts: { prepack: 'node build-package.mjs' },
      },
    },
    {
      packageManifest: {
        name: 'fixture-consumer',
        version: '1.0.0',
        scripts: {
          build: 'node build.mjs',
          prepublishOnly: 'bun run build && node extra-step.mjs',
        },
      },
    },
    {
      packageManifest: {
        name: 'fixture-consumer',
        version: '1.0.0',
        scripts: { build: 'node build.mjs', prepublishOnly: 'bun run build' },
      },
      packageManager: 'npm',
    },
  ]
  for (const layout of unsupportedLayouts) {
    const source = sourceFixture(t)
    const eventPath = join(source.directory, 'release-event.json')
    if (layout.packageManifest) {
      writeFileSync(join(source.directory, 'package.json'), JSON.stringify(layout.packageManifest))
    }
    if (layout.releaseConfig) {
      writeFileSync(
        join(source.directory, 'release-please-config.json'),
        JSON.stringify(layout.releaseConfig)
      )
    }
    if (layout.packageManager) {
      writeFileSync(
        join(source.directory, '.github', 'code-foundry.yml'),
        `package_manager: ${layout.packageManager}\n`
      )
    }
    writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: {
          number: 18,
          base: { ref: 'main', sha: source.commit, repo: { full_name: 'acme/consumer' } },
          head: {
            ref: 'release-please--branches--main',
            sha: sha('5'),
            repo: { full_name: 'acme/consumer' },
          },
        },
      })
    )
    let apiCalls = 0
    const result = await findQualificationReceipt(
      {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: 'acme/consumer',
        FOUNDRY_MODE: 'release',
      },
      { cwd: source.directory, fetchImpl: async () => (apiCalls += 1) }
    )
    assert.equal(result.verified, false)
    assert.match(result.reason, /unsupported package release contract/)
    assert.equal(apiCalls, 0)
  }
})

test('a build-only prepublishOnly hook is allowed only when the versioned build lane runs', (t) => {
  const source = sourceFixture(t)
  writeFileSync(
    join(source.directory, 'package.json'),
    JSON.stringify({
      name: 'fixture-consumer',
      version: '1.0.0',
      scripts: { build: 'node build.mjs', prepublishOnly: 'bun run build' },
    })
  )
  writeFileSync(join(source.directory, '.github', 'code-foundry.yml'), 'package_manager: bun\n')
  execFileSync('node', [join(root, 'src/commands/qualification-receipt.mjs'), 'package-contract'], {
    cwd: source.directory,
    env: {
      ...process.env,
      FOUNDRY_BUILD_TASK_APPLICABLE: 'true',
      FOUNDRY_BUILD_TASK_AFFECTED: 'false',
      REPO_FOUNDRY_PACKAGE_MANAGER: 'bun',
    },
  })
  assert.throws(
    () =>
      execFileSync(
        'node',
        [join(root, 'src/commands/qualification-receipt.mjs'), 'package-contract'],
        {
          cwd: source.directory,
          env: {
            ...process.env,
            FOUNDRY_BUILD_TASK_APPLICABLE: 'true',
            REPO_FOUNDRY_PACKAGE_MANAGER: 'npm',
          },
          stdio: 'pipe',
        }
      ),
    (error) => error.status === 1
  )
  assert.throws(
    () =>
      execFileSync(
        'node',
        [join(root, 'src/commands/qualification-receipt.mjs'), 'package-contract'],
        {
          cwd: source.directory,
          env: { ...process.env, FOUNDRY_BUILD_TASK_APPLICABLE: 'false' },
          stdio: 'pipe',
        }
      ),
    (error) => error.status === 1
  )
})

test('bounds artifact downloads and verifies GitHub size and SHA-256 metadata', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'foundry-receipt-zip-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const payloadPath = join(directory, 'qualification-receipt.json')
  const archivePath = join(directory, 'receipt.zip')
  const payload = { evidence: 'fixture' }
  writeFileSync(payloadPath, JSON.stringify(payload))
  execFileSync('zip', ['-q', '-j', archivePath, payloadPath])
  const archiveBytes = readFileSync(archivePath)
  const digest = `sha256:${createHash('sha256').update(archiveBytes).digest('hex')}`
  const artifact = {
    archive_download_url: 'https://api.github.com/repos/acme/consumer/actions/artifacts/1/zip',
    size_in_bytes: archiveBytes.length,
    digest,
  }
  let requestIndex = 0
  const download = await readArtifactReceipt(
    artifact,
    'https://api.github.com',
    'fixture-token',
    async (_url, init) => {
      requestIndex += 1
      if (requestIndex === 1) {
        assert.equal(init.headers.Authorization, 'Bearer fixture-token')
        return new Response(null, {
          status: 302,
          headers: { location: 'https://download.example/receipt' },
        })
      }
      assert.equal(init.headers?.Authorization, undefined)
      return new Response(archiveBytes)
    }
  )
  assert.deepEqual(download, { receipt: payload, digest_verified: true })

  await assert.rejects(
    readArtifactReceipt(
      { ...artifact, digest: `sha256:${'f'.repeat(64)}` },
      'https://api.github.com',
      'fixture-token',
      async (_url, init) => {
        if (init.headers?.Authorization) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://download.example/receipt' },
          })
        }
        return new Response(archiveBytes)
      }
    ),
    /digest does not match/
  )
  await assert.rejects(
    readArtifactReceipt(
      { ...artifact, size_in_bytes: artifact.size_in_bytes - 1 },
      'https://api.github.com',
      'fixture-token',
      async (_url, init) => {
        if (init.headers?.Authorization) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://download.example/receipt' },
          })
        }
        return new Response(archiveBytes)
      }
    ),
    /size does not match/
  )

  let oversizedReads = 0
  const oversizedStream = new ReadableStream({
    pull(controller) {
      oversizedReads += 1
      controller.enqueue(new Uint8Array(600 * 1024))
      if (oversizedReads === 2) controller.close()
    },
  })
  await assert.rejects(
    readArtifactReceipt(
      { ...artifact, size_in_bytes: 900 * 1024 },
      'https://api.github.com',
      'fixture-token',
      async () => new Response(oversizedStream)
    ),
    /exceeds the size limit/
  )
  assert.equal(oversizedReads, 2)
  await assert.rejects(
    readArtifactReceipt(
      { ...artifact, size_in_bytes: 2 * 1024 * 1024 },
      'https://api.github.com',
      'fixture-token',
      async () => {
        throw new Error('oversized artifact must be rejected before network access')
      }
    ),
    /size or digest is unavailable/
  )
})
