import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  supportsAdeaUiWorkspaceReleaseContract,
  supportsRootNpmReleaseContract,
  validateAdeaUiWorkspaceReleaseDiff,
} from '../src/lib/release-package-contract.mjs'
import {
  QUALIFICATION_RECEIPT_ARTIFACT_PREFIX,
  QUALIFICATION_RECEIPT_KIND,
  QUALIFICATION_RECEIPT_SCHEMA_VERSION,
} from '../src/lib/qualification-receipt.mjs'

const now = Date.parse('2026-10-29T12:00:00.000Z')
const sha = (digit) => digit.repeat(40)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const requiredJobNames = ['Validation / Gate']

const adeaUiReleaseConfig = () => ({
  $schema: 'https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json',
  'bump-minor-pre-major': true,
  'pull-request-title-pattern': 'chore(main): release ${version}',
  'group-pull-request-title-pattern': 'chore(main): release ${version}',
  'include-component-in-tag': false,
  'manifest-file': '.release-please-manifest.json',
  packages: { '.': { 'release-type': 'node', 'package-name': '@adea-ai/ui' } },
  'extra-files': [{ type: 'json', path: 'packages/ui/package.json', jsonpath: '$.version' }],
})

const adeaUiPublisherObject = () => {
  const consumers = {
    'packed-conversation': 'bun run check:packed-conversation',
    'packed-layout': 'bun run check:packed-layout && bun run check:packed-settings-navigation',
    'packed-layout-renderer': 'bun run check:packed-layout-renderer',
    'packed-appearance': 'bun run check:packed-appearance',
    'packed-modal-dialog': 'bun run check:packed-modal-dialog',
    'packed-native-select': 'bun run check:packed-native-select',
  }
  const refuseExistingScript = [
    'set -euo pipefail',
    'if npm view "@adea-ai/ui@${VERSION}" version >/dev/null 2>&1; then',
    '  echo "::error title=Version already published::@adea-ai/ui@${VERSION} is already on the registry. Versions are immutable; bump the manifest and merge a new release instead of retagging."',
    '  exit 1',
    'fi',
    'echo "@adea-ai/ui@${VERSION} is available"',
  ].join('\n')
  const jobs = {
    prepare: {
      name: 'Prepare @adea-ai/ui',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 15,
      permissions: { contents: 'read' },
      outputs: {
        version: '${{ steps.version.outputs.version }}',
        archive_sha256: '${{ steps.archive.outputs.sha256 }}',
        archive_integrity: '${{ steps.archive.outputs.integrity }}',
      },
      steps: [
        {
          name: 'Checkout',
          uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
          with: { 'persist-credentials': false },
        },
        {
          name: 'Setup Bun',
          uses: 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
          with: { 'bun-version': '1.4.4', 'no-cache': true },
        },
        {
          name: 'Setup Node',
          uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
          with: { 'node-version': 24, 'registry-url': 'https://registry.npmjs.org' },
        },
        { name: 'Install dependencies', run: 'bun install --frozen-lockfile' },
        {
          name: 'Verify packed browser runtime policy',
          run: 'bun test ./.github/scripts/check-playwright-runtime.test.ts',
        },
        { name: 'Build the library', run: 'bun run --cwd packages/ui build' },
        {
          name: 'Read the version to publish',
          id: 'version',
          'working-directory': 'packages/ui',
          run: `echo "version=$(node -p "require('./package.json').version")" >> "$GITHUB_OUTPUT"`,
        },
        {
          name: 'Refuse to publish a version that already exists',
          if: '${{ inputs.dry-run != true }}',
          env: { VERSION: '${{ steps.version.outputs.version }}' },
          run: refuseExistingScript,
        },
        {
          name: 'Verify the publishable archive',
          'working-directory': 'packages/ui',
          run: 'bun run pack:check',
        },
        {
          name: 'Pack one immutable UI archive',
          id: 'archive',
          'working-directory': 'packages/ui',
          run: 'node scripts/prepare-packed-ui.mjs "$RUNNER_TEMP/prepared-ui"',
        },
        {
          name: 'Verify packed consumers',
          'working-directory': 'packages/ui',
          env: {
            ADEA_PACKED_UI_TARBALL: '${{ runner.temp }}/prepared-ui/package.tgz',
            ADEA_PACKED_UI_SHA256: '${{ steps.archive.outputs.sha256 }}',
          },
          run: 'bun run check:packed-consumer',
        },
        {
          name: 'Verify packed pure paste model',
          'working-directory': 'packages/ui',
          env: {
            ADEA_PACKED_UI_TARBALL: '${{ runner.temp }}/prepared-ui/package.tgz',
            ADEA_PACKED_UI_SHA256: '${{ steps.archive.outputs.sha256 }}',
          },
          run: 'bun run check:packed-paste-model',
        },
        {
          name: 'Upload the verified UI package',
          uses: 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
          with: {
            name: 'prepared-ui-package',
            path: '${{ runner.temp }}/prepared-ui/',
            'retention-days': 1,
            'if-no-files-found': 'error',
          },
        },
      ],
    },
  }
  const playwrightImage =
    'mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27'
  const consumerNames = {
    'packed-conversation': [
      ['Verify packed conversation composition', 'bun run check:packed-conversation'],
      ['Verify packed ListRow browser contract', 'bun run check:packed-list-row'],
    ],
    'packed-layout': [
      [
        'Verify packed pane model and settings navigation',
        'bun run check:packed-layout && bun run check:packed-settings-navigation',
      ],
    ],
    'packed-layout-renderer': [
      ['Verify packed pane renderer', 'bun run check:packed-layout-renderer'],
    ],
    'packed-appearance': [
      ['Verify packed appearance interactions and SSR', 'bun run check:packed-appearance'],
    ],
    'packed-modal-dialog': [['Verify packed modal dialog', 'bun run check:packed-modal-dialog']],
    'packed-native-select': [
      ['Verify native select from the packed artifact', 'bun run check:packed-native-select'],
    ],
  }
  const consumerJobNames = {
    'packed-conversation': ['Packed conversation', 15],
    'packed-layout': ['Packed layout', 15],
    'packed-layout-renderer': ['Packed layout renderer', 20],
    'packed-appearance': ['Packed appearance', 20],
    'packed-modal-dialog': ['Packed modal dialog', 15],
    'packed-native-select': ['Packed native select', 15],
  }
  for (const name of Object.keys(consumers)) {
    const [jobName, timeout] = consumerJobNames[name]
    jobs[name] = {
      name: jobName,
      needs: 'prepare',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': timeout,
      container: { image: playwrightImage },
      env: {
        PLAYWRIGHT_RUNTIME_IMAGE: playwrightImage,
        ADEA_PACKED_UI_TARBALL: '${{ github.workspace }}/prepared-ui/package.tgz',
        ADEA_PACKED_UI_SHA256: '${{ needs.prepare.outputs.archive_sha256 }}',
      },
      steps: [
        {
          name: 'Checkout',
          uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
          with: { 'persist-credentials': false },
        },
        {
          name: 'Prepare Bun extraction',
          run: 'apt-get update && apt-get install -y --no-install-recommends unzip',
        },
        {
          name: 'Setup Bun',
          uses: 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
          with: { 'bun-version': '1.4.4' },
        },
        { name: 'Install dependencies', run: 'bun install --frozen-lockfile' },
        {
          name: 'Download the verified UI package',
          uses: 'actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131',
          with: {
            name: 'prepared-ui-package',
            path: '${{ github.workspace }}/prepared-ui/',
          },
        },
        {
          name: 'Verify the shared archive',
          run: String.raw`printf '%s  %s\n' "$ADEA_PACKED_UI_SHA256" "$ADEA_PACKED_UI_TARBALL" | sha256sum --check`,
        },
        {
          name: 'Verify pinned headless engines',
          run: 'node .github/scripts/check-playwright-runtime.mjs',
        },
        ...consumerNames[name].map(([stepName, command]) => ({
          name: stepName,
          'working-directory': 'packages/ui',
          run: command,
        })),
      ],
    }
  }
  const pinNpmScript = [
    'set -euo pipefail',
    'needed="11.5.1"',
    'if [ "$(printf \'%s\\n%s\\n\' "$needed" "$(npm --version)" | sort -V | head -1)" != "$needed" ]; then',
    '  echo "::error title=npm is too old for trusted publishing::needs >= ${needed}, runner has $(npm --version)"',
    '  exit 1',
    'fi',
    'npm --version',
  ].join('\n')
  const verifyScript = String.raw`set -euo pipefail
archive="$RUNNER_TEMP/prepared-ui/package.tgz"
printf '%s  %s\n' "$EXPECTED_SHA256" "$archive" | sha256sum --check
node --input-type=module <<'NODE'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
const archivePath = process.env.RUNNER_TEMP + '/prepared-ui/package.tgz'
const bytes = readFileSync(archivePath)
const manifest = JSON.parse(readFileSync(process.env.RUNNER_TEMP + '/prepared-ui/manifest.json', 'utf8'))
const sha256 = createHash('sha256').update(bytes).digest('hex')
const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
if (manifest.name !== '@adea-ai/ui' || manifest.version !== process.env.EXPECTED_VERSION)
  throw new Error('Prepared package identity does not match release version')
if (sha256 !== process.env.EXPECTED_SHA256 || manifest.sha256 !== sha256)
  throw new Error('Prepared package SHA-256 does not match the verified artifact')
if (integrity !== process.env.EXPECTED_INTEGRITY || manifest.integrity !== integrity)
  throw new Error('Prepared package npm integrity does not match the verified artifact')
console.log(JSON.stringify({ name: manifest.name, version: manifest.version, sha256, integrity, size: bytes.byteLength }))
NODE`
  const confirmScript = [
    'set -euo pipefail',
    'for attempt in $(seq 1 20); do',
    '  latest="$(npm view @adea-ai/ui dist-tags.latest 2>/dev/null || echo \'\')"',
    '  echo "attempt ${attempt}/20: latest is ${latest:-<unreadable>}"',
    '  if [ "${latest}" = "${VERSION}" ]; then',
    '    echo "@adea-ai/ui@${VERSION} is what consumers get"',
    '    exit 0',
    '  fi',
    '  sleep 30',
    'done',
    'echo "::error title=latest did not advance::@adea-ai/ui@${VERSION} published but latest is still ${latest:-<unreadable>} after 10 minutes. Another publisher may own this package name — check whether adea-ai/adea is still publishing packages/ui."',
    'exit 1',
  ].join('\n')
  jobs.publish = {
    name: 'Publish @adea-ai/ui',
    if: '${{ inputs.dry-run != true }}',
    'runs-on': 'ubuntu-latest',
    'timeout-minutes': 15,
    needs: ['prepare', ...Object.keys(consumers)],
    permissions: { contents: 'read', 'id-token': 'write' },
    steps: [
      {
        name: 'Checkout',
        uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        with: { 'persist-credentials': false },
      },
      {
        name: 'Setup Node',
        uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
        with: { 'node-version': 24, 'registry-url': 'https://registry.npmjs.org' },
      },
      { name: 'Pin an npm that can do trusted publishing', run: pinNpmScript },
      {
        name: 'Download the verified UI package',
        uses: 'actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131',
        with: {
          name: 'prepared-ui-package',
          path: '${{ runner.temp }}/prepared-ui/',
        },
      },
      {
        name: 'Verify the exact release archive',
        env: {
          EXPECTED_VERSION: '${{ needs.prepare.outputs.version }}',
          EXPECTED_SHA256: '${{ needs.prepare.outputs.archive_sha256 }}',
          EXPECTED_INTEGRITY: '${{ needs.prepare.outputs.archive_integrity }}',
        },
        run: verifyScript,
      },
      {
        name: 'Publish with npm trusted publishing',
        run: 'npm publish "$RUNNER_TEMP/prepared-ui/package.tgz" --access public --provenance',
      },
      {
        name: 'Confirm the release is what consumers get',
        env: { VERSION: '${{ needs.prepare.outputs.version }}' },
        run: confirmScript,
      },
    ],
  }
  return {
    on: {
      push: { tags: ['v*'] },
      workflow_dispatch: { inputs: { 'dry-run': { type: 'boolean', default: true } } },
    },
    jobs,
  }
}
const yamlScalar = (value) => (typeof value === 'string' ? JSON.stringify(value) : String(value))

