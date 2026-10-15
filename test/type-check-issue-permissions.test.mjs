import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncRepository } from '../src/commands/sync.mjs'
import { renderMergeQueueCaller } from '../src/lib/merge-queue.mjs'

const source = fileURLToPath(new URL('../', import.meta.url))
const read = (file) => readFileSync(join(source, file), 'utf8')
const job = (yaml, name) => yaml.split(`\n  ${name}:\n`)[1].split(/\n  [a-z0-9_-]+:\n/)[0]
const allowsIssues = (block) => {
  const permissions = block.split('permissions:\n')[1]?.split(/\n(?=\S|    \S)/)[0]
  assert.ok(permissions?.split('\n').some((line) => line.trim() === 'issues: read'))
}

for (const file of ['ci.yml', 'validation-billing.yml']) {
  test(`${file}: only Type-Check gets issue reads and an execution token`, () => {
    const yaml = read(`.github/workflows/${file}`)
    const typeCheck = job(yaml, 'type-check')
    allowsIssues(typeCheck)
    assert.match(
      typeCheck,
      /env:\n          GH_TOKEN: \$\{\{ github.token \}\}\n        run: .* ci type_check\n/
    )
    assert.equal((yaml.match(/issues: read/g) ?? []).length, 1)
    assert.equal((yaml.match(/GH_TOKEN: \$\{\{ github.token \}\}/g) ?? []).length, 1)
    assert.doesNotMatch(typeCheck, /issues: write|contents: write|id-token: write/)
  })
}

for (const file of ['validation.yml', 'validation-no-codeql.yml']) {
  test(`${file}: CI forwards issue reads without exposing them to sibling workflows`, () => {
    const yaml = read(`.github/workflows/${file}`)
    allowsIssues(job(yaml, 'ci'))
    assert.equal((yaml.match(/issues: read/g) ?? []).length, 1)
  })
}

for (const file of [
  '.github/workflows/validation_self-ci.yml',
  '.github/workflows/validation_audit_self-ci.yml',
  'src/templates/workflows/validation-audit.yml',
]) {
  test(`${file}: outer validation caller permits nested Type-Check issue reads`, () => {
    const yaml = read(file)
    allowsIssues(job(yaml, 'validation'))
    assert.equal((yaml.match(/issues: read/g) ?? []).length, 1)
  })
}

for (const codeql of ['auto', 'false']) {
  for (const billing_lanes of ['false', 'true']) {
    test(`sync preserves the issue-read chain (codeql=${codeql}, billing=${billing_lanes})`, (t) => {
      const root = mkdtempSync(join(tmpdir(), 'foundry-issue-read-'))
      t.after(() => rmSync(root, { recursive: true, force: true }))
      mkdirSync(join(root, '.github/workflows'), { recursive: true })
      writeFileSync(join(root, 'package.json'), '{"name":"fixture","private":true}')
      writeFileSync(
        join(root, '.github/code-foundry.yml'),
        `languages: typescript\npackage_manager: bun\ncodeql: ${codeql}\nbilling_lanes: ${billing_lanes}\n`
      )
      syncRepository({ target: root, source })
      for (const name of ['validation', 'validation-audit']) {
        const yaml = readFileSync(join(root, `.github/workflows/${name}.yml`), 'utf8')
        allowsIssues(job(yaml, 'validation'))
        assert.equal((yaml.match(/issues: read/g) ?? []).length, 1)
        const orchestrator =
          billing_lanes === 'true'
            ? 'validation-billing'
            : codeql === 'false'
              ? 'validation-no-codeql'
              : 'validation'
        assert.ok(yaml.includes(`/.github/workflows/${orchestrator}.yml@`))
      }
    })
  }
  test(`merge queue caller permits issue reads (codeql=${codeql})`, () => {
    allowsIssues(renderMergeQueueCaller({ codeql, features: 'all' }, 'v1.47.1'))
  })
}
