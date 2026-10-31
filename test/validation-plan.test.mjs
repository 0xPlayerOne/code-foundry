import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { syncRepository } from '../src/commands/sync.mjs'

const source = process.cwd()
const runtime = new URL('../src/runtime.mjs', import.meta.url).pathname
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      key !== 'GITHUB_OUTPUT' && !key.startsWith('REPO_FOUNDRY_') && !key.startsWith('FOUNDRY_')
  )
)

/** @param {string} name */
const workflow = (name) => readFileSync(join(source, '.github/workflows', name), 'utf8')

/** The text of one top-level job. @param {string} text @param {string} job */
function jobBlock(text, job) {
  const start = text.indexOf(`\n  ${job}:\n`)
  assert.ok(start >= 0, `job ${job} exists`)
  const rest = text.slice(start + 1)
  const next = rest.slice(1).search(/\n  [A-Za-z0-9_-]+:\n/)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

/**
 * The inline `node -e` script of the step with this id, dedented, so the
 * planner's matrices can be checked against the steps they replace.
 * @param {string} text @param {string} id
 */
function inlineScript(text, id) {
  const step = text.slice(text.indexOf(`- id: ${id}\n`))
  const start = step.indexOf("node -e '\n") + "node -e '\n".length
  const end = step.indexOf("\n          '\n")
  return step
    .slice(start, end)
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n')
}

/** @param {string} script @param {Record<string, string>} env @returns {Record<string, string>} */
function runInline(script, env) {
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-plan-inline-'))
  const output = join(root, 'output.env')
  writeFileSync(output, '')
  execFileSync(process.execPath, ['-e', script], {
    env: { ...baseEnv, ...env, GITHUB_OUTPUT: output },
  })
  return parseOutputs(readFileSync(output, 'utf8'))
}

/** @param {string} text @returns {Record<string, string>} */
function parseOutputs(text) {
  return Object.fromEntries(
    text
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
  )
}

/**
 * A committed repository: profile detection reads tracked files through git.
 * @param {{ config: string, files: Record<string, string> }} options
 */
function repository({ config, files }) {
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-plan-'))
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(root, '.github', 'code-foundry.yml'), config)
  writeFileSync(join(root, '.github', 'workflows', 'validation.yml'), 'name: caller\n')
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  const git = (/** @type {string[]} */ args) =>
    execFileSync('git', args, { cwd: root, env: baseEnv, stdio: 'ignore' })
  git(['init', '-q'])
  git(['add', '-A'])
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture'])
  return root
}