function adeaUiPublisherWorkflow(workflow = adeaUiPublisherObject()) {
  const lines = [
    'on:',
    '  push:',
    '    tags:',
    "      - 'v*'",
    '  workflow_dispatch:',
    '    inputs:',
    '      dry-run:',
    '        type: boolean',
    '        default: true',
    'jobs:',
  ]
  const map = (indent, key, value) => {
    lines.push(`${' '.repeat(indent)}${key}:`)
    for (const [child, childValue] of Object.entries(value)) {
      lines.push(`${' '.repeat(indent + 2)}${child}: ${yamlScalar(childValue)}`)
    }
  }
  for (const [name, job] of Object.entries(workflow.jobs)) {
    lines.push(`  ${name}:`)
    for (const key of ['name', 'runs-on', 'timeout-minutes', 'if', 'continue-on-error']) {
      if (job[key] !== undefined) lines.push(`    ${key}: ${yamlScalar(job[key])}`)
    }
    if (job.needs !== undefined) {
      lines.push('    needs:')
      for (const need of Array.isArray(job.needs) ? job.needs : [job.needs])
        lines.push(`      - ${yamlScalar(need)}`)
    }
    for (const key of ['outputs', 'permissions', 'env', 'container']) {
      if (job[key] !== undefined) map(4, key, job[key])
    }
    if (job.steps !== undefined) {
      lines.push('    steps:')
      for (const step of job.steps) {
        const keys = Object.keys(step)
        const primary = keys.includes('name')
          ? 'name'
          : keys.includes('id')
            ? 'id'
            : keys.includes('uses')
              ? 'uses'
              : keys.includes('run')
                ? 'run'
                : keys[0]
        const emitField = (indent, key, value, sequenceItem = false) => {
          const prefix = `${' '.repeat(indent)}${sequenceItem ? '- ' : ''}`
          if (key === 'run' && value.includes('\n')) {
            lines.push(`${prefix}${key}: |`)
            for (const line of value.split('\n')) lines.push(`          ${line}`)
          } else if ((key === 'with' || key === 'env') && typeof value === 'object') {
            map(indent, key, value)
          } else {
            lines.push(`${prefix}${key}: ${yamlScalar(value)}`)
          }
        }
        emitField(6, primary, step[primary], true)
        for (const [key, value] of Object.entries(step)) {
          if (key !== primary) emitField(8, key, value)
        }
      }
    }
  }
  return `${lines.join('\n')}\n`
}

