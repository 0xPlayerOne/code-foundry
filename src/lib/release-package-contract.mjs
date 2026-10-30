// @ts-check

import { lockedWorkspaces } from './bun-lock.mjs'

/** @param {unknown} value @returns {value is Record<string, any>} */
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const TOP_LEVEL_RELEASE_CONFIG_KEYS = new Set([
  '$schema',
  'bump-minor-pre-major',
  'changelog-sections',
  'extra-files',
  'group-pull-request-title-pattern',
  'include-component-in-tag',
  'manifest-file',
  'packages',
  'pull-request-title-pattern',
  'release-type',
])

const ROOT_PACKAGE_CONFIG_KEYS = new Set([
  'draft',
  'force-tag-creation',
  'include-component-in-tag',
  'manifest-file',
  'package-name',
  'release-type',
])

// npm can run these hooks around the exact test, pack-check, or publish path.
// Keep release-time side effects outside the narrow receipt contract too.
const UNSUPPORTED_TEST_AND_PACK_HOOKS = [
  'pretest',
  'posttest',
  'pretest:unit',
  'posttest:unit',
  'prepack:check',
  'postpack:check',
  'publish',
  'postpublish',
]

/**
 * This contract deliberately names one application-owned package layout. It
 * does not relax the public-root contract for arbitrary private roots or
 * workspaces.
 */
const ADEA_UI_ROOT_NAME = 'adea-ui'
const ADEA_UI_PACKAGE_NAME = '@adea-ai/ui'
const ADEA_UI_PACKAGE_PATH = 'packages/ui'
const ADEA_UI_WORKSPACES = ['apps/*', 'packages/*']
const ADEA_UI_RELEASE_PATHS = [
  '.release-please-manifest.json',
  'CHANGELOG.md',
  'bun.lock',
  'package.json',
  'packages/ui/package.json',
]
const ADEA_UI_LIFECYCLE_HOOKS = [
  'preinstall',
  'install',
  'postinstall',
  'preversion',
  'version',
  'postversion',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
  'prebuild',
  'postbuild',
  'precn:build',
  'postcn:build',
  'prepack',
  'postpack',
  'prepublishOnly',
  'publish',
  'postpublish',
  'pretest',
  'posttest',
  'pretest:unit',
  'posttest:unit',
  'prepack:check',
  'postpack:check',
]

const ADEA_UI_BUILD_SCRIPT =
  'bun run cn:build && vite build && tsc -p tsconfig.json --emitDeclarationOnly'
const ADEA_UI_PACK_CHECK_SCRIPT = 'bun scripts/check-pack.ts && bun scripts/check-lib-exports.ts'
const ADEA_UI_ROOT_PACK_CHECK_SCRIPT = 'bun run --cwd packages/ui pack:check'

/** @param {unknown} value @returns {value is string} */
function semver(value) {
  return (
    typeof value === 'string' &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
  )
}

/** @param {unknown} value @returns {Record<string, any>|null} */
function jsonObject(value) {
  return object(value) ? value : null
}

/** @param {unknown} value */
function hasUnsafeLifecycle(value) {
  const scripts = jsonObject(value)
  if (!scripts) return value !== undefined
  return ADEA_UI_LIFECYCLE_HOOKS.some((hook) => Object.hasOwn(scripts, hook))
}

/** @param {unknown} configs */
function hasExactAdeaUiReleaseConfig(configs) {
  if (!Array.isArray(configs) || configs.length !== 1) return false
  const [config] = configs
  if (!object(config) || Object.keys(config).some((key) => !TOP_LEVEL_RELEASE_CONFIG_KEYS.has(key)))
    return false
  if (
    (config['release-type'] !== undefined && config['release-type'] !== 'node') ||
    config['include-component-in-tag'] !== false ||
    (config['manifest-file'] !== undefined &&
      config['manifest-file'] !== '.release-please-manifest.json') ||
    !Array.isArray(config['extra-files']) ||
    config['extra-files'].length !== 1
  ) {
    return false
  }
  const [extraFile] = config['extra-files']
  if (
    !object(extraFile) ||
    Object.keys(extraFile).length !== 3 ||
    extraFile.type !== 'json' ||
    extraFile.path !== 'packages/ui/package.json' ||
    extraFile.jsonpath !== '$.version'
  ) {
    return false
  }
  const packages = config.packages
  if (!object(packages) || Object.keys(packages).join('\n') !== '.') return false
  const rootConfig = packages['.']
  return (
    object(rootConfig) &&
    Object.keys(rootConfig).every((key) => ROOT_PACKAGE_CONFIG_KEYS.has(key)) &&
    rootConfig['package-name'] === ADEA_UI_PACKAGE_NAME &&
    rootConfig['release-type'] === 'node' &&
    (rootConfig['manifest-file'] === undefined ||
      rootConfig['manifest-file'] === '.release-please-manifest.json') &&
    rootConfig['extra-files'] === undefined
  )
}

/** @param {string} lockText @param {string} expectedVersion */
function normalizeAdeaUiLockVersion(lockText, expectedVersion) {
  if (
    (lockText.match(/"packages\/ui"\s*:/g) ?? []).length !== 1 ||
    (lockText.match(/"name"\s*:\s*"@adea-ai\/ui"/g) ?? []).length !== 1
  ) {
    return null
  }
  const candidates = lockedWorkspaces(lockText).filter(
    (workspace) =>
      workspace.path === ADEA_UI_PACKAGE_PATH || workspace.name === ADEA_UI_PACKAGE_NAME
  )
  if (
    candidates.length !== 1 ||
    candidates[0].path !== ADEA_UI_PACKAGE_PATH ||
    candidates[0].name !== ADEA_UI_PACKAGE_NAME ||
    candidates[0].version !== expectedVersion
  ) {
    return null
  }
  const lines = lockText.split(/\r?\n/)
  const line = lines[candidates[0].line]
  const versionMatch = /^(\s*"version": ")([^"]+)(".*)$/.exec(line)
  if (!versionMatch || !semver(versionMatch[2])) return null
  lines[candidates[0].line] = `${versionMatch[1]}<workspace-version>${versionMatch[3]}`
  return lines.join(lockText.includes('\r\n') ? '\r\n' : '\n')
}

