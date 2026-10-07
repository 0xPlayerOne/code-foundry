import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { syncRepository } from '../src/commands/sync.mjs'

const source = process.cwd()
const billingTemplate = () =>
  readFileSync(join(source, '.github/workflows/validation-billing.yml'), 'utf8')

/** @param {Record<string, string>} extraConfig @returns {string} */
function consumerFixture(extraConfig = {}) {
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-billing-lanes-'))
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  const lines = Object.entries({
    languages: 'typescript',
    package_manager: 'bun',
    ...extraConfig,
  }).map(([key, value]) => `${key}: ${value}`)
  writeFileSync(join(root, '.github', 'code-foundry.yml'), `${lines.join('\n')}\n`)
  writeFileSync(join(root, 'src', 'index.ts'), '')
  writeFileSync(join(root, '.github', 'workflows', 'validation.yml'), 'name: caller\n')
  return root
}

/** @param {Record<string, string>} extraConfig @returns {string} */
function syncConsumer(extraConfig = {}) {
  const root = consumerFixture(extraConfig)
  syncRepository({ target: root, source })
  return readFileSync(join(root, '.github/workflows/validation.yml'), 'utf8')
}

test('the default render keeps the split orchestrators', () => {
  const caller = syncConsumer({ codeql: 'false' })
  assert.match(caller, /uses: .*\/\.github\/workflows\/validation-no-codeql\.yml@/)
  assert.doesNotMatch(caller, /validation-billing\.yml/)
  assert.doesNotMatch(caller, /^\s+codeql: '/m)
})

test('billing_lanes routes both CodeQL flavors through the billing orchestrator', () => {
  const withoutCodeql = syncConsumer({ codeql: 'false', billing_lanes: 'true' })
  assert.match(withoutCodeql, /uses: .*\/\.github\/workflows\/validation-billing\.yml@/)
  assert.match(withoutCodeql, /^      codeql: false$/m)

  const withCodeql = syncConsumer({ billing_lanes: 'true' })
  assert.match(withCodeql, /uses: .*\/\.github\/workflows\/validation-billing\.yml@/)
  assert.match(withCodeql, /^      codeql: true$/m)
})

test('the billing orchestrator declares the full input contract', () => {
  const template = billingTemplate()
  for (const input of [
    'mode',
    'codeql',
    'runtime-repository',
    'runtime-ref',
    'ci-runner',
    'test-runner',
    'unit-runner',
    'security-runner',
    'codeql-runner',
    'rust-shards',
    'rust-threads',
    'rust-max-parallel',
    'artifact-prefix',
    'e2e-shard-list',
    'e2e-total-shards',
  ]) {
    assert.match(template, new RegExp(`^      ${input}:`, 'm'), `missing input ${input}`)
  }
})

test('the billing orchestrator accepts every input the rendered caller sends', () => {
  // Regression pin for the #714 class of bug: the renderer forwards a fixed
  // input set regardless of the orchestrator in use, and an undeclared input
  // is a GitHub startup_failure that never reaches a check run.
  const caller = syncConsumer({ codeql: 'false', billing_lanes: 'true' })
  const withBlock = caller.slice(caller.indexOf('validation-billing.yml@'))
  const inputs = new Set(
    [...withBlock.slice(withBlock.indexOf('with:')).matchAll(/^      ([a-z-]+):/gm)].map(
      (match) => match[1]
    )
  )
  assert.ok(inputs.size >= 10, `unexpectedly few caller inputs: ${[...inputs].join(', ')}`)
  const template = billingTemplate()
  for (const input of inputs) {
    assert.match(
      template,
      new RegExp(`^      ${input}:\\n`, 'm'),
      `caller sends input "${input}" that validation-billing.yml does not declare`
    )
  }
})

test('sub-minute lanes share the merged fast-lanes job with their own receipts', () => {
  const template = billingTemplate()
  const fastLanes = template.slice(
    template.indexOf('  fast-lanes:'),
    template.indexOf('\n  type-check:')
  )
  for (const lane of ['format', 'build', 'performance', 'smoke', 'eval', 'lint', 'integration']) {
    assert.match(fastLanes, new RegExp(`id: ${lane}_applicability`), `missing detect for ${lane}`)
    assert.match(fastLanes, new RegExp(`id: ${lane}_execute`), `missing execute for ${lane}`)
    assert.match(
      fastLanes,
      new RegExp(`github\\.run_attempt \\}\\}-${lane}$`, 'm'),
      `missing receipt for ${lane}`
    )
  }
  // Audit-tier lanes stay gated inside the merged job, mirroring the split
  // orchestrators' mode conditions.
  assert.match(
    fastLanes,
    /inputs\.mode == 'audit' && steps\.smoke_applicability\.outputs\.applicable == 'true'/
  )
  assert.match(
    fastLanes,
    /inputs\.mode == 'audit' && steps\.eval_applicability\.outputs\.applicable == 'true'/
  )
  // A failed lane must not hide the next lane's result.
  const buildExecute = fastLanes.slice(fastLanes.indexOf('id: build_execute') - 200)
  assert.match(
    buildExecute,
    /!cancelled\(\) && steps\.build_applicability\.outputs\.applicable == 'true'/
  )
})

test('CPU-bound lanes stay on separate runners so the merged job is never the critical path', () => {
  const template = billingTemplate()
  for (const job of ['\n  type-check:\n    name: Type-Check', '\n  unit:\n    name: Unit']) {
    assert.ok(template.includes(job), `expected separate job ${job}`)
  }
  assert.doesNotMatch(template, /^  lint:$/m)
  assert.doesNotMatch(template, /^  integration:$/m)
  assert.match(template, /  e2e:\n    name: E2E/)
  assert.match(template, /runs-on: \$\{\{ inputs\.unit-runner \}\}/)
})

test('profile and dependency audit share one matrix-free job', () => {
  const template = billingTemplate()
  const audit = template.slice(template.indexOf('\n  audit:'), template.indexOf('\n  codeql:'))
  assert.match(audit, /id: profile/)
  assert.match(audit, /security should_run javascript/)
  assert.match(audit, /security audit javascript/)
  assert.match(audit, /security audit rust/)
  assert.match(audit, /security audit python/)
  // The split orchestrator fans Python requirements across matrix jobs; the
  // merged job loops instead.
  assert.match(audit, /REPO_FOUNDRY_PYTHON_REQUIREMENT="\$requirement"/)
  assert.doesNotMatch(audit, /matrix:/)
})

test('the gate folds merged lanes back into the shared category vocabulary', () => {
  const template = billingTemplate()
  const gate = template.slice(template.indexOf('\n  gate:'))
  assert.match(gate, /name: Gate/)
  assert.match(gate, /needs: \[fast-lanes, type-check, unit, e2e, audit, codeql\]/)
  assert.match(gate, /FOUNDRY_MODE: \$\{\{ inputs\.mode \}\}/)
  assert.match(gate, /FOUNDRY_CI: \$\{\{.*needs\.type-check\.result.*needs\.fast-lanes\.result/)
  assert.match(
    gate,
    /FOUNDRY_TEST: \$\{\{.*needs\.unit\.result.*needs\.fast-lanes\.result.*needs\.e2e\.result/
  )
  assert.doesNotMatch(gate, /needs\.lint\.result|needs\.integration\.result/)
  assert.match(gate, /FOUNDRY_SECURITY: \$\{\{ needs\.audit\.result \}\}/)
  // The CodeQL decision collapses into the input so one file serves both
  // flavors; expected skips of audit-tier jobs never fail the gate.
  assert.match(
    gate,
    /FOUNDRY_CODEQL: \$\{\{ inputs\.codeql == true && needs\.codeql\.result \|\| 'success' \}\}/
  )
  assert.match(gate, /FOUNDRY_EVAL: \$\{\{ needs\.fast-lanes\.result \}\}/)
  assert.match(gate, /validation release_diff/)
  assert.match(gate, /validation gate/)
})

test('every billing job keeps the billing guard and timeout guard', () => {
  const template = billingTemplate()
  const jobBlocks = template.slice(template.indexOf('\njobs:')).split(/\n  (?=[a-z][a-z-]*:\n)/)
  assert.ok(jobBlocks.length > 5)
  for (const block of jobBlocks) {
    if (!/^  [a-z][a-z-]*:/.test(block)) continue
    assert.match(block, /timeout-minutes:/, `missing timeout in ${block.slice(0, 30)}`)
    if (block.includes('uses: ./.github/workflows/')) continue
    assert.match(
      block,
      /vars\.CI_BILLING_PAUSED != 'true'/,
      `missing billing guard in ${block.slice(0, 30)}`
    )
  }
})