const adeaUiLock = (version, dependencyVersion = '1.9.0') => `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "adea-ui"
    },
    "packages/ui": {
      "name": "@adea-ai/ui",
      "version": "${version}"
    }
  },
  "packages": {
    "solid-js": ["solid-js@${dependencyVersion}", "", {}, "sha512-fixture"]
  }
}\n`

function adeaUiContractInput() {
  const version = '1.0.0'
  return {
    rootPackageManifest: {
      name: 'adea-ui',
      version,
      private: true,
      workspaces: ['apps/*', 'packages/*'],
      packageManager: 'bun@1.4.4',
      scripts: { 'pack:check': 'bun run --cwd packages/ui pack:check' },
    },
    workspacePackageManifest: {
      name: '@adea-ai/ui',
      version,
      publishConfig: { access: 'public' },
      scripts: {
        build: 'bun run cn:build && vite build && tsc -p tsconfig.json --emitDeclarationOnly',
        'pack:check': 'bun scripts/check-pack.ts && bun scripts/check-lib-exports.ts',
      },
    },
    releaseManifest: { '.': version },
    releaseConfigs: [adeaUiReleaseConfig()],
    packageManager: 'bun',
    codeFoundryConfig: {
      release_qualification_receipts: 'true',
      npm_publish: 'false',
    },
    lockfileText: adeaUiLock(version),
    publisherWorkflowText: adeaUiPublisherWorkflow(),
  }
}

