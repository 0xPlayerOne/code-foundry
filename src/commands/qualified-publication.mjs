#!/usr/bin/env node
// @ts-check
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

export const REQUIRED_NODES = ['24', '26']
export const REQUIRED_FIXTURES = [
  'npm-direct',
  'pnpm-direct',
  'yarn-staging',
  'bun-mise',
  'nested-rust',
  'nested-python',
]
/** @typedef {{ repository: string, tag: string, sourceSha: string, asset: string, directory: string }} Candidate */
/** @typedef {(command:string, args:string[], cwd?:string) => string} Run */
/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function ensure(condition, message) {
  if (!condition) throw new Error(message)
}
/** @type {Run} */
export function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' },
  })
  ensure(
    !result.error && result.status === 0,
    `${command} failed (${result.status ?? result.error?.message}); publication remains blocked`
  )
  return result.stdout
}

/** Default tolerant runner: GitHub CLI failures surface as retryable misses
 * instead of aborting the publication flow.
 * @param {string} command
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {{status: number, stdout: string}}
 */
function defaultRunTolerant(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' },
  })
  return { status: result.error ? 1 : (result.status ?? 1), stdout: result.stdout ?? '' }
}
/** @param {Candidate} candidate */
export function validateCandidate(candidate) {
  ensure(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate.repository) &&
      !candidate.repository.split('/').some((part) => ['.', '..'].includes(part)),
    'Expected an owner/repository'
  )
  ensure(
    /^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(candidate.tag),
    'Expected an explicit version tag'
  )
  ensure(/^[a-f0-9]{40}$/.test(candidate.sourceSha), 'Expected an exact source SHA')
  ensure(
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(candidate.asset),
    'Expected one exact tarball asset name'
  )
}
/** @param {string} file */
export function sha256(file) {
  ensure(
    lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(),
    'Expected a regular non-symlink file'
  )
  const bytes = readFileSync(file)
  ensure(bytes.length > 0, 'Empty artifact or report')
  return createHash('sha256').update(bytes).digest('hex')
}
/** Pure policy check. Only reports from this workflow run are accepted by the caller.
 * @param {unknown[]} reports @param {string} sourceSha @param {string} artifactSha256
 */