/**
 * @param {{rootPackageManifest:unknown, workspacePackageManifest:unknown, releaseManifest:unknown, releaseConfigs:unknown[], packageManager?:unknown, codeFoundryConfig:unknown, lockfileText:string|null, publisherWorkflowText:string|null}} input
 */
export function supportsAdeaUiWorkspaceReleaseContract(input) {
  const {
    rootPackageManifest,
    workspacePackageManifest,
    releaseManifest,
    releaseConfigs,
    packageManager,
    codeFoundryConfig,
    lockfileText,
    publisherWorkflowText,
  } = input
  const root = jsonObject(rootPackageManifest)
  const workspace = jsonObject(workspacePackageManifest)
  const manifest = jsonObject(releaseManifest)
  const foundry = jsonObject(codeFoundryConfig)
  const rootScripts = jsonObject(root?.scripts)
  const workspaceScripts = jsonObject(workspace?.scripts)
  if (
    !root ||
    !workspace ||
    !manifest ||
    !foundry ||
    !rootScripts ||
    !workspaceScripts ||
    !semver(root.version) ||
    !semver(workspace.version) ||
    root.name !== ADEA_UI_ROOT_NAME ||
    root.private !== true ||
    JSON.stringify(root.workspaces) !== JSON.stringify(ADEA_UI_WORKSPACES) ||
    root.version !== workspace.version ||
    workspace.name !== ADEA_UI_PACKAGE_NAME ||
    workspace.private === true ||
    (workspace.publishConfig?.access !== undefined &&
      workspace.publishConfig.access !== 'public') ||
    root.packageManager !== 'bun@1.4.4' ||
    packageManager !== 'bun' ||
    root.scripts['pack:check'] !== ADEA_UI_ROOT_PACK_CHECK_SCRIPT ||
    workspaceScripts.build !== ADEA_UI_BUILD_SCRIPT ||
    workspaceScripts['pack:check'] !== ADEA_UI_PACK_CHECK_SCRIPT ||
    manifest['.'] !== root.version ||
    Object.keys(manifest).join('\n') !== '.' ||
    foundry.release_qualification_receipts !== 'true' ||
    foundry.npm_publish !== 'false' ||
    hasUnsafeLifecycle(root.scripts) ||
    hasUnsafeLifecycle(workspace.scripts) ||
    !hasExactAdeaUiReleaseConfig(releaseConfigs) ||
    typeof lockfileText !== 'string' ||
    !hasQualifiedAdeaUiPublisher(publisherWorkflowText) ||
    normalizeAdeaUiLockVersion(lockfileText, workspace.version) === null
  ) {
    return false
  }
  return true
}