function adeaUiReleaseFiles(version, dependencyVersion = '1.9.0') {
  return new Map([
    [
      'package.json',
      JSON.stringify({
        name: 'adea-ui',
        version,
        private: true,
        workspaces: ['apps/*', 'packages/*'],
        packageManager: 'bun@1.4.4',
        scripts: { 'pack:check': 'bun run --cwd packages/ui pack:check' },
      }),
    ],
    [
      'packages/ui/package.json',
      JSON.stringify({
        name: '@adea-ai/ui',
        version,
        publishConfig: { access: 'public' },
        scripts: {
          build: 'bun run cn:build && vite build && tsc -p tsconfig.json --emitDeclarationOnly',
          'pack:check': 'bun scripts/check-pack.ts && bun scripts/check-lib-exports.ts',
        },
      }),
    ],
    ['.release-please-manifest.json', JSON.stringify({ '.': version })],
    ['CHANGELOG.md', `# ${version}\n`],
    ['bun.lock', adeaUiLock(version, dependencyVersion)],
  ])
}

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
        scripts: {
          test: 'node --test',
          'test:unit': 'node --test',
          'pack:check': 'npm pack --dry-run',
          prepublishOnly: 'npm test && npm run pack:check && node extra-step.mjs',
        },
      },
    },
    {
      packageManifest: {
        name: 'fixture-consumer',
        version: '1.0.0',
        scripts: {
          test: 'node --test',
          'test:unit': 'node --test',
          'pack:check': 'npm pack --dry-run',
          prepublishOnly: 'npm test && npm run pack:check',
          pretest: 'node mutate-before-tests.mjs',
          'prepack:check': 'node mutate-before-pack.mjs',
          postpublish: 'node release-side-effect.mjs',
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

test('an invalid opted-in Adea UI workspace package falls back before receipt lookup', async (t) => {
  const source = sourceFixture(t)
  const input = adeaUiContractInput()
  const eventPath = join(source.directory, 'release-event.json')
  writeFileSync(join(source.directory, 'package.json'), JSON.stringify(input.rootPackageManifest))
  mkdirSync(join(source.directory, 'packages/ui-target'), { recursive: true })
  writeFileSync(
    join(source.directory, 'packages/ui-target/package.json'),
    JSON.stringify({
      ...input.workspacePackageManifest,
    })
  )
  symlinkSync('ui-target', join(source.directory, 'packages/ui'))
  writeFileSync(
    join(source.directory, '.release-please-manifest.json'),
    JSON.stringify(input.releaseManifest)
  )
  writeFileSync(
    join(source.directory, 'release-please-config.json'),
    JSON.stringify(adeaUiReleaseConfig())
  )
  mkdirSync(join(source.directory, '.github/workflows'), { recursive: true })
  writeFileSync(
    join(source.directory, '.github/workflows/publish-ui.yml'),
    adeaUiPublisherWorkflow()
  )
  writeFileSync(join(source.directory, 'bun.lock'), input.lockfileText)
  writeFileSync(
    join(source.directory, '.github/code-foundry.yml'),
    ['package_manager: bun', 'release_qualification_receipts: true', 'npm_publish: false', ''].join(
      '\n'
    )
  )
  writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: {
        number: 18,
        base: { ref: 'main', sha: source.commit, repo: { full_name: 'adea-ai/ui' } },
        head: {
          ref: 'release-please--branches--main',
          sha: sha('5'),
          repo: { full_name: 'adea-ai/ui' },
        },
      },
    })
  )
  let apiCalls = 0
  const result = await findQualificationReceipt(
    {
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: 'adea-ai/ui',
      FOUNDRY_MODE: 'release',
    },
    { cwd: source.directory, fetchImpl: async () => (apiCalls += 1) }
  )
  assert.equal(result.verified, false)
  assert.match(result.reason, /unsupported package release contract/)
  assert.equal(apiCalls, 0)

  const event = JSON.parse(readFileSync(eventPath, 'utf8'))
  event.pull_request.base.repo.full_name = 'adea-ai/other'
  event.pull_request.head.repo.full_name = 'adea-ai/other'
  writeFileSync(eventPath, JSON.stringify(event))
  const otherRepository = await findQualificationReceipt(
    {
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: 'adea-ai/other',
      FOUNDRY_MODE: 'release',
    },
    { cwd: source.directory, fetchImpl: async () => (apiCalls += 1) }
  )
  assert.equal(otherRepository.verified, false)
  assert.match(otherRepository.reason, /unsupported package release contract/)
  assert.equal(apiCalls, 0)
})

