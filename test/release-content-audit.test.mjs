import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { validateReleasePullRequestDiffs } from '../src/commands/release.mjs'
import {
  auditReleaseDiffContent,
  validateGeneratedReleaseDiff,
} from '../src/lib/release-policy.mjs'

const runtime = new URL('../src/runtime.mjs', import.meta.url).pathname
const HEAD_REF = 'release-please--branches--main--components--agent-sim'

const config = {
  packages: { '.': { 'release-type': 'node', 'package-name': 'agent-sim' } },
  'extra-files': [
    { type: 'json', path: 'packages/characters/package.json', jsonpath: '$.version' },
  ],
}

/**
 * The reduced shape of agent-sim #133 (release 0.15.8): the release commit was
 * written on top of main after #131 merged, but with package.json bodies read
 * before it, so the approved `^0.144.0` range came back as `^0.143.0`.
 */
const staleReleasePatch = `diff --git a/.release-please-manifest.json b/.release-please-manifest.json
--- a/.release-please-manifest.json
+++ b/.release-please-manifest.json
@@ -2 +2 @@
-  ".": "0.15.7"
+  ".": "0.15.8"
diff --git a/CHANGELOG.md b/CHANGELOG.md
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -2,0 +3,7 @@
+## [0.15.8](https://example.test/compare/v0.15.7...v0.15.8) (2026-10-21)
+
+### Bug Fixes
+
+* **deps:** update dependency @adea-ai/ui to ^0.144.0 (#131)
+
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -3 +3 @@
-  "version": "0.15.7",
+  "version": "0.15.8",
@@ -30 +30 @@
-    "@adea-ai/ui": "^0.144.0",
+    "@adea-ai/ui": "^0.143.0",
diff --git a/packages/characters/package.json b/packages/characters/package.json
--- a/packages/characters/package.json
+++ b/packages/characters/package.json
@@ -3 +3 @@
-  "version": "0.15.7",
+  "version": "0.15.8",
@@ -48 +48 @@
-    "@adea-ai/ui": "^0.144.0",
+    "@adea-ai/ui": "^0.143.0",
`

const healthyReleasePatch = staleReleasePatch
  .replaceAll('^0.143.0', '^0.144.0')
  .replace(/@@ -30 \+30 @@\n-.*\n\+.*\n/, '')
  .replace(/@@ -48 \+48 @@\n-.*\n\+.*\n/, '')