/** @param {unknown} value */
function hasQualifiedAdeaUiPublisher(value) {
  if (typeof value !== 'string') return false
  const workflow = parseUiPublisherWorkflow(value)
  if (!workflow) return false
  if (!object(workflow) || !object(workflow.on) || !object(workflow.jobs)) return false

  const trigger = workflow.on
  if (
    Object.keys(trigger).toSorted().join('\n') !== 'push\nworkflow_dispatch' ||
    !object(trigger.push) ||
    !Array.isArray(trigger.push.tags) ||
    trigger.push.tags.length !== 1 ||
    trigger.push.tags[0] !== 'v*' ||
    !object(trigger.workflow_dispatch) ||
    !object(trigger.workflow_dispatch.inputs) ||
    !object(trigger.workflow_dispatch.inputs['dry-run']) ||
    trigger.workflow_dispatch.inputs['dry-run'].type !== 'boolean' ||
    trigger.workflow_dispatch.inputs['dry-run'].default !== true
  ) {
    return false
  }

  const jobs = workflow.jobs
  const requiredConsumers = [
    'packed-conversation',
    'packed-layout',
    'packed-layout-renderer',
    'packed-appearance',
    'packed-modal-dialog',
    'packed-native-select',
  ]
  const publishNeeds = ['prepare', ...requiredConsumers]
  if (!sameStringSet(Object.keys(jobs), [...publishNeeds, 'publish'])) return false
  const prepare = jobs.prepare
  const publish = jobs.publish
  if (!safeRequiredJob(prepare) || !safeRequiredJob(publish, true)) {
    return false
  }
  if (!hasQualifiedAdeaUiPrepare(prepare)) return false

  for (const [jobName, script] of Object.entries(ADEA_UI_PACKED_CONSUMER_SCRIPTS)) {
    const job = jobs[jobName]
    if (!hasQualifiedAdeaUiConsumer(job, jobName, script)) return false
  }

  if (
    publish.if !== '${{ inputs.dry-run != true }}' ||
    publish.name !== 'Publish @adea-ai/ui' ||
    publish['runs-on'] !== 'ubuntu-latest' ||
    publish['timeout-minutes'] !== 15 ||
    publish.env !== undefined ||
    publish.container !== undefined ||
    publish.outputs !== undefined ||
    !sameStringSet(needs(publish), publishNeeds) ||
    !exactMap(publish.permissions, { contents: 'read', 'id-token': 'write' })
  ) {
    return false
  }

  const publishSteps = steps(publish)
  const [checkout, setupNode, pinNpm, download, verify, publishArchive, confirm] = publishSteps
  const allSteps = Object.values(jobs).flatMap((job) => (object(job) ? steps(job) : []))
  const publishCommands = allSteps.flatMap((step) =>
    typeof step.run === 'string' ? (step.run.match(/^\s*npm publish\b.*$/gm) ?? []) : []
  )
  const validPublish =
    publishSteps.length === 7 &&
    publishSteps.every(safeRequiredStep) &&
    exactStepKeys(checkout, ['name', 'uses', 'with']) &&
    checkout.name === 'Checkout' &&
    checkout.uses === 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' &&
    object(checkout.with) &&
    Object.keys(checkout.with).length === 1 &&
    checkout.with['persist-credentials'] === false &&
    exactStepKeys(setupNode, ['name', 'uses', 'with']) &&
    setupNode.name === 'Setup Node' &&
    setupNode.uses === 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020' &&
    object(setupNode.with) &&
    setupNode.with['node-version'] === 24 &&
    setupNode.with['registry-url'] === 'https://registry.npmjs.org' &&
    Object.keys(setupNode.with).length === 2 &&
    exactStepKeys(pinNpm, ['name', 'run']) &&
    pinNpm.name === 'Pin an npm that can do trusted publishing' &&
    exactScript(pinNpm.run, ADEA_UI_PIN_NPM_SCRIPT) &&
    exactStepKeys(download, ['name', 'uses', 'with']) &&
    download.name === 'Download the verified UI package' &&
    download.uses === 'actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131' &&
    object(download.with) &&
    download.with.name === 'prepared-ui-package' &&
    download.with.path === '${{ runner.temp }}/prepared-ui/' &&
    Object.keys(download.with).length === 2 &&
    exactStepKeys(verify, ['name', 'env', 'run']) &&
    verify.name === 'Verify the exact release archive' &&
    object(verify.env) &&
    verify.env.EXPECTED_VERSION === '${{ needs.prepare.outputs.version }}' &&
    verify.env.EXPECTED_SHA256 === '${{ needs.prepare.outputs.archive_sha256 }}' &&
    verify.env.EXPECTED_INTEGRITY === '${{ needs.prepare.outputs.archive_integrity }}' &&
    Object.keys(verify.env).length === 3 &&
    exactScript(verify.run, ADEA_UI_PUBLISH_VERIFY_SCRIPT) &&
    exactStepKeys(publishArchive, ['name', 'run']) &&
    publishArchive.name === 'Publish with npm trusted publishing' &&
    publishArchive.run ===
      'npm publish "$RUNNER_TEMP/prepared-ui/package.tgz" --access public --provenance' &&
    exactStepKeys(confirm, ['name', 'env', 'run']) &&
    confirm.name === 'Confirm the release is what consumers get' &&
    object(confirm.env) &&
    confirm.env.VERSION === '${{ needs.prepare.outputs.version }}' &&
    Object.keys(confirm.env).length === 1 &&
    exactScript(confirm.run, ADEA_UI_CONFIRM_RELEASE_SCRIPT) &&
    publishCommands.length === 1 &&
    publishCommands[0].trim() === publishArchive.run
  return validPublish
}

/**
 * Parse only the workflow subset used by the checked-in UI publisher. This is
 * intentionally not a general YAML parser: ambiguous YAML features (aliases,
 * flow mappings, tabs, duplicate keys, and unsupported indentation) fail
 * closed, so this contract cannot be satisfied by matching comments or text
 * in an unrelated job.
 * @param {string} source
 */
function parseUiPublisherWorkflow(source) {
  if (/\t|^[ ]*(?:&|\*|<<:|!!)/m.test(source)) return null
  const lines = source.split(/\r?\n/)
  const meaningful = lines.map((line) => (line.trimStart().startsWith('#') ? '' : line))
  if (meaningful.filter((line) => line === 'on:').length !== 1) return null
  if (meaningful.filter((line) => line === 'jobs:').length !== 1) return null
  const onIndex = meaningful.findIndex((line) => line === 'on:')
  const jobsIndex = meaningful.findIndex((line) => line === 'jobs:')
  if (onIndex < 0 || jobsIndex < 0 || onIndex >= jobsIndex) return null
  const onLines = meaningful.slice(onIndex + 1, jobsIndex)
  const eventKeys = onLines
    .filter((line) => /^  [A-Za-z0-9_-]+:\s*$/.test(line))
    .map((line) => line.trim().slice(0, -1))
  if (
    eventKeys.length !== 2 ||
    new Set(eventKeys).size !== 2 ||
    !eventKeys.includes('push') ||
    !eventKeys.includes('workflow_dispatch') ||
    !hasIndentedSequence(onLines, '    tags:', 'v*') ||
    !hasExactYamlScalar(onLines, '        type:', 'boolean') ||
    !hasExactYamlScalar(onLines, '        default:', 'true') ||
    !onLines.some((line) => line === '      dry-run:') ||
    !onLines.some((line) => line === '    inputs:')
  ) {
    return null
  }

  /** @type {{ index: number, name: string }[]} */
  const jobStarts = []
  for (let index = jobsIndex + 1; index < meaningful.length; index += 1) {
    const match = /^  ([A-Za-z0-9_-]+):\s*$/.exec(meaningful[index])
    if (match) jobStarts.push({ index, name: match[1] })
    else if (meaningful[index] && !/^\s/.test(meaningful[index])) break
  }
  if (jobStarts.length === 0 || new Set(jobStarts.map((job) => job.name)).size !== jobStarts.length)
    return null

  /** @type {Record<string, any>} */
  const jobs = {}
  for (let index = 0; index < jobStarts.length; index += 1) {
    const start = jobStarts[index]
    const end = jobStarts[index + 1]?.index ?? meaningful.length
    const block = meaningful.slice(start.index + 1, end)
    const job = parseWorkflowJob(block)
    if (!job) return null
    jobs[start.name] = job
  }
  return {
    on: {
      push: { tags: ['v*'] },
      workflow_dispatch: { inputs: { 'dry-run': { type: 'boolean', default: true } } },
    },
    jobs,
  }
}