test('Adea UI workspace receipt lookup rejects dependency lock drift before GitHub API access', async (t) => {
  const source = sourceFixture(t)
  const input = adeaUiContractInput()
  const writeUiTree = (version, dependencyVersion) => {
    const rootPackage = { ...input.rootPackageManifest, version }
    const uiPackage = { ...input.workspacePackageManifest, version }
    writeFileSync(join(source.directory, 'package.json'), JSON.stringify(rootPackage))
    mkdirSync(join(source.directory, 'packages/ui'), { recursive: true })
    writeFileSync(join(source.directory, 'packages/ui/package.json'), JSON.stringify(uiPackage))
    writeFileSync(
      join(source.directory, '.release-please-manifest.json'),
      JSON.stringify({ '.': version })
    )
    writeFileSync(
      join(source.directory, 'release-please-config.json'),
      JSON.stringify(adeaUiReleaseConfig())
    )
    mkdirSync(join(source.directory, '.github/workflows'), { recursive: true })
    writeFileSync(
      join(source.directory, '.github/workflows/publish-ui.yml'),
      adeaUiPublisherWorkflow()
    )
    writeFileSync(join(source.directory, 'bun.lock'), adeaUiLock(version, dependencyVersion))
    writeFileSync(
      join(source.directory, '.github/code-foundry.yml'),
      [
        'package_manager: bun',
        'release_qualification_receipts: true',
        'npm_publish: false',
        '',
      ].join('\n')
    )
    writeFileSync(join(source.directory, 'CHANGELOG.md'), `# ${version}\n`)
  }
  writeUiTree('1.0.0', '1.9.0')
  execFileSync('git', ['-C', source.directory, 'add', '.'])
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
    'UI main contract',
  ])
  const baseSha = git(source.directory, ['rev-parse', 'HEAD'])
  execFileSync('git', ['-C', source.directory, 'switch', '-c', 'release-please--branches--main'])
  writeUiTree('1.0.1', '1.9.1')
  execFileSync('git', ['-C', source.directory, 'add', '.'])
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
    'chore(main): release 1.0.1',
  ])
  const headSha = git(source.directory, ['rev-parse', 'HEAD'])
  const eventPath = join(source.directory, 'release-event.json')
  writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: {
        number: 18,
        base: { ref: 'main', sha: baseSha, repo: { full_name: 'adea-ai/ui' } },
        head: {
          ref: 'release-please--branches--main',
          sha: headSha,
          repo: { full_name: 'adea-ai/ui' },
        },
      },
    })
  )
  let apiCalls = 0
  const result = await findQualificationReceipt(
    {
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: 'adea-ai/ui',
      FOUNDRY_MODE: 'release',
    },
    { cwd: source.directory, fetchImpl: async () => (apiCalls += 1) }
  )
  assert.equal(result.verified, false)
  assert.match(result.reason, /workspace release metadata is not an exact version-only patch/)
  assert.equal(apiCalls, 0)
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