export function validateQualificationReports(reports, sourceSha, artifactSha256) {
  ensure(
    reports.length === REQUIRED_NODES.length,
    'Every required Node qualification report is mandatory'
  )
  const seen = new Set()
  for (const value of reports) {
    const report = /** @type {Record<string, any>} */ (value)
    ensure(
      report?.schema_version === 1 && report.complete === true && report.actionlint === true,
      'Incomplete or unlinted qualification report'
    )
    ensure(
      report.source_sha === sourceSha && report.artifact_sha256 === artifactSha256,
      'Qualification source or archive identity mismatch'
    )
    const node = /^v(\d+)\.\d+\.\d+$/.exec(report.node ?? '')?.[1]
    ensure(
      node && REQUIRED_NODES.includes(node) && !seen.has(node),
      'Unexpected or duplicate Node qualification'
    )
    seen.add(node)
    ensure(
      Array.isArray(report.fixtures) && report.fixtures.length === REQUIRED_FIXTURES.length,
      'Incomplete consumer fixture matrix'
    )
    for (const fixture of REQUIRED_FIXTURES)
      ensure(
        report.fixtures.filter(
          (/** @type {Record<string,any>} */ entry) =>
            entry.name === fixture && entry.status === 'passed'
        ).length === 1,
        `Missing successful fixture: ${fixture}`
      )
  }
  return {
    nodes: REQUIRED_NODES.filter((node) => seen.has(node)),
    fixtures: [...REQUIRED_FIXTURES],
  }
}
/** @param {Candidate} candidate */
async function verifier(candidate) {
  // Supplied by the separately reviewed release-integrity feature (#537).
  const { verifyRelease } = await import('./release-integrity.mjs')
  return verifyRelease({
    repository: candidate.repository,
    tag: candidate.tag,
    expectedSha: candidate.sourceSha,
    root: candidate.directory,
    assets: [candidate.asset],
  })
}
/** @typedef {(candidate:Candidate) => Promise<any>} Verify */
/** @param {Candidate} candidate @param {{run?:Run, verify?:Verify}} [adapters] */
export async function downloadVerifiedArchive(candidate, adapters = {}) {
  validateCandidate(candidate)
  const run = adapters.run ?? runCommand
  const verify = adapters.verify ?? verifier
  mkdirSync(candidate.directory, { recursive: true })
  ensure(
    lstatSync(candidate.directory).isDirectory() &&
      !lstatSync(candidate.directory).isSymbolicLink(),
    'Download directory must be a real directory'
  )
  ensure(readdirSync(candidate.directory).length === 0, 'Use a fresh empty download directory')
  run('gh', [
    'release',
    'download',
    candidate.tag,
    '--repo',
    candidate.repository,
    '--pattern',
    candidate.asset,
    '--dir',
    candidate.directory,
  ])
  ensure(
    readdirSync(candidate.directory).length === 1 &&
      readdirSync(candidate.directory)[0] === candidate.asset,
    'Unexpected downloaded release files'
  )
  const file = join(realpathSync(candidate.directory), candidate.asset)
  const digest = sha256(file)
  const identity = await verify(candidate)
  ensure(
    identity.status === 'passed' &&
      identity.immutable === true &&
      identity.sourceSha === candidate.sourceSha,
    'Release verification did not establish candidate identity'
  )
  ensure(
    identity.assets?.length === 1 && identity.assets[0].digest === `sha256:${digest}`,
    'Verified release asset differs from downloaded bytes'
  )
  ensure(sha256(file) === digest, 'Archive changed during verification')
  return { file, digest, identity }
}
/** @param {Candidate} candidate @param {string[]} reportPaths @param {Run} [run] */
export function qualifyArchive(candidate, reportPaths, run = runCommand) {
  validateCandidate(candidate)
  const file = join(realpathSync(candidate.directory), candidate.asset)
  const digest = sha256(file)
  const reports = reportPaths.map((path) => {
    sha256(path)
    return JSON.parse(readFileSync(path, 'utf8'))
  })
  const qualification = validateQualificationReports(reports, candidate.sourceSha, digest)
  // Read one manifest without extracting archive paths into the workspace.
  const manifest = JSON.parse(run('tar', ['-xOf', file, 'package/package.json']))
  ensure(
    manifest.name === 'code-foundry' && manifest.version === candidate.tag.slice(1),
    'Archive package identity does not match this Code Foundry release'
  )
  return {
    schemaVersion: 1,
    kind: 'code-foundry-publication-eligibility',
    repository: candidate.repository,
    tag: candidate.tag,
    sourceSha: candidate.sourceSha,
    asset: candidate.asset,
    digest: `sha256:${digest}`,
    qualification,
  }
}
/** @param {Candidate} candidate @param {string[]} reports @param {{run?:Run, verify?:Verify}} [adapters] */
export async function publishQualifiedArchive(candidate, reports, adapters = {}) {
  const run = adapters.run ?? runCommand
  const before = qualifyArchive(candidate, reports, run)
  const identity = await (adapters.verify ?? verifier)(candidate)
  ensure(
    identity.status === 'passed' &&
      identity.immutable === true &&
      identity.sourceSha === before.sourceSha &&
      identity.assets?.length === 1 &&
      identity.assets[0].digest === before.digest,
    'Current release verification does not match qualified bytes'
  )
  const file = join(realpathSync(candidate.directory), candidate.asset)
  ensure(`sha256:${sha256(file)}` === before.digest, 'Qualified archive changed before publication')
  // Never publish a directory, rebuild, or invoke package lifecycle hooks here.
  run(
    'npm',
    ['publish', file, '--ignore-scripts', '--provenance', '--access', 'public'],
    candidate.directory
  )
  ensure(`sha256:${sha256(file)}` === before.digest, 'Archive changed during publication')
  return { ...before, status: 'published' }
}