/** @param {string[]} lines @param {string} key @param {string} expected */
function hasExactYamlScalar(lines, key, expected) {
  return (
    lines.filter((line) => line.startsWith(key)).length === 1 &&
    lines.some((line) => line === `${key} ${expected}`)
  )
}

/** @param {string[]} lines @param {string} header @param {string} expected */
function hasIndentedSequence(lines, header, expected) {
  const at = lines.indexOf(header)
  if (at < 0) return false
  let end = at + 1
  while (end < lines.length && (/^\s*- /.test(lines[end]) || lines[end] === '')) end += 1
  const values = lines.slice(at + 1, end).filter((line) => line !== '')
  return values.length === 1 && values[0] === `      - '${expected}'`
}

/** @param {string[]} block */
function parseWorkflowJob(block) {
  const supportedKeys = new Set([
    'name',
    'needs',
    'runs-on',
    'timeout-minutes',
    'if',
    'continue-on-error',
    'outputs',
    'permissions',
    'env',
    'container',
    'steps',
  ])
  const directKeys = block
    .map((line) => /^    ([A-Za-z0-9_-]+):/.exec(line)?.[1])
    .filter((key) => key !== undefined)
  if (
    directKeys.length !== new Set(directKeys).size ||
    directKeys.some((key) => !supportedKeys.has(key))
  ) {
    return null
  }
  const scalarKeys = ['name', 'runs-on', 'timeout-minutes', 'if', 'continue-on-error']
  /** @type {Record<string, any>} */
  const job = {}
  for (const key of scalarKeys) {
    const values = block.filter((line) => new RegExp(`^    ${key}:`).test(line))
    if (values.length > 1) return null
    if (values.length === 1) {
      const value = parseWorkflowScalar(values[0].slice(values[0].indexOf(':') + 1))
      if (value === INVALID_YAML_SCALAR) return null
      job[key] = value
    }
  }

  const needsLine = block.filter((line) => line.startsWith('    needs:'))
  if (needsLine.length > 1) return null
  if (needsLine.length === 1) {
    const raw = needsLine[0].slice(needsLine[0].indexOf(':') + 1).trim()
    if (raw) {
      const value = parseWorkflowScalar(raw)
      if (typeof value !== 'string') return null
      job.needs = value
    } else {
      const at = block.indexOf(needsLine[0])
      const values = []
      for (const line of block.slice(at + 1)) {
        if (line && !line.startsWith('      ')) break
        const item = /^      - (.+)$/.exec(line)
        if (item) values.push(parseWorkflowScalar(item[1]))
      }
      if (!values.every((value) => typeof value === 'string')) return null
      job.needs = values
    }
  }

  for (const key of ['outputs', 'permissions', 'env', 'container']) {
    const parsed = parseJobMapping(block, key)
    if (parsed === null) return null
    if (parsed !== undefined) job[key] = parsed
  }
  const parsedSteps = parseWorkflowSteps(block)
  if (parsedSteps === null) return null
  if (parsedSteps !== undefined) job.steps = parsedSteps
  return job
}

/** @param {string[]} block @param {string} key */
function parseJobMapping(block, key) {
  const headers = block
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line === `    ${key}:`)
  if (headers.length > 1) return null
  if (headers.length === 0) return undefined
  /** @type {Record<string, any>} */
  const result = {}
  for (const line of block.slice(headers[0].index + 1)) {
    if (line && !line.startsWith('      ')) break
    const child = /^      ([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!child) continue
    if (Object.hasOwn(result, child[1])) return null
    const value = parseWorkflowScalar(child[2])
    if (value === INVALID_YAML_SCALAR) return null
    result[child[1]] = value
  }
  return result
}

/** @param {string[]} block */
function parseWorkflowSteps(block) {
  const headerIndexes = block
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line === '    steps:')
    .map(({ index }) => index)
  if (headerIndexes.length > 1) return null
  if (headerIndexes.length === 0) return undefined
  const start = headerIndexes[0] + 1
  /** @type {number[]} */
  const starts = []
  for (let index = start; index < block.length; index += 1) {
    if (block[index].startsWith('      - ')) starts.push(index)
    else if (block[index] && !/^\s/.test(block[index])) return null
  }
  /** @type {(Record<string, any> | null)[]} */
  const parsed = starts.map((stepStart, index) =>
    parseWorkflowStep(block.slice(stepStart, starts[index + 1] ?? block.length))
  )
  return parsed.some((step) => step === null) ? null : parsed
}