test('root release contract accepts only inert Themes-style settings', () => {
  const input = {
    packageManifest: { name: '@adea-ai/themes', version: '1.0.0' },
    releaseManifest: { '.': '1.0.0' },
    releaseConfigs: [
      {
        'release-type': 'node',
        'include-component-in-tag': false,
        'extra-files': [],
        packages: { '.': { 'package-name': '@adea-ai/themes' } },
      },
    ],
  }
  assert.equal(supportsRootNpmReleaseContract(input), true)
  for (const change of [
    { 'extra-files': ['other.json'] },
    { 'extra-files': null },
    { 'include-component-in-tag': true },
    { packages: { '.': { 'package-name': 'different' } } },
    { packages: { '.': { 'package-name': '@adea-ai/themes', 'extra-files': [] } } },
    { unsupported: true },
  ]) {
    assert.equal(
      supportsRootNpmReleaseContract({
        ...input,
        releaseConfigs: [{ ...input.releaseConfigs[0], ...change }],
      }),
      false
    )
  }
})

test('the explicit Adea UI contract accepts only the public UI workspace release layout', () => {
  const input = adeaUiContractInput()
  assert.equal(supportsAdeaUiWorkspaceReleaseContract(input), true)
  assert.equal(
    supportsRootNpmReleaseContract({
      packageManifest: input.rootPackageManifest,
      releaseManifest: input.releaseManifest,
      releaseConfigs: input.releaseConfigs,
      packageManager: input.packageManager,
    }),
    false,
    'the existing root npm contract must continue rejecting private workspace roots'
  )

  const unsafe = [
    { rootPackageManifest: { private: false } },
    { rootPackageManifest: { name: 'different-root' } },
    { rootPackageManifest: { workspaces: ['packages/*'] } },
    { rootPackageManifest: { scripts: { postinstall: 'node mutate.mjs' } } },
    { rootPackageManifest: { scripts: { preversion: 'node mutate.mjs' } } },
    { rootPackageManifest: { scripts: { postbuild: 'node mutate.mjs' } } },
    { workspacePackageManifest: { name: '@adea-ai/other' } },
    { workspacePackageManifest: { private: true } },
    { workspacePackageManifest: { version: '1.0.1' } },
    { workspacePackageManifest: { publishConfig: { access: 'restricted' } } },
    { workspacePackageManifest: { scripts: { prepack: 'node mutate.mjs' } } },
    { workspacePackageManifest: { scripts: { prepare: 'node mutate.mjs' } } },
    { workspacePackageManifest: { scripts: { prepublishOnly: 'bun run build' } } },
    { workspacePackageManifest: { scripts: { postpublish: 'node upload.mjs' } } },
    { workspacePackageManifest: { scripts: { preversion: 'node mutate.mjs' } } },
    { workspacePackageManifest: { scripts: { postbuild: 'node mutate.mjs' } } },
    { workspacePackageManifest: { scripts: { 'precn:build': 'node mutate.mjs' } } },
    { workspacePackageManifest: { scripts: { 'postcn:build': 'node mutate.mjs' } } },
    { workspacePackageManifest: { scripts: { build: 'bun run build && node extra.mjs' } } },
    { workspacePackageManifest: { scripts: { 'pack:check': 'npm pack --dry-run' } } },
    { releaseManifest: { '.': '0.9.9' } },
    { releaseConfigs: [{ ...adeaUiReleaseConfig(), 'extra-files': [] }] },
    {
      releaseConfigs: [
        {
          ...adeaUiReleaseConfig(),
          'extra-files': [
            ...adeaUiReleaseConfig()['extra-files'],
            { type: 'json', path: 'other.json', jsonpath: '$.version' },
          ],
        },
      ],
    },
    { releaseConfigs: [{ ...adeaUiReleaseConfig(), 'release-type': 'java' }] },
    { packageManager: 'npm' },
    {
      publisherWorkflowText: adeaUiPublisherWorkflow().replace(
        '--access public',
        '--access restricted'
      ),
    },
    { codeFoundryConfig: { release_qualification_receipts: 'false' } },
    { codeFoundryConfig: { npm_publish: 'true' } },
    { lockfileText: adeaUiLock('0.9.9') },
    { lockfileText: adeaUiLock('1.0.0').replace('packages/ui', 'packages/other') },
    {
      lockfileText: `${adeaUiLock('1.0.0').replace('\n  "packages"', ',\n    "duplicate": { "name": "@adea-ai/ui", "version": "1.0.0" }\n  },\n  "packages"')}`,
    },
    { lockfileText: '{ malformed lockfile' },
  ]
  for (const change of unsafe) {
    assert.equal(
      supportsAdeaUiWorkspaceReleaseContract({
        ...input,
        ...change,
        rootPackageManifest: {
          ...input.rootPackageManifest,
          ...change.rootPackageManifest,
        },
        workspacePackageManifest: {
          ...input.workspacePackageManifest,
          ...change.workspacePackageManifest,
          scripts: {
            ...input.workspacePackageManifest.scripts,
            ...change.workspacePackageManifest?.scripts,
          },
        },
        codeFoundryConfig: { ...input.codeFoundryConfig, ...change.codeFoundryConfig },
      }),
      false,
      `must reject workspace contract mutation: ${JSON.stringify(change)}`
    )
  }
})

