import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { syncRepository } from '../src/commands/sync.mjs'

/** @param {string} extraConfig @param {string} features */
function consumerFixture(extraConfig = '', features = 'all') {
  const root = mkdtempSync(join(tmpdir(), 'code-foundry-updater-'))
  mkdirSync(join(root, '.github/workflows'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
  writeFileSync(
    join(root, '.github/code-foundry.yml'),
    `languages: typescript\npackage_manager: bun\nfeatures: ${features}\ngit_workflow: direct\nmerge_strategy: squash\nrelease_merge_strategy: squash\n${extraConfig}`
  )
  writeFileSync(join(root, '.github/dependabot.yml'), '# placeholder dependabot config\n')
  return root
}

describe('dependency_updater policy', () => {
  it('renders Dependabot by default and installs no Renovate config', () => {
    const root = consumerFixture()
    try {
      const result = syncRepository({ target: root, source: process.cwd() })
      assert.ok(result.changed.includes('.github/dependabot.yml'))
      const rendered = readFileSync(join(root, '.github/dependabot.yml'), 'utf8')
      assert.match(rendered, /package-ecosystem: bun/)
      assert.ok(!existsSync(join(root, 'renovate.json')), 'must not install renovate.json')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('removes Dependabot and installs a grouped draft Renovate config', () => {
    const root = consumerFixture('dependency_updater: renovate\n')
    try {
      const result = syncRepository({ target: root, source: process.cwd() })
      assert.ok(
        result.changed.includes('.github/dependabot.yml'),
        `expected the removal in changed: ${result.changed.join(', ')}`
      )
      assert.ok(!existsSync(join(root, '.github/dependabot.yml')))
      assert.ok(result.changed.includes('renovate.json'))
      const renovate = JSON.parse(readFileSync(join(root, 'renovate.json'), 'utf8'))
      assert.equal(renovate.draftPR, true)
      const groups = (renovate.packageRules ?? []).map((rule) => rule.groupName).filter(Boolean)
      assert.ok(groups.length >= 2, `expected grouped update rules, got ${groups.join(', ')}`)
      // A resync must settle: no churn once the switch has been applied.
      const resync = syncRepository({ target: root, source: process.cwd() })
      assert.deepEqual(resync.changed, [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves a repository-owned renovate.json byte for byte', () => {
    const root = consumerFixture('dependency_updater: renovate\n')
    try {
      const owned =
        '{\n  "$schema": "https://docs.renovatebot.com/renovate-schema.json",\n  "repositoryOwned": true\n}\n'
      writeFileSync(join(root, 'renovate.json'), owned)
      const result = syncRepository({ target: root, source: process.cwd() })
      assert.ok(!result.changed.includes('renovate.json'))
      assert.equal(readFileSync(join(root, 'renovate.json'), 'utf8'), owned)
      assert.ok(!existsSync(join(root, '.github/dependabot.yml')))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('removes Dependabot without installing Renovate for none', () => {
    const root = consumerFixture('dependency_updater: none\n')
    try {
      const result = syncRepository({ target: root, source: process.cwd() })
      assert.ok(result.changed.includes('.github/dependabot.yml'))
      assert.ok(!existsSync(join(root, '.github/dependabot.yml')))
      assert.ok(!existsSync(join(root, 'renovate.json')))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves Dependabot rendering to the features gate when unset', () => {
    const root = consumerFixture('', 'validation,release')
    try {
      const result = syncRepository({ target: root, source: process.cwd() })
      assert.ok(!result.changed.includes('.github/dependabot.yml'))
      // Status quo: the features gate stops managing the file but never
      // deletes a repository's copy — only dependency_updater removes it.
      assert.equal(
        readFileSync(join(root, '.github/dependabot.yml'), 'utf8'),
        '# placeholder dependabot config\n'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects an unsupported updater value before touching files', () => {
    const root = consumerFixture('dependency_updater: maybe\n')
    try {
      assert.throws(
        () => syncRepository({ target: root, source: process.cwd() }),
        /Unsupported dependency_updater: maybe/
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports the removal without touching the tree on a dry run', () => {
    const root = consumerFixture('dependency_updater: renovate\n')
    try {
      const result = syncRepository({ target: root, source: process.cwd(), dryRun: true })
      assert.ok(result.changed.includes('.github/dependabot.yml'))
      assert.ok(existsSync(join(root, '.github/dependabot.yml')), 'dry run must not delete')
      assert.ok(!existsSync(join(root, 'renovate.json')), 'dry run must not install')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