/** @param {string[]} lines */
function parseWorkflowStep(lines) {
  const first = /^      - ([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[0])
  if (!first) return null
  /** @type {Record<string, any>} */
  const step = {}
  const entries = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = index === 0 ? `        ${first[1]}: ${first[2]}` : lines[index]
    const entry = /^        ([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line)
    if (!entry) continue
    entries.push({ key: entry[1], raw: entry[2] ?? '', lineIndex: index })
  }
  for (const entry of entries) {
    if (Object.hasOwn(step, entry.key)) return null
    const raw = entry.raw.trim()
    if (entry.key === 'run' && (raw === '|' || raw === '|-')) {
      const body = []
      for (let index = entry.lineIndex + 1; index < lines.length; index += 1) {
        const line = lines[index]
        if (line && !line.startsWith('          ')) break
        body.push(line === '' ? '' : line.slice(10))
      }
      step.run = body.join('\n')
      continue
    }
    if (entry.key === 'with' || entry.key === 'env') {
      /** @type {Record<string, any>} */
      const mapping = {}
      for (let index = entry.lineIndex + 1; index < lines.length; index += 1) {
        const child = /^          ([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[index])
        if (child) {
          if (Object.hasOwn(mapping, child[1])) return null
          mapping[child[1]] = parseWorkflowScalar(child[2])
        }
      }
      step[entry.key] = mapping
      continue
    }
    const parsed = parseWorkflowScalar(raw)
    if (parsed === INVALID_YAML_SCALAR) return null
    step[entry.key] = parsed
  }
  return step
}

const INVALID_YAML_SCALAR = Symbol('invalid-yaml-scalar')

/** @param {string} raw */
function parseWorkflowScalar(raw) {
  const value = raw.trim()
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^(?:0|[1-9]\d*)$/.test(value)) return Number(value)
  if (value === '' || value === 'null' || value === '~') return INVALID_YAML_SCALAR
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return INVALID_YAML_SCALAR
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) return INVALID_YAML_SCALAR
    return value.slice(1, -1).replaceAll("''", "'")
  }
  if (/\s+#/.test(value)) return value.split(/\s+#/, 1)[0]
  return value
}

const ADEA_UI_PACKED_CONSUMER_SCRIPTS = {
  'packed-conversation': 'bun run check:packed-conversation',
  'packed-layout': 'bun run check:packed-layout && bun run check:packed-settings-navigation',
  'packed-layout-renderer': 'bun run check:packed-layout-renderer',
  'packed-appearance': 'bun run check:packed-appearance',
  'packed-modal-dialog': 'bun run check:packed-modal-dialog',
  'packed-native-select': 'bun run check:packed-native-select',
}

/** @param {unknown} job @returns {job is Record<string, any>} */
function hasQualifiedAdeaUiPrepare(job) {
  if (
    !safeRequiredJob(job) ||
    job.needs !== undefined ||
    job.name !== 'Prepare @adea-ai/ui' ||
    job['runs-on'] !== 'ubuntu-latest' ||
    job['timeout-minutes'] !== 15 ||
    job.env !== undefined ||
    job.container !== undefined ||
    !exactMap(job.permissions, { contents: 'read' }) ||
    !exactMap(job.outputs, {
      version: '${{ steps.version.outputs.version }}',
      archive_sha256: '${{ steps.archive.outputs.sha256 }}',
      archive_integrity: '${{ steps.archive.outputs.integrity }}',
    })
  ) {
    return false
  }

  const items = steps(job)
  if (items.length !== 13) return false
  const [
    checkout,
    setupBun,
    setupNode,
    install,
    browserPolicy,
    build,
    version,
    alreadyPublished,
    packCheck,
    pack,
    consumers,
    pasteModel,
    upload,
  ] = items
  return (
    items.every((step, index) => index === 7 || safeRequiredStep(step)) &&
    exactStepKeys(checkout, ['name', 'uses', 'with']) &&
    checkout.name === 'Checkout' &&
    checkout.uses === 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' &&
    exactMap(checkout.with, { 'persist-credentials': false }) &&
    exactStepKeys(setupBun, ['name', 'uses', 'with']) &&
    setupBun.name === 'Setup Bun' &&
    setupBun.uses === 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6' &&
    exactMap(setupBun.with, { 'bun-version': '1.4.4', 'no-cache': true }) &&
    exactStepKeys(setupNode, ['name', 'uses', 'with']) &&
    setupNode.name === 'Setup Node' &&
    setupNode.uses === 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020' &&
    exactMap(setupNode.with, {
      'node-version': 24,
      'registry-url': 'https://registry.npmjs.org',
    }) &&
    exactStepKeys(install, ['name', 'run']) &&
    install.name === 'Install dependencies' &&
    install.run === 'bun install --frozen-lockfile' &&
    exactStepKeys(browserPolicy, ['name', 'run']) &&
    browserPolicy.name === 'Verify packed browser runtime policy' &&
    browserPolicy.run === 'bun test ./.github/scripts/check-playwright-runtime.test.ts' &&
    exactStepKeys(build, ['name', 'run']) &&
    build.name === 'Build the library' &&
    build.run === 'bun run --cwd packages/ui build' &&
    exactStepKeys(version, ['name', 'id', 'working-directory', 'run']) &&
    version.name === 'Read the version to publish' &&
    version.id === 'version' &&
    version['working-directory'] === 'packages/ui' &&
    version.run ===
      `echo "version=$(node -p "require('./package.json').version")" >> "$GITHUB_OUTPUT"` &&
    exactStepKeys(alreadyPublished, ['name', 'if', 'env', 'run']) &&
    alreadyPublished.name === 'Refuse to publish a version that already exists' &&
    alreadyPublished.if === '${{ inputs.dry-run != true }}' &&
    exactMap(alreadyPublished.env, { VERSION: '${{ steps.version.outputs.version }}' }) &&
    exactScript(alreadyPublished.run, ADEA_UI_REFUSE_EXISTING_SCRIPT) &&
    exactStepKeys(packCheck, ['name', 'working-directory', 'run']) &&
    packCheck.name === 'Verify the publishable archive' &&
    packCheck['working-directory'] === 'packages/ui' &&
    packCheck.run === 'bun run pack:check' &&
    exactStepKeys(pack, ['name', 'id', 'working-directory', 'run']) &&
    pack.name === 'Pack one immutable UI archive' &&
    pack.id === 'archive' &&
    pack['working-directory'] === 'packages/ui' &&
    pack.run === 'node scripts/prepare-packed-ui.mjs "$RUNNER_TEMP/prepared-ui"' &&
    exactStepKeys(consumers, ['name', 'working-directory', 'env', 'run']) &&
    consumers.name === 'Verify packed consumers' &&
    consumers['working-directory'] === 'packages/ui' &&
    exactMap(consumers.env, {
      ADEA_PACKED_UI_TARBALL: '${{ runner.temp }}/prepared-ui/package.tgz',
      ADEA_PACKED_UI_SHA256: '${{ steps.archive.outputs.sha256 }}',
    }) &&
    consumers.run === 'bun run check:packed-consumer' &&
    exactStepKeys(pasteModel, ['name', 'working-directory', 'env', 'run']) &&
    pasteModel.name === 'Verify packed pure paste model' &&
    pasteModel['working-directory'] === 'packages/ui' &&
    exactMap(pasteModel.env, {
      ADEA_PACKED_UI_TARBALL: '${{ runner.temp }}/prepared-ui/package.tgz',
      ADEA_PACKED_UI_SHA256: '${{ steps.archive.outputs.sha256 }}',
    }) &&
    pasteModel.run === 'bun run check:packed-paste-model' &&
    exactStepKeys(upload, ['name', 'uses', 'with']) &&
    upload.name === 'Upload the verified UI package' &&
    upload.uses === 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a' &&
    exactMap(upload.with, {
      name: 'prepared-ui-package',
      path: '${{ runner.temp }}/prepared-ui/',
      'retention-days': 1,
      'if-no-files-found': 'error',
    })
  )
}