test('Adea UI publisher qualification binds parsed, non-skippable jobs and executable steps', () => {
  const input = adeaUiContractInput()
  assert.equal(supportsAdeaUiWorkspaceReleaseContract(input), true)

  const mutations = [
    (workflow) => {
      workflow.jobs.publish.if = '${{ always() }}'
    },
    (workflow) => {
      workflow.jobs.publish.needs = workflow.jobs.publish.needs.filter(
        (name) => name !== 'packed-layout'
      )
    },
    (workflow) => {
      workflow.jobs.publish['continue-on-error'] = true
    },
    (workflow) => {
      workflow.jobs['packed-conversation'].if = '${{ always() }}'
    },
    (workflow) => {
      workflow.jobs['packed-layout']['continue-on-error'] = true
    },
    (workflow) => {
      workflow.jobs['packed-layout'].env.ADEA_PACKED_UI_TARBALL =
        '${{ github.workspace }}/decoy/package.tgz'
    },
    (workflow) => {
      workflow.jobs['packed-layout'].steps.splice(6, 0, {
        name: 'Replace verified archive',
        run: 'printf tampered > "$ADEA_PACKED_UI_TARBALL"',
      })
    },
    (workflow) => {
      workflow.jobs['packed-layout'].steps.splice(6, 0, {
        name: 'Install fake Bun',
        run: 'echo "$RUNNER_TEMP/fake-bin" >> "$GITHUB_PATH"',
      })
    },
    (workflow) => {
      workflow.jobs.prepare.steps.splice(11, 0, {
        name: 'Replace archive after verification',
        run: 'printf tampered > "$RUNNER_TEMP/prepared-ui/package.tgz"',
      })
    },
    (workflow) => {
      workflow.jobs['packed-layout'].steps.find((step) => step.name === 'Setup Bun').uses =
        'example/fake-setup-bun@v1'
    },
    (workflow) => {
      workflow.jobs['packed-layout'].steps.find((step) =>
        step.run?.includes('check:packed-layout')
      ).if = 'always()'
    },
    (workflow) => {
      workflow.jobs['packed-native-select'].needs = []
    },
    (workflow) => {
      workflow.jobs.prepare.if = 'false'
    },
    (workflow) => {
      workflow.jobs.publish.steps.find(
        (step) => step.name === 'Publish with npm trusted publishing'
      )['continue-on-error'] = true
    },
    (workflow) => {
      workflow.jobs.publish.steps.find(
        (step) => step.name === 'Publish with npm trusted publishing'
      ).run = 'echo no publish'
      workflow.jobs.decoy = {
        steps: [
          {
            run: 'npm publish "$RUNNER_TEMP/prepared-ui/package.tgz" --access public --provenance',
          },
        ],
      }
    },
    (workflow) => {
      workflow.jobs.publish.steps.find(
        (step) => step.name === 'Verify the exact release archive'
      ).run =
        String.raw`# if (manifest.name !== '@adea-ai/ui' || manifest.version !== process.env.EXPECTED_VERSION)
# if (sha256 !== process.env.EXPECTED_SHA256 || manifest.sha256 !== sha256)
# if (integrity !== process.env.EXPECTED_INTEGRITY || manifest.integrity !== integrity)`
    },
    (workflow) => {
      const verify = workflow.jobs.publish.steps.find(
        (step) => step.name === 'Verify the exact release archive'
      )
      verify.run = `exit 0\n${verify.run}`
    },
    (workflow) => {
      const verify = workflow.jobs.publish.steps.find(
        (step) => step.name === 'Verify the exact release archive'
      )
      verify.run = `if false; then\n${verify.run}\nfi`
    },
    (workflow) => {
      const publish = workflow.jobs.publish.steps
      const verifyIndex = publish.findIndex(
        (step) => step.name === 'Verify the exact release archive'
      )
      publish.splice(verifyIndex + 1, 0, {
        name: 'Replace verified package',
        run: 'printf tampered > "$RUNNER_TEMP/prepared-ui/package.tgz"',
      })
    },
  ]
  for (const mutate of mutations) {
    const publisher = adeaUiPublisherObject()
    mutate(publisher)
    assert.equal(
      supportsAdeaUiWorkspaceReleaseContract({
        ...input,
        publisherWorkflowText: adeaUiPublisherWorkflow(publisher),
      }),
      false,
      'an altered executable job or step must use full validation'
    )
  }

  const invalidPublisher = adeaUiPublisherObject()
  invalidPublisher.jobs.prepare.steps.find((step) => step.run === 'bun run pack:check').run =
    'echo skipped'
  const commentedDecoy = adeaUiPublisherWorkflow(invalidPublisher).concat(
    '\n# run: bun run pack:check\n# jobs:\n#   publish:\n#     needs: [prepare, packed-layout]\n'
  )
  assert.equal(
    supportsAdeaUiWorkspaceReleaseContract({ ...input, publisherWorkflowText: commentedDecoy }),
    false,
    'comments that resemble required jobs or commands cannot qualify the publisher'
  )
  assert.equal(
    supportsAdeaUiWorkspaceReleaseContract({
      ...input,
      publisherWorkflowText: `${adeaUiPublisherWorkflow()}\njobs:\n  publish:\n    if: always()\n`,
    }),
    false,
    'duplicate root mappings cannot shadow the checked publisher jobs'
  )
})