describe('generated release content audit', () => {
  it('rejects the stale-snapshot release that reverted approved dependency ranges', () => {
    const errors = auditReleaseDiffContent(staleReleasePatch, { config })
    assert.equal(errors.length, 2)
    assert.match(errors[0], /changes package\.json beyond release metadata/)
    assert.match(errors[0], /Removed: "@adea-ai\/ui": "\^0\.144\.0",/)
    assert.match(errors[0], /Added: "@adea-ai\/ui": "\^0\.143\.0",/)
    assert.match(errors[1], /changes packages\/characters\/package\.json/)
  })

  it('accepts version bumps, manifest entries and changelog additions only', () => {
    assert.deepEqual(auditReleaseDiffContent(healthyReleasePatch, { config }), [])
  })

  it('accepts the same hunks when the diff carries context lines', () => {
    const withContext = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -2,3 +2,3 @@
   "name": "agent-sim",
-  "version": "0.15.7",
+  "version": "0.15.8",
   "private": true,
`
    assert.deepEqual(auditReleaseDiffContent(withContext, { config }), [])
  })

  it('accepts release mutations in non-JSON version files, including annotated lines', () => {
    const patch = `diff --git a/Cargo.toml b/Cargo.toml
--- a/Cargo.toml
+++ b/Cargo.toml
@@ -3 +3 @@
-version = "0.3.1"
+version = "0.3.2"
diff --git a/version.txt b/version.txt
--- a/version.txt
+++ b/version.txt
@@ -1 +1 @@
-0.3.1
+0.3.2
diff --git a/src/version.py b/src/version.py
--- a/src/version.py
+++ b/src/version.py
@@ -1 +1 @@
-__version__ = "0.3.1"
+__version__ = "0.3.2"
@@ -4 +4 @@
-VERSION = "0.3.1" # x-release-please-version
+VERSION = "0.3.2" # x-release-please-version
`
    assert.deepEqual(auditReleaseDiffContent(patch, { config }), [])
  })

  it('rejects dependency, script and changelog rewrites hidden in approved files', () => {
    const patch = `diff --git a/Cargo.toml b/Cargo.toml
--- a/Cargo.toml
+++ b/Cargo.toml
@@ -3,0 +4 @@
+serde = "1.0.0"
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -8 +8 @@
-    "test": "bun test",
+    "test": "true",
diff --git a/CHANGELOG.md b/CHANGELOG.md
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -5 +5 @@
-* earlier entry
+* rewritten entry
`
    const errors = auditReleaseDiffContent(patch, { config })
    assert.equal(errors.length, 3)
    assert.match(errors.join('\n'), /Cargo\.toml beyond release metadata[^\n]*Added: serde = /)
    assert.match(errors.join('\n'), /package\.json beyond release metadata[^\n]*"test": "true"/)
    assert.match(errors.join('\n'), /CHANGELOG\.md beyond release metadata[^\n]*earlier entry/)
  })

  it('rejects deleted and renamed files', () => {
    const patch = `diff --git a/package.json b/package.json
deleted file mode 100644
--- a/package.json
+++ /dev/null
@@ -1 +0,0 @@
-{}
diff --git a/old/version.txt b/new/version.txt
similarity index 90%
rename from old/version.txt
rename to new/version.txt
`
    const errors = auditReleaseDiffContent(patch, { config })
    assert.ok(errors.some((error) => /deletes package\.json/.test(error)))
    assert.ok(errors.some((error) => /renames old\/version\.txt/.test(error)))
  })

  it('allows extra json keys that the release config declares', () => {
    const patch = `diff --git a/packages/app/info.json b/packages/app/info.json
--- a/packages/app/info.json
+++ b/packages/app/info.json
@@ -2 +2 @@
-  "release": "1.0.0",
+  "release": "1.0.1",
`
    assert.equal(auditReleaseDiffContent(patch, { config }).length, 1)
    const declared = {
      ...config,
      packages: {
        '.': {
          ...config.packages['.'],
          'extra-files': [{ type: 'json', path: 'packages/app/info.json', jsonpath: '$.release' }],
        },
      },
    }
    assert.deepEqual(auditReleaseDiffContent(patch, { config: declared }), [])
  })

  it('wires the audit into validateGeneratedReleaseDiff and fails closed on an unreadable diff', () => {
    const base = {
      headRef: HEAD_REF,
      headRepo: 'owner/repo',
      repository: 'owner/repo',
      changedPaths: ['package.json', '.release-please-manifest.json', 'CHANGELOG.md'],
      config,
    }
    assert.equal(validateGeneratedReleaseDiff({ ...base, patch: healthyReleasePatch }).valid, true)
    const stale = validateGeneratedReleaseDiff({ ...base, patch: staleReleasePatch })
    assert.equal(stale.valid, false)
    assert.match(stale.errors.join(' '), /beyond release metadata/)
    const unreadable = validateGeneratedReleaseDiff({ ...base, patch: null })
    assert.equal(unreadable.valid, false)
    assert.match(unreadable.errors.join(' '), /Unable to read the release content diff/)
    // Callers that do not supply a patch keep the path-only behavior.
    assert.equal(validateGeneratedReleaseDiff(base).valid, true)
  })
})

/** @param {string} root @param {string[]} args */
function git(root, args) {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

/** @param {string} root @param {string} ui @param {string} version */
function writeWorkspace(root, ui, version) {
  mkdirSync(join(root, 'packages/characters'), { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'agent-sim', version, devDependencies: { '@adea-ai/ui': ui } }, null, 2)}\n`
  )
  writeFileSync(
    join(root, 'packages/characters/package.json'),
    `${JSON.stringify({ name: '@agent-sim/characters', version, dependencies: { '@adea-ai/ui': ui } }, null, 2)}\n`
  )
  writeFileSync(join(root, '.release-please-manifest.json'), `{\n  ".": "${version}"\n}\n`)
}

describe('release_diff gate against a release generated mid-push', () => {
  /**
   * Replays agent-sim #133. `main` carries the approved ^0.144.0 range. Release
   * Please started on the previous push, read package.json bodies from that
   * snapshot (^0.143.0), then committed them onto the new main tip.
   */
  function fixture(releaseUiRange) {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-stale-release-'))
    git(root, ['init', '-q', '-b', 'main'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    writeFileSync(join(root, 'release-please-config.json'), JSON.stringify(config))
    writeWorkspace(root, '^0.143.0', '0.15.7')
    git(root, ['add', '-A'])
    git(root, ['commit', '-q', '-m', 'chore(main): release 0.15.7'])
    writeWorkspace(root, '^0.144.0', '0.15.7')
    git(root, ['commit', '-q', '-am', 'fix(deps): update dependency @adea-ai/ui to ^0.144.0'])
    const baseSha = git(root, ['rev-parse', 'HEAD'])
    git(root, ['checkout', '-q', '-b', HEAD_REF])
    writeWorkspace(root, releaseUiRange, '0.15.8')
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## 0.15.8\n')
    git(root, ['add', '-A'])
    git(root, ['commit', '-q', '-m', 'chore(main): release 0.15.8'])
    return { root, baseSha }
  }

  const gate = (root, baseSha) =>
    spawnSync(process.execPath, [runtime, 'validation', 'release_diff'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        FOUNDRY_BASE_SHA: baseSha,
        FOUNDRY_HEAD_REF: HEAD_REF,
        FOUNDRY_HEAD_REPO: 'owner/repo',
        FOUNDRY_REPOSITORY: 'owner/repo',
      },
    })

  it('fails the gate when the release reverts a range merged after the snapshot', () => {
    const { root, baseSha } = fixture('^0.143.0')
    try {
      const result = gate(root, baseSha)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /package\.json beyond release metadata/)
      assert.match(result.stderr, /Removed: "@adea-ai\/ui": "\^0\.144\.0"/)
      assert.match(result.stderr, /Added: "@adea-ai\/ui": "\^0\.143\.0"/)
      assert.match(result.stderr, /packages\/characters\/package\.json beyond release metadata/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('passes the gate when the release preserves the merged range, on repeated preparation', () => {
    const { root, baseSha } = fixture('^0.144.0')
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = gate(root, baseSha)
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /Release policy passed/)
        // Preparing the release again on the same head must not change the verdict.
        git(root, ['commit', '-q', '--allow-empty', '-m', 'chore(main): release 0.15.8'])
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails the gate when the content diff cannot be read', () => {
    const { root } = fixture('^0.144.0')
    try {
      const result = gate(root, 'f'.repeat(40))
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /Unable to read the release content diff/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('needs historical blobs to audit offline after checkout credentials are removed', () => {
    const { root, baseSha } = fixture('^0.144.0')
    const directory = mkdtempSync(join(tmpdir(), 'code-foundry-release-clones-'))
    try {
      const remote = join(directory, 'origin.git')
      git(directory, ['clone', '--bare', root, remote])
      git(remote, ['config', 'uploadpack.allowFilter', 'true'])
      const oldBlob = git(root, ['rev-parse', `${baseSha}:package.json`])
      for (const partial of [true, false]) {
        const clone = join(directory, partial ? 'partial' : 'full')
        git(directory, [
          'clone',
          '--no-local',
          ...(partial ? ['--filter=blob:none'] : []),
          pathToFileURL(remote).href,
          clone,
        ])
        // A missing local remote models checkout's authentication no longer being available,
        // without making a network request or creating/persisting credentials.
        git(clone, ['remote', 'set-url', 'origin', join(directory, 'unavailable.git')])
        const blob = spawnSync('git', ['--no-lazy-fetch', 'cat-file', '-e', oldBlob], {
          cwd: clone,
          encoding: 'utf8',
        })
        assert.equal(blob.status === 0, !partial)
        assert.match(git(clone, ['diff', '--name-only', `${baseSha}...HEAD`]), /package.json/)
        const result = gate(clone, baseSha)
        if (partial) {
          assert.notEqual(result.status, 0)
          assert.match(result.stderr, /Unable to read the release content diff/)
          assert.match(result.stderr, /historical blob .* unavailable from promisor remote/)
        } else {
          assert.equal(result.status, 0, result.stderr)
          assert.match(result.stdout, /Release policy passed/)
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reports bounded Git failure categories without replaying remote secrets or annotations', () => {
    const { root, baseSha } = fixture('^0.144.0')
    const bin = mkdtempSync(join(tmpdir(), 'code-foundry-release-git-'))
    try {
      const actualGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()
      writeFileSync(
        join(bin, 'git'),
        `#!/bin/sh
if [ "$1" = diff ] && [ "$2" = --no-color ]; then
  printf '%s\\n' 'fatal: Authentication failed for https://user:private-secret@example.test/repo?token=private-secret' '::warning::injected annotation' >&2
  exit 128
fi
exec "${actualGit}" "$@"
`
      )
      chmodSync(join(bin, 'git'), 0o755)
      const result = spawnSync(process.execPath, [runtime, 'validation', 'release_diff'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          FOUNDRY_BASE_SHA: baseSha,
          FOUNDRY_HEAD_REF: HEAD_REF,
          FOUNDRY_HEAD_REPO: 'owner/repo',
          FOUNDRY_REPOSITORY: 'owner/repo',
        },
      })
      assert.notEqual(result.status, 0)
      assert.match(
        result.stderr,
        /Git content diff failed \(status 128\): authentication unavailable/
      )
      assert.match(result.stderr, /Unable to read the release content diff/)
      assert.doesNotMatch(result.stderr, /private-secret|example\.test|::warning::/)
      assert.ok(result.stderr.length < 2048)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(bin, { recursive: true, force: true })
    }
  })
})

describe('release content checkout', () => {
  for (const file of ['validation.yml', 'validation-no-codeql.yml', 'validation-billing.yml']) {
    it(`${file} obtains historical blobs before removing checkout credentials`, () => {
      const workflow = readFileSync(
        new URL(`../.github/workflows/${file}`, import.meta.url),
        'utf8'
      )
      const checkout = workflow.match(
        /- name: Checkout consumer repository\n\s+if: \$\{\{ inputs\.mode == 'release' \}\}[\s\S]*?(?=\n\s+- name:)/
      )?.[0]
      assert.ok(checkout, 'release-only consumer checkout must be present')
      assert.match(checkout, /persist-credentials: false/)
      assert.match(checkout, /fetch-depth: 0/)
      assert.doesNotMatch(checkout, /filter:/)
      assert.doesNotMatch(checkout, /sparse-checkout:/)
    })
  }
})

describe('release validate-prs content audit', () => {
  /** @param {string} diff @param {number} [diffStatus] */
  function withFakeGh(diff, diffStatus = 0, run) {
    const root = mkdtempSync(join(tmpdir(), 'code-foundry-validate-prs-'))
    const ghDir = mkdtempSync(join(tmpdir(), 'code-foundry-validate-prs-gh-'))
    const head = 'c'.repeat(40)
    writeFileSync(join(root, 'release-please-config.json'), JSON.stringify(config))
    writeFileSync(join(ghDir, 'content.diff'), diff)
    writeFileSync(
      join(ghDir, 'gh'),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '[{"number":7,"title":"chore(main): release 0.15.8","headRefName":"${HEAD_REF}","headRefOid":"${head}"}]\\n'
elif [ "$1" = "pr" ] && [ "$2" = "diff" ]; then
  case " $* " in
    *" --name-only "*) printf 'CHANGELOG.md\\n.release-please-manifest.json\\npackage.json\\npackages/characters/package.json\\n' ;;
    *) [ ${diffStatus} -eq 0 ] || exit ${diffStatus}; cat "${join(ghDir, 'content.diff')}" ;;
  esac
elif [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"headRefOid":"${head}"}\\n'
else
  exit 2
fi
`
    )
    chmodSync(join(ghDir, 'gh'), 0o755)
    const previous = { PATH: process.env.PATH, GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY }
    const log = console.log
    try {
      process.env.PATH = `${ghDir}:${previous.PATH}`
      process.env.GITHUB_REPOSITORY = 'owner/repo'
      console.log = () => {}
      return run(root)
    } finally {
      console.log = log
      process.env.PATH = previous.PATH
      if (previous.GITHUB_REPOSITORY == null) delete process.env.GITHUB_REPOSITORY
      else process.env.GITHUB_REPOSITORY = previous.GITHUB_REPOSITORY
      rmSync(root, { recursive: true, force: true })
      rmSync(ghDir, { recursive: true, force: true })
    }
  }

  it('passes a release PR whose content is release metadata only', () => {
    const result = withFakeGh(healthyReleasePatch, 0, validateReleasePullRequestDiffs)
    assert.equal(result.valid, true)
  })

  it('refuses to enqueue a release PR carrying stale content', () => {
    assert.throws(
      () => withFakeGh(staleReleasePatch, 0, validateReleasePullRequestDiffs),
      /Generated release PR #7: Generated release PR changes package\.json beyond release metadata/
    )
  })

  it('refuses a release PR whose content diff cannot be read', () => {
    assert.throws(
      () => withFakeGh('', 1, validateReleasePullRequestDiffs),
      /unable to read its content diff/
    )
  })
})

const minified = (ui, version) =>
  `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -1 +1 @@
-{"name":"fixture","version":"1.0.0","dependencies":{"ui":"^0.144.0"}}
+{"name":"fixture","version":"${version}","dependencies":{"ui":"${ui}"}}
`

describe('minified manifests', () => {
  it('accepts a single-line manifest whose only change is the version', () => {
    assert.deepEqual(auditReleaseDiffContent(minified('^0.144.0', '1.1.0'), { config }), [])
  })

  it('rejects a single-line manifest that also rewrites a dependency range', () => {
    const errors = auditReleaseDiffContent(minified('^0.143.0', '1.1.0'), { config })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /package\.json beyond release metadata/)
  })
})