/** @type {Record<string, [string, string][]>} */
const ADEA_UI_PACKED_CONSUMER_STEP_NAMES = {
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

/** @type {Record<string, [string, number]>} */
const ADEA_UI_PACKED_CONSUMER_JOB_NAMES = {
  'packed-conversation': ['Packed conversation', 15],
  'packed-layout': ['Packed layout', 15],
  'packed-layout-renderer': ['Packed layout renderer', 20],
  'packed-appearance': ['Packed appearance', 20],
  'packed-modal-dialog': ['Packed modal dialog', 15],
  'packed-native-select': ['Packed native select', 15],
}

const ADEA_UI_PLAYWRIGHT_IMAGE =
  'mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27'

/** @param {unknown} job @param {string} jobName @param {string} script */
function hasQualifiedAdeaUiConsumer(job, jobName, script) {
  const [expectedName, expectedTimeout] = ADEA_UI_PACKED_CONSUMER_JOB_NAMES[jobName] ?? []
  if (
    !safeRequiredJob(job) ||
    job.name !== expectedName ||
    job['runs-on'] !== 'ubuntu-latest' ||
    job['timeout-minutes'] !== expectedTimeout ||
    !sameStringSet(needs(job), ['prepare']) ||
    job.permissions !== undefined ||
    job.outputs !== undefined ||
    !object(job.container) ||
    Object.keys(job.container).length !== 1 ||
    job.container.image !== ADEA_UI_PLAYWRIGHT_IMAGE ||
    !object(job.env) ||
    Object.keys(job.env).toSorted().join('\n') !==
      ['ADEA_PACKED_UI_SHA256', 'ADEA_PACKED_UI_TARBALL', 'PLAYWRIGHT_RUNTIME_IMAGE']
        .toSorted()
        .join('\n') ||
    job.env.PLAYWRIGHT_RUNTIME_IMAGE !== ADEA_UI_PLAYWRIGHT_IMAGE ||
    job.env.ADEA_PACKED_UI_TARBALL !== '${{ github.workspace }}/prepared-ui/package.tgz' ||
    job.env.ADEA_PACKED_UI_SHA256 !== '${{ needs.prepare.outputs.archive_sha256 }}'
  ) {
    return false
  }

  const consumerSteps = steps(job)
  const cases = ADEA_UI_PACKED_CONSUMER_STEP_NAMES[jobName]
  if (!cases || consumerSteps.length !== 7 + cases.length || !consumerSteps.every(safeRequiredStep))
    return false
  const [checkout, prepareBun, setupBun, install, download, verify, engines, ...tests] =
    consumerSteps
  return (
    exactStepKeys(checkout, ['name', 'uses', 'with']) &&
    checkout.name === 'Checkout' &&
    checkout.uses === 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' &&
    exactMap(checkout.with, { 'persist-credentials': false }) &&
    exactStepKeys(prepareBun, ['name', 'run']) &&
    prepareBun.name === 'Prepare Bun extraction' &&
    prepareBun.run === 'apt-get update && apt-get install -y --no-install-recommends unzip' &&
    exactStepKeys(setupBun, ['name', 'uses', 'with']) &&
    setupBun.name === 'Setup Bun' &&
    setupBun.uses === 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6' &&
    exactMap(setupBun.with, { 'bun-version': '1.4.4' }) &&
    exactStepKeys(install, ['name', 'run']) &&
    install.name === 'Install dependencies' &&
    install.run === 'bun install --frozen-lockfile' &&
    exactStepKeys(download, ['name', 'uses', 'with']) &&
    download.name === 'Download the verified UI package' &&
    download.uses === 'actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131' &&
    exactMap(download.with, {
      name: 'prepared-ui-package',
      path: '${{ github.workspace }}/prepared-ui/',
    }) &&
    exactStepKeys(verify, ['name', 'run']) &&
    verify.name === 'Verify the shared archive' &&
    exactScript(
      verify.run,
      String.raw`printf '%s  %s\n' "$ADEA_PACKED_UI_SHA256" "$ADEA_PACKED_UI_TARBALL" | sha256sum --check`
    ) &&
    exactStepKeys(engines, ['name', 'run']) &&
    engines.name === 'Verify pinned headless engines' &&
    engines.run === 'node .github/scripts/check-playwright-runtime.mjs' &&
    tests.every(
      (step, index) =>
        exactStepKeys(step, ['name', 'working-directory', 'run']) &&
        step.name === cases[index][0] &&
        step['working-directory'] === 'packages/ui' &&
        step.run === cases[index][1] &&
        script === cases[0][1]
    )
  )
}

/** @param {unknown} actual @param {Record<string, any>} expected */
function exactMap(actual, expected) {
  return object(actual) && stableJson(actual) === stableJson(expected)
}

/** @param {unknown} job @returns {job is Record<string, any>} */
function safeRequiredJob(job, allowIf = false) {
  return (
    object(job) &&
    (allowIf || !Object.hasOwn(job, 'if')) &&
    (job['continue-on-error'] === undefined || job['continue-on-error'] === false)
  )
}

/** @param {unknown} job @returns {Record<string, any>[]} */
function steps(job) {
  return object(job) && Array.isArray(job.steps) && job.steps.every(object) ? job.steps : []
}

/** @param {unknown} job @returns {string[]} */
function needs(job) {
  if (!object(job)) return []
  if (typeof job.needs === 'string') return [job.needs]
  return Array.isArray(job.needs) && job.needs.every((item) => typeof item === 'string')
    ? job.needs
    : []
}

/** @param {string[]} actual @param {string[]} expected */
function sameStringSet(actual, expected) {
  return (
    actual.length === expected.length &&
    [...actual].toSorted().join('\n') === [...expected].toSorted().join('\n')
  )
}

/** @param {unknown} step @returns {step is Record<string, any>} */
function safeRequiredStep(step) {
  return (
    object(step) &&
    !Object.hasOwn(step, 'if') &&
    (step['continue-on-error'] === undefined || step['continue-on-error'] === false)
  )
}

/** @param {unknown} step @param {string[]} expected */
function exactStepKeys(step, expected) {
  return (
    object(step) && Object.keys(step).toSorted().join('\n') === [...expected].toSorted().join('\n')
  )
}

/** @param {unknown} actual @param {string} expected */
function exactScript(actual, expected) {
  if (typeof actual !== 'string') return false
  return (
    actual
      .split('\n')
      .filter((line) => line.trim() !== '')
      .join('\n') === expected
  )
}

const ADEA_UI_PIN_NPM_SCRIPT = [
  'set -euo pipefail',
  'needed="11.5.1"',
  'if [ "$(printf \'%s\\n%s\\n\' "$needed" "$(npm --version)" | sort -V | head -1)" != "$needed" ]; then',
  '  echo "::error title=npm is too old for trusted publishing::needs >= ${needed}, runner has $(npm --version)"',
  '  exit 1',
  'fi',
  'npm --version',
].join('\n')

const ADEA_UI_REFUSE_EXISTING_SCRIPT = [
  'set -euo pipefail',
  'if npm view "@adea-ai/ui@${VERSION}" version >/dev/null 2>&1; then',
  '  echo "::error title=Version already published::@adea-ai/ui@${VERSION} is already on the registry. Versions are immutable; bump the manifest and merge a new release instead of retagging."',
  '  exit 1',
  'fi',
  'echo "@adea-ai/ui@${VERSION} is available"',
].join('\n')

const ADEA_UI_PUBLISH_VERIFY_SCRIPT = String.raw`set -euo pipefail
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

const ADEA_UI_CONFIRM_RELEASE_SCRIPT = [
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

/** @param {string} content */
function parseJsonText(content) {
  try {
    return JSON.parse(content)
  } catch {
    return null
  }
}

/** @param {unknown} value @returns {string} */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** @param {unknown} before @param {unknown} after */
function sameExceptVersion(before, after) {
  const left = jsonObject(before)
  const right = jsonObject(after)
  if (!left || !right || !semver(left.version) || !semver(right.version)) return false
  const { version: _beforeVersion, ...beforeFields } = left
  const { version: _afterVersion, ...afterFields } = right
  return stableJson(beforeFields) === stableJson(afterFields)
}

/**
 * Prove that this workspace Release Please PR changes only the linked UI
 * versions, the single Bun workspace version, and generated changelog prose.
 * @param {{baseFiles:Map<string,string>, headFiles:Map<string,string>, changedPaths:string[], modeChanges?:string}} input
 */
export function validateAdeaUiWorkspaceReleaseDiff(input) {
  const { baseFiles, headFiles, changedPaths, modeChanges = '' } = input
  const failures = []
  if (
    changedPaths.length !== ADEA_UI_RELEASE_PATHS.length ||
    new Set(changedPaths).size !== ADEA_UI_RELEASE_PATHS.length ||
    ADEA_UI_RELEASE_PATHS.some((path) => !changedPaths.includes(path))
  ) {
    failures.push('workspace release must change exactly the approved five Release Please files')
  }
  if (modeChanges.trim()) failures.push('workspace release must not change file modes')
  if (ADEA_UI_RELEASE_PATHS.some((path) => !baseFiles.has(path) || !headFiles.has(path))) {
    failures.push('workspace release metadata is incomplete')
  }
  if (failures.length) return { valid: false, failures }

  const beforeRoot = parseJsonText(baseFiles.get('package.json') ?? '')
  const afterRoot = parseJsonText(headFiles.get('package.json') ?? '')
  const beforePackage = parseJsonText(baseFiles.get('packages/ui/package.json') ?? '')
  const afterPackage = parseJsonText(headFiles.get('packages/ui/package.json') ?? '')
  const beforeManifest = parseJsonText(baseFiles.get('.release-please-manifest.json') ?? '')
  const afterManifest = parseJsonText(headFiles.get('.release-please-manifest.json') ?? '')
  const beforeLock = normalizeAdeaUiLockVersion(
    baseFiles.get('bun.lock') ?? '',
    beforePackage?.version
  )
  const afterLock = normalizeAdeaUiLockVersion(
    headFiles.get('bun.lock') ?? '',
    afterPackage?.version
  )
  /** @param {unknown} value @param {unknown} version */
  const validManifest = (value, version) =>
    object(value) && Object.keys(value).join('\n') === '.' && value['.'] === version
  if (
    !sameExceptVersion(beforeRoot, afterRoot) ||
    !sameExceptVersion(beforePackage, afterPackage) ||
    beforeRoot?.version !== beforePackage?.version ||
    afterRoot?.version !== afterPackage?.version ||
    beforeRoot?.version === afterRoot?.version ||
    !validManifest(beforeManifest, beforeRoot?.version) ||
    !validManifest(afterManifest, afterRoot?.version) ||
    beforeLock === null ||
    afterLock === null ||
    beforeLock !== afterLock
  ) {
    failures.push(
      'workspace release changed more than the linked package versions, manifest, changelog, or exact lock workspace version'
    )
  }
  return { valid: failures.length === 0, failures }
}

/**
 * Reuse source-test evidence only for a public npm package released from the
 * repository root. Workspace and private-root layouts need package-specific
 * build and archive contracts, so they keep the full validation path.
 * @param {{packageManifest:unknown, releaseManifest:unknown, releaseConfigs:unknown[], packageManager?:unknown}} input
 */
export function supportsRootNpmReleaseContract(input) {
  const { packageManifest, releaseManifest, releaseConfigs, packageManager } = input
  if (
    !object(packageManifest) ||
    packageManifest.private === true ||
    typeof packageManifest.name !== 'string' ||
    packageManifest.name.length === 0 ||
    typeof packageManifest.version !== 'string' ||
    packageManifest.version.length === 0 ||
    Object.hasOwn(packageManifest, 'workspaces') ||
    !object(releaseManifest) ||
    Object.keys(releaseManifest).join('\n') !== '.' ||
    releaseManifest['.'] !== packageManifest.version ||
    !Array.isArray(releaseConfigs) ||
    releaseConfigs.length === 0
  ) {
    return false
  }

  for (const config of releaseConfigs) {
    if (!object(config)) return false
    if (Object.keys(config).some((key) => !TOP_LEVEL_RELEASE_CONFIG_KEYS.has(key))) return false
    if (
      config['extra-files'] !== undefined &&
      (!Array.isArray(config['extra-files']) || config['extra-files'].length !== 0)
    )
      return false
    if (
      config['include-component-in-tag'] !== undefined &&
      config['include-component-in-tag'] !== false
    )
      return false
    if (
      config['manifest-file'] !== undefined &&
      config['manifest-file'] !== '.release-please-manifest.json'
    ) {
      return false
    }
    if (config['release-type'] !== undefined && config['release-type'] !== 'node') return false
    if (config.packages !== undefined) {
      if (!object(config.packages) || Object.keys(config.packages).join('\n') !== '.') return false
      const rootConfig = config.packages['.']
      if (
        !object(rootConfig) ||
        Object.keys(rootConfig).some((key) => !ROOT_PACKAGE_CONFIG_KEYS.has(key)) ||
        rootConfig['extra-files'] !== undefined ||
        (rootConfig['package-name'] !== undefined &&
          rootConfig['package-name'] !== packageManifest.name) ||
        (rootConfig['release-type'] !== undefined && rootConfig['release-type'] !== 'node') ||
        (rootConfig['manifest-file'] !== undefined &&
          rootConfig['manifest-file'] !== '.release-please-manifest.json')
      ) {
        return false
      }
    }
  }

  const lifecycleScripts = packageManifest.scripts
  if (lifecycleScripts !== undefined && !object(lifecycleScripts)) return false
  if (object(lifecycleScripts)) {
    if (['prepare', 'prepack', 'postpack', 'prepublish'].some((name) => name in lifecycleScripts))
      return false
    if ('prepublishOnly' in lifecycleScripts) {
      const expectedBuild = ['bun', 'npm', 'pnpm', 'yarn'].includes(
        /** @type {string} */ (packageManager)
      )
        ? `${packageManager} run build`
        : null
      // This fixed hook is covered by the source audit's unit test command and
      // the release candidate pack qualification. Do not admit shell variants.
      const expectedTestAndPackCheck =
        lifecycleScripts.prepublishOnly === 'npm test && npm run pack:check' &&
        lifecycleScripts.test === 'node --test' &&
        lifecycleScripts['test:unit'] === 'node --test' &&
        lifecycleScripts['pack:check'] === 'npm pack --dry-run' &&
        !UNSUPPORTED_TEST_AND_PACK_HOOKS.some((name) => name in lifecycleScripts)
      const expectedBuildOnly =
        typeof lifecycleScripts.build === 'string' &&
        lifecycleScripts.prepublishOnly === expectedBuild
      if (!expectedBuildOnly && !expectedTestAndPackCheck) {
        return false
      }
    }
  }

  return true
}