test('the Adea UI release comparison normalizes only the exact workspace version in bun.lock', () => {
  const paths = [
    '.release-please-manifest.json',
    'CHANGELOG.md',
    'bun.lock',
    'package.json',
    'packages/ui/package.json',
  ]
  const baseFiles = adeaUiReleaseFiles('1.0.0')
  const headFiles = adeaUiReleaseFiles('1.0.1')
  assert.equal(
    validateAdeaUiWorkspaceReleaseDiff({ baseFiles, headFiles, changedPaths: paths }).valid,
    true
  )

  const dependencyDrift = adeaUiReleaseFiles('1.0.1', '1.9.1')
  assert.equal(
    validateAdeaUiWorkspaceReleaseDiff({
      baseFiles,
      headFiles: dependencyDrift,
      changedPaths: paths,
    }).valid,
    false,
    'a dependency resolution change must not be normalized away'
  )
  assert.equal(
    validateAdeaUiWorkspaceReleaseDiff({
      baseFiles,
      headFiles,
      changedPaths: [...paths, 'packages/ui/src/index.ts'],
    }).valid,
    false,
    'source changes must use full validation'
  )
  assert.equal(
    validateAdeaUiWorkspaceReleaseDiff({
      baseFiles,
      headFiles,
      changedPaths: paths,
      modeChanges: ' mode change 100644 => 100755 packages/ui/package.json',
    }).valid,
    false,
    'file mode changes must use full validation'
  )

  const mismatchedPackage = adeaUiReleaseFiles('1.0.1')
  mismatchedPackage.set(
    'packages/ui/package.json',
    JSON.stringify({
      ...JSON.parse(mismatchedPackage.get('packages/ui/package.json')),
      version: '1.0.2',
    })
  )
  assert.equal(
    validateAdeaUiWorkspaceReleaseDiff({
      baseFiles,
      headFiles: mismatchedPackage,
      changedPaths: paths,
    }).valid,
    false,
    'root and publishable package versions must remain linked'
  )

  const staleLock = adeaUiReleaseFiles('1.0.1')
  staleLock.set('bun.lock', adeaUiLock('1.0.0'))
  assert.equal(
    validateAdeaUiWorkspaceReleaseDiff({ baseFiles, headFiles: staleLock, changedPaths: paths })
      .valid,
    false,
    'the lock workspace version must match the publishable package version'
  )
})

test('root release contract accepts only the fixed test-and-pack prepublish lifecycle', () => {
  const input = {
    packageManifest: {
      name: 'fixture-consumer',
      version: '1.0.0',
      packageManager: 'bun@1.4.4',
      scripts: {
        build: 'node --check src/cli.mjs',
        test: 'node --test',
        'test:unit': 'node --test',
        'pack:check': 'npm pack --dry-run',
        prepublishOnly: 'npm test && npm run pack:check',
      },
    },
    releaseManifest: { '.': '1.0.0' },
    releaseConfigs: [{ 'release-type': 'node' }],
    packageManager: 'bun',
  }
  assert.equal(supportsRootNpmReleaseContract(input), true)

  const unsafeScripts = [
    { prepublishOnly: 'npm test && npm run pack:check && node publish-extra.mjs' },
    { test: 'node publish-extra.mjs' },
    { 'test:unit': 'node publish-extra.mjs' },
    { 'pack:check': 'npm pack --dry-run && node upload.mjs' },
    { 'pack:check': 'npm pack' },
    { pretest: 'node mutate.mjs' },
    { posttest: 'node mutate.mjs' },
    { 'pretest:unit': 'node mutate.mjs' },
    { 'posttest:unit': 'node mutate.mjs' },
    { 'prepack:check': 'node mutate.mjs' },
    { 'postpack:check': 'node mutate.mjs' },
    { publish: 'node release-side-effect.mjs' },
    { postpublish: 'node release-side-effect.mjs' },
  ]
  for (const change of unsafeScripts) {
    assert.equal(
      supportsRootNpmReleaseContract({
        ...input,
        packageManifest: {
          ...input.packageManifest,
          scripts: { ...input.packageManifest.scripts, ...change },
        },
      }),
      false,
      `must reject lifecycle mutation: ${JSON.stringify(change)}`
    )
  }
})