/** @typedef {(command:string, args:string[], cwd?:string) => {status: number, stdout: string}} RunTolerant */

/** Poll the releases-by-tag endpoint through its eventual-consistency window.
 * Immediately after `gh release edit --draft=false` the endpoint can still
 * return 404; a strict verification in that window aborts an otherwise
 * healthy publication. Bounded retries keep the flow strict: it only proceeds
 * once the endpoint serves the published release with the exact tag.
 * @param {Candidate} candidate
 * @param {{runTolerant?: RunTolerant, delay?: (ms:number)=>Promise<void>, attempts?: number}} [adapters]
 * @returns {Promise<Record<string, any>>}
 */
async function waitForPublishedRelease(candidate, adapters = {}) {
  const runTolerant = adapters.runTolerant ?? defaultRunTolerant
  const delay = adapters.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const attempts = adapters.attempts ?? 15
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = runTolerant('gh', [
      'api',
      '--hostname',
      'github.com',
      `repos/${candidate.repository}/releases/tags/${encodeURIComponent(candidate.tag)}`,
    ])
    if (result.status === 0) {
      /** @type {Record<string, any> | null} */
      let release = null
      try {
        release = JSON.parse(result.stdout)
      } catch {
        release = null
      }
      if (release?.draft === false && release?.tag_name === candidate.tag) return release
    }
    if (attempt === attempts) break
    await delay(2_000)
  }
  throw new Error(
    'The published release was not retrievable via the tag endpoint within the consistency window'
  )
}

/** Stage only a previously-created draft: never move tags, overwrite assets, or
 * treat an API/permissions failure as an absent release. Authentication needs
 * immutable-settings read and release write; no setting is mutated.
 * @param {Candidate} candidate @param {string[]} reports @param {{run?:Run, runTolerant?:RunTolerant, delay?:(ms:number)=>Promise<void>, attempts?:number, verify?:Verify}} [adapters]
 */