/** @param {string} root @param {string[]} args @param {Record<string, string>} env */
function runtimeOutputs(root, args, env) {
  const output = join(mkdtempSync(join(tmpdir(), 'code-foundry-plan-out-')), 'output.env')
  writeFileSync(output, '')
  execFileSync(process.execPath, [runtime, ...args], {
    cwd: root,
    env: { ...baseEnv, ...env, GITHUB_OUTPUT: output },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  return parseOutputs(readFileSync(output, 'utf8'))
}

/** @param {string} root @param {Record<string, string>} env */
function plans(root, env) {
  const outputs = runtimeOutputs(root, ['validation', 'plan'], env)
  return {
    security: JSON.parse(outputs.security_plan),
    codeql: JSON.parse(outputs.codeql_plan),
  }
}

const polyglot = () =>
  repository({
    config:
      'languages: typescript,rust,python\npackage_manager: bun\n' +
      `codeql_rust_shards: '["crates","apps/core"]'\n`,
    files: {
      'package.json': JSON.stringify({ name: 'fixture', dependencies: { left: '1.0.0' } }),
      'bun.lock': '',
      'Cargo.toml': '[workspace]\n',
      'crates/lib.rs': '',
      'apps/core/main.rs': '',
      'harness/requirements.txt': 'requests\n',
      'src/index.ts': '',
    },
  })

test('the plan carries exactly what the Profile and Detect jobs emit', () => {
  const root = polyglot()
  const changed = join(root, 'changed.txt')
  writeFileSync(changed, 'crates/lib.rs\nREADME.md\n')
  for (const env of [
    { FOUNDRY_EVENT_NAME: 'pull_request', REPO_FOUNDRY_VISIBILITY: 'public' },
    {
      FOUNDRY_EVENT_NAME: 'pull_request',
      REPO_FOUNDRY_VISIBILITY: 'public',
      FOUNDRY_CODEQL_CHANGED_FILES_FILE: changed,
      FOUNDRY_CODEQL_MERGE_GATE: 'false',
    },
    { FOUNDRY_EVENT_NAME: 'pull_request', REPO_FOUNDRY_VISIBILITY: 'private' },
    {
      FOUNDRY_EVENT_NAME: 'pull_request',
      REPO_FOUNDRY_VISIBILITY: 'private',
      REPO_FOUNDRY_CODE_SECURITY: 'enabled',
    },
  ]) {
    const plan = plans(root, env)
    const profile = runtimeOutputs(root, ['security', 'profile'], env)
    const detect = runtimeOutputs(root, ['codeql'], env)
    // The Security workflow's own matrix step, fed the profile it ran on.
    const audit = runInline(inlineScript(workflow('security.yml'), 'matrix'), {
      MATRIX_JAVASCRIPT: profile.javascript,
      MATRIX_RUST: profile.rust,
      MATRIX_PYTHON: profile.python,
      MATRIX_REQUIREMENTS: profile.python_requirements,
    })
    // The CodeQL workflow's own matrix step, fed the caller's rendered
    // rust-shards, which sync takes from codeql_rust_shards.
    const analysis = runInline(inlineScript(workflow('codeql.yml'), 'matrix'), {
      MATRIX_ENABLED: detect.enabled,
      MATRIX_LANGUAGES: detect.languages,
      MATRIX_SHARDS: '["crates","apps/core"]',
    })
    const { idle: securityIdle, ...security } = plan.security
    assert.deepEqual(security, { ...profile, audit_matrix: audit.audit_matrix })
    const { idle: codeqlIdle, code_security: codeSecurity, ...codeql } = plan.codeql
    assert.deepEqual(codeql, { ...detect, matrix: analysis.matrix })
    assert.equal(codeSecurity, env.REPO_FOUNDRY_CODE_SECURITY ?? '')
    assert.equal(securityIdle, 'false')
    assert.equal(codeqlIdle, detect.enabled === 'true' ? 'false' : 'true')
  }
})

test('a plan with nothing to run marks the workflow idle', () => {
  const bare = repository({
    config: 'languages: typescript\npackage_manager: none\ndependency_review: false\n',
    files: { 'README.md': '' },
  })
  const plan = plans(bare, {
    FOUNDRY_EVENT_NAME: 'pull_request',
    REPO_FOUNDRY_VISIBILITY: 'private',
  })
  assert.equal(plan.security.audit_matrix, '[]')
  assert.equal(plan.security.idle, 'true')
  // CodeQL unavailable on a private repository without Code Security.
  assert.equal(plan.codeql.enabled, 'false')
  assert.equal(plan.codeql.matrix, '[]')
  assert.equal(plan.codeql.idle, 'true')

  // Dependency Review alone keeps the Security workflow on pull requests.
  const reviewed = repository({
    config: 'languages: typescript\npackage_manager: none\ndependency_review: true\n',
    files: { 'README.md': '' },
  })
  // A review with no audit to ride on stays unplanned: Profile runs it.
  const pull = runtimeOutputs(reviewed, ['validation', 'plan'], {
    FOUNDRY_EVENT_NAME: 'pull_request',
  })
  assert.equal(pull.security_plan, '')
  assert.equal(JSON.parse(pull.codeql_plan).enabled, 'true')
  assert.equal(plans(reviewed, { FOUNDRY_EVENT_NAME: 'push' }).security.idle, 'true')
})

test('the plan job keeps the mode outputs and wires every input detection reads', () => {
  const caller = workflow('validation_self-ci.yml')
  const plan = jobBlock(caller, 'mode')
  assert.match(plan, /^    name: Plan$/m)
  // Existing outputs keep their names and sources.
  assert.match(plan, /^      mode: \$\{\{ steps\.classify\.outputs\.mode \}\}$/m)
  assert.match(plan, /^      idle-lanes: \$\{\{ steps\.lanes\.outputs\.idle_lanes \}\}$/m)
  assert.match(plan, /^      security-plan: \$\{\{ steps\.plan\.outputs\.security_plan \}\}$/m)
  assert.match(plan, /^      codeql-plan: \$\{\{ steps\.plan\.outputs\.codeql_plan \}\}$/m)
  // The docs-only downgrade still reads the base ref from a full checkout.
  const classify = plan.slice(plan.indexOf('name: Classify validation mode'))
  assert.match(classify, /FOUNDRY_BASE_REF: \$\{\{ github\.event\.pull_request\.base\.ref \}\}/)
  // The runtime fails open when an input is absent, so a missing env entry
  // silently turns CodeQL change detection off for every caller (#823).
  const step = plan.slice(plan.indexOf('name: Plan security and CodeQL'))
  const env = step.slice(0, step.indexOf('run:'))
  assert.match(env, /FOUNDRY_EVENT_NAME: \$\{\{ github\.event_name \}\}/)
  assert.match(env, /FOUNDRY_CODEQL_CHANGED_FILES_FILE: \$\{\{ steps\.changed\.outputs\.file \}\}/)
  assert.match(env, /FOUNDRY_CODEQL_MERGE_GATE: \$\{\{ steps\.gate\.outputs\.gated \}\}/)
  assert.match(env, /REPO_FOUNDRY_CODE_SECURITY: \$\{\{ steps\.security\.outputs\.status \}\}/)
  assert.match(env, /REPO_FOUNDRY_VISIBILITY: \$\{\{ github\.event\.repository\.visibility \}\}/)
  assert.match(step, /runtime\.mjs" validation plan >> "\$GITHUB_OUTPUT"/)
  // Planning fails open to the workflows' own Profile and Detect jobs.
  for (const name of [
    'Detect Code Security',
    'List pull request files',
    'Detect code scanning merge gate',
    'Plan security and CodeQL',
  ]) {
    const block = plan.slice(plan.indexOf(`name: ${name}`))
    assert.match(block.slice(0, block.indexOf('run:')), /continue-on-error: true/, name)
  }
  const validation = jobBlock(caller, 'validation')
  assert.match(validation, /^    name: Validation$/m)
  assert.match(
    validation,
    /^      security-plan: \$\{\{ needs\.mode\.outputs\.security-plan \}\}$/m
  )
  assert.match(validation, /^      codeql-plan: \$\{\{ needs\.mode\.outputs\.codeql-plan \}\}$/m)
})

test('Security and CodeQL skip Profile and Detect only for a planned run', () => {
  const security = workflow('security.yml')
  assert.match(
    jobBlock(security, 'profile'),
    /if: vars\.CI_BILLING_PAUSED != 'true' && inputs\.plan == ''\n/
  )
  const audit = jobBlock(security, 'dependency-audit')
  assert.ok(audit.includes("(inputs.plan == '' && needs.profile.result == 'success'"))
  assert.ok(audit.includes("(inputs.plan != '' && needs.profile.result == 'skipped'"))
  assert.ok(
    audit.includes(
      "fromJSON(inputs.plan || '{}').audit_matrix) || needs.profile.outputs.audit_matrix"
    )
  )
  // Dependency Review still runs on planned pull requests, on the first
  // audit job, and never as a separate (possibly skipped) check.
  assert.ok(audit.includes('strategy.job-index == 0'))
  assert.match(audit, /uses: actions\/dependency-review-action@/)
  assert.doesNotMatch(security, /^  dependency-review:\s*$/m)
  assert.match(jobBlock(security, 'profile'), /uses: actions\/dependency-review-action@/)

  const codeql = workflow('codeql.yml')
  assert.match(
    jobBlock(codeql, 'detect'),
    /if: vars\.CI_BILLING_PAUSED != 'true' && inputs\.plan == ''\n/
  )
  const analyze = jobBlock(codeql, 'analyze')
  assert.ok(
    analyze.includes(
      "(inputs.plan == '' && needs.detect.result == 'success' && needs.detect.outputs.enabled == 'true')"
    )
  )
  assert.ok(
    analyze.includes(
      "(inputs.plan != '' && needs.detect.result == 'skipped' && fromJSON(inputs.plan || '{}').enabled == 'true')"
    )
  )
  assert.ok(
    analyze.includes("fromJSON(inputs.plan || '{}').matrix) || needs.detect.outputs.matrix")
  )
  assert.ok(
    analyze.includes(
      "fromJSON(inputs.plan || '{}').rust_build_mode) || needs.detect.outputs.rust_build_mode"
    )
  )
  assert.doesNotMatch(analyze, /needs\.detect\.outputs\.(?!enabled|matrix|rust_build_mode)/)
})

test('every orchestrator accepts the plans and counts only a planned idle skip', () => {
  for (const name of ['validation.yml', 'validation-no-codeql.yml', 'validation-billing.yml']) {
    const text = workflow(name)
    assert.match(text, /^      security-plan:\n\s+description:/m, `${name} declares security-plan`)
    assert.match(text, /^      codeql-plan:\n\s+description:/m, `${name} declares codeql-plan`)
  }
  const securityIdle =
    "(needs.security.result == 'skipped' && fromJSON(inputs.security-plan || '{}').idle == 'true' && 'success') || needs.security.result"
  const codeqlIdle =
    "(needs.codeql.result == 'skipped' && fromJSON(inputs.codeql-plan || '{}').idle == 'true' && 'success') || needs.codeql.result"
  for (const name of ['validation.yml', 'validation-no-codeql.yml']) {
    const text = workflow(name)
    const security = jobBlock(text, 'security')
    assert.ok(security.includes("fromJSON(inputs.security-plan || '{}').idle != 'true'"), name)
    assert.match(security, /^      plan: \$\{\{ inputs\.security-plan \}\}$/m)
    assert.ok(text.includes(`FOUNDRY_SECURITY: \${{ ${securityIdle} }}`), `${name} gate security`)
    assert.ok(text.includes(`"security":"\${{ ${securityIdle} }}"`), `${name} receipt security`)
    assert.doesNotMatch(text, /needs\.security\.result == 'success' &&/)
  }
  const split = workflow('validation.yml')
  const codeql = jobBlock(split, 'codeql')
  assert.ok(codeql.includes("fromJSON(inputs.codeql-plan || '{}').idle != 'true'"))
  assert.match(codeql, /^      plan: \$\{\{ inputs\.codeql-plan \}\}$/m)
  assert.ok(split.includes(`FOUNDRY_CODEQL: \${{ ${codeqlIdle} }}`))
  assert.ok(split.includes(`"codeql":"\${{ ${codeqlIdle} }}"`))
  assert.doesNotMatch(split, /needs\.codeql\.result == 'success' &&/)

  const billing = workflow('validation-billing.yml')
  const billed = jobBlock(billing, 'codeql')
  assert.ok(billed.includes("fromJSON(inputs.codeql-plan || '{}').idle != 'true'"))
  assert.match(billed, /^      plan: \$\{\{ inputs\.codeql-plan \}\}$/m)
  assert.ok(
    billing.includes(
      `FOUNDRY_CODEQL: \${{ inputs.codeql == true && (${codeqlIdle}) || 'success' }}`
    )
  )
  // Required check names stay: the caller and orchestrator gate names.
  for (const name of ['validation.yml', 'validation-no-codeql.yml', 'validation-billing.yml']) {
    assert.match(jobBlock(workflow(name), 'gate'), /^    name: Gate$/m)
  }
})

test('rendered consumer callers plan security and CodeQL for every orchestrator', () => {
  for (const config of [{}, { codeql: 'false' }, { billing_lanes: 'true' }]) {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-plan-sync-'))
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
    const lines = Object.entries({ languages: 'typescript', package_manager: 'bun', ...config })
    writeFileSync(
      join(root, '.github', 'code-foundry.yml'),
      `${lines.map(([key, value]) => `${key}: ${value}`).join('\n')}\n`
    )
    writeFileSync(join(root, '.github', 'workflows', 'validation.yml'), 'name: caller\n')
    syncRepository({ target: root, source })
    const caller = readFileSync(join(root, '.github/workflows/validation.yml'), 'utf8')
    assert.match(caller, /runtime\.mjs" validation plan >> "\$GITHUB_OUTPUT"/)
    assert.match(caller, /^      security-plan: \$\{\{ needs\.mode\.outputs\.security-plan \}\}$/m)
    assert.match(caller, /^      codeql-plan: \$\{\{ needs\.mode\.outputs\.codeql-plan \}\}$/m)
    assert.match(caller, /^  validation:\n    name: Validation$/m)
  }
})