export async function stageQualifiedRelease(candidate, reports, adapters = {}) {
  const run = adapters.run ?? runCommand
  const qualification = qualifyArchive(candidate, reports, run)
  const api = (/** @type {string} */ endpoint) =>
    JSON.parse(run('gh', ['api', '--hostname', 'github.com', endpoint]))
  const prefix = `repos/${candidate.repository}`
  ensure(
    api(`${prefix}/immutable-releases`).enabled === true,
    'Release immutability is not confirmed enabled; no release write performed'
  )
  const checkTag = () => {
    let object = api(`${prefix}/git/ref/tags/${encodeURIComponent(candidate.tag)}`).object
    for (let depth = 0; object?.type === 'tag' && depth < 8; depth++) {
      ensure(/^[a-f0-9]{40}$/.test(object.sha ?? ''), 'Invalid annotated tag')
      object = api(`${prefix}/git/tags/${object.sha}`).object
    }
    ensure(
      object?.type === 'commit' && object.sha === candidate.sourceSha,
      'Release tag does not identify the qualified commit'
    )
  }
  checkTag()
  const listEndpoint = `${prefix}/releases?per_page=100`
  const findDraftRelease = () => {
    const pages = JSON.parse(
      run('gh', ['api', '--hostname', 'github.com', '--paginate', '--slurp', listEndpoint])
    )
    ensure(
      Array.isArray(pages) && pages.every((page) => Array.isArray(page)),
      'GitHub returned an invalid release list'
    )
    const release = pages.flat().find((entry) => entry?.tag_name === candidate.tag)
    ensure(
      Number.isSafeInteger(release?.id) &&
        release.draft === true &&
        release.tag_name === candidate.tag &&
        Array.isArray(release.assets),
      'An existing draft release with the exact tag is required'
    )
    return release
  }
  // GitHub's get-by-tag endpoint does not return draft releases. Enumerate the
  // authenticated release list instead, including all pages, before any write.
  const release = findDraftRelease()
  const temporary = mkdtempSync(join(tmpdir(), 'foundry-release-receipt-'))
  try {
    const receipt = join(temporary, 'qualification.json')
    writeFileSync(receipt, JSON.stringify(qualification, null, 2) + '\n')
    const files = [join(realpathSync(candidate.directory), candidate.asset), receipt]
    const expected = [qualification.digest, `sha256:${sha256(receipt)}`]
    const names = [candidate.asset, 'qualification.json']
    for (let index = 0; index < files.length; index++) {
      const existing = release.assets.filter(
        (/** @type {Record<string, any>} */ asset) => asset.name === names[index]
      )
      ensure(existing.length <= 1, 'Ambiguous existing release asset')
      if (existing.length)
        ensure(
          existing[0].state === 'uploaded' && existing[0].digest === expected[index],
          'Existing draft asset differs; refusing to overwrite it'
        )
      else
        run('gh', [
          'release',
          'upload',
          candidate.tag,
          files[index],
          '--repo',
          candidate.repository,
        ])
    }
    const uploaded = findDraftRelease()
    ensure(
      uploaded.id === release.id && uploaded.draft === true && uploaded.tag_name === candidate.tag,
      'Draft changed during staging'
    )
    for (let index = 0; index < names.length; index++) {
      const assets =
        uploaded.assets?.filter(
          (/** @type {Record<string, any>} */ asset) => asset.name === names[index]
        ) ?? []
      ensure(
        assets.length === 1 &&
          assets[0].state === 'uploaded' &&
          assets[0].digest === expected[index],
        'Uploaded release asset digest mismatch'
      )
      ensure(
        `sha256:${sha256(files[index])}` === expected[index],
        'Local asset changed during staging'
      )
    }
    checkTag()
    run('gh', [
      'release',
      'edit',
      candidate.tag,
      '--draft=false',
      '--verify-tag',
      '--repo',
      candidate.repository,
    ])
    // GitHub's release index is eventually consistent right after a draft is
    // published; a strict verification a second later can observe a 404 and
    // abort the publication even though the release is live. Poll until the
    // index serves the release, then verify; the verification cycle itself
    // retries through the same window and still fails closed in the end.
    await waitForPublishedRelease(candidate, {
      runTolerant: adapters.runTolerant,
      delay: adapters.delay,
      attempts: 10,
    })
    /** @type {Record<string, any>} */
    let identity
    for (let attempt = 1; ; attempt += 1) {
      try {
        identity = await (adapters.verify ?? verifier)(candidate)
        break
      } catch (error) {
        if (attempt >= 10) throw error
        await (adapters.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(5_000)
      }
    }
    ensure(
      identity.status === 'passed' &&
        identity.immutable === true &&
        identity.sourceSha === qualification.sourceSha &&
        identity.assets?.length === 1 &&
        identity.assets[0].digest === qualification.digest,
      'Published release verification failed; npm remains blocked'
    )
    return { ...qualification, status: 'release-published-and-verified' }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [command, repository, tag, sourceSha, asset, directory, ...reports] =
      process.argv.slice(2)
    if (!directory || !['download', 'qualify', 'stage', 'publish'].includes(command))
      throw new Error(
        'Usage: qualified-publication.mjs download|qualify|stage|publish REPO TAG SOURCE_SHA ASSET DIRECTORY [REPORT.json ...]'
      )
    const candidate = { repository, tag, sourceSha, asset, directory: resolve(directory) }
    if (command === 'download' && reports.length)
      throw new Error('download does not take report paths')
    const result =
      command === 'download'
        ? await downloadVerifiedArchive(candidate)
        : command === 'qualify'
          ? qualifyArchive(candidate, reports)
          : command === 'stage'
            ? await stageQualifiedRelease(candidate, reports)
            : await publishQualifiedArchive(candidate, reports)
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
