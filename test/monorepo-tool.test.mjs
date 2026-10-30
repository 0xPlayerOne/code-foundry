import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  affectedFromChangedFiles,
  affectedPackages,
  listWorkspacePackages,
} from '../src/lib/task-filters.mjs'
import {
  commandUsesTurbo,
  commandUsesVitePlus,
  detectVitePlus,
  resolveMonorepoTool,
} from '../src/lib/profile.mjs'

/** Workspace files from a plain directory, for tests that need no git history. */
function fsWorkspaceSource(root) {
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const child = directory ? `${directory}/${entry.name}` : entry.name
      if (entry.isDirectory()) visit(child)
      else files.push(child)
    }
  }
  visit('')
  return { label: 'working tree', files, read: (path) => readFileSync(join(root, path), 'utf8') }
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(packageRoot, 'src/cli.mjs')

/** @param {import('node:test').TestContext} t */
function fixture(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'foundry-monorepo-tool-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) write(root, path, content)
  return root
}

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content))
}

function git(root, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
}

const pkg = (name, deps = {}) => ({ name, version: '1.0.0', dependencies: deps })

/** Workspace: core <- ui <- web, plus unrelated tools. */
const workspace = {
  'package.json': { name: 'root', private: true, workspaces: ['packages/*', 'apps/*'] },
  'packages/core/package.json': pkg('@w/core'),
  'packages/ui/package.json': pkg('@w/ui', { '@w/core': 'workspace:*' }),
  'apps/web/package.json': pkg('@w/web', { '@w/ui': 'workspace:*' }),
  'packages/tools/package.json': pkg('@w/tools'),
  'packages/core/src/index.ts': 'export {}\n',
  'packages/tools/src/index.ts': 'export {}\n',
  'bun.lock': 'lock\n',
  'README.md': 'readme\n',
}

/** Commit the workspace, then apply `change` and commit again. Returns refs. */
function workspaceRepo(t, change, extra = {}) {
  const root = fixture(t, { ...workspace, ...extra })
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'base')
  const base = git(root, 'rev-parse', 'HEAD')
  change(root)
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'change', '--allow-empty')
  return { root, base, head: git(root, 'rev-parse', 'HEAD') }
}

test('auto keeps legacy Turbo behavior and never selects Vite+', (t) => {
  const none = fixture(t, { 'package.json': { name: 'a' } })
  assert.equal(resolveMonorepoTool(none).tool, 'none')

  const turbo = fixture(t, { 'package.json': { name: 'a' }, 'turbo.json': {} })
  assert.equal(resolveMonorepoTool(turbo).tool, 'turbo')
  assert.deepEqual(resolveMonorepoTool(turbo).warnings, [])

  const jsonc = fixture(t, { 'package.json': { name: 'a' }, 'turbo.jsonc': '{}' })
  assert.equal(resolveMonorepoTool(jsonc).tool, 'turbo')

  // A repository that already depends on vite-plus is not switched implicitly.
  const both = fixture(t, {
    'package.json': { name: 'a', devDependencies: { 'vite-plus': '^1.3.0' } },
    'turbo.json': {},
  })
  assert.equal(resolveMonorepoTool(both).tool, 'turbo')
  const vitePlusOnly = fixture(t, {
    'package.json': { name: 'a', devDependencies: { 'vite-plus': '^1.3.0' } },
  })
  assert.equal(resolveMonorepoTool(vitePlusOnly).tool, 'none')
})

test('vite-plus is selected only by explicit opt-in and wins over a turbo config', (t) => {
  const root = fixture(t, {
    'package.json': { name: 'a', devDependencies: { 'vite-plus': '^1.3.0' } },
    'turbo.json': {},
  })
  const resolved = resolveMonorepoTool(root, { monorepo_tool: 'vite-plus' })
  assert.equal(resolved.tool, 'vite-plus')
  assert.deepEqual(resolved.warnings, [])
  assert.match(resolved.reason, /turbo config present but ignored/)

  const turbo = resolveMonorepoTool(root, { monorepo_tool: 'turbo' })
  assert.equal(turbo.tool, 'turbo')
})

test('unsatisfied or invalid monorepo_tool values warn and fall back safely', (t) => {
  const bare = fixture(t, { 'package.json': { name: 'a' } })
  const missingEvidence = resolveMonorepoTool(bare, { monorepo_tool: 'vite-plus' })
  assert.equal(missingEvidence.tool, 'vite-plus')
  assert.match(missingEvidence.warnings[0], /neither a vite-plus dependency/)

  const missingTurbo = resolveMonorepoTool(bare, { monorepo_tool: 'turbo' })
  assert.equal(missingTurbo.tool, 'none')
  assert.match(missingTurbo.warnings[0], /no turbo\.json/)

  const turbo = fixture(t, { 'package.json': { name: 'a' }, 'turbo.json': {} })
  const invalid = resolveMonorepoTool(turbo, { monorepo_tool: 'nx' })
  assert.equal(invalid.tool, 'turbo')
  assert.equal(invalid.configured, 'auto')
  assert.match(invalid.warnings[0], /unsupported monorepo_tool: nx/)
})

test('detectVitePlus finds the dependency or a vp run script', (t) => {
  const dependency = fixture(t, { 'package.json': { devDependencies: { 'vite-plus': '1' } } })
  assert.deepEqual(detectVitePlus(dependency), {
    declared: true,
    via: ['devDependencies.vite-plus'],
  })
  const script = fixture(t, { 'package.json': { scripts: { build: 'vp run -r build' } } })
  assert.deepEqual(detectVitePlus(script), { declared: true, via: ['scripts.build'] })
  const neither = fixture(t, { 'package.json': { scripts: { build: 'tsc' } } })
  assert.equal(detectVitePlus(neither).declared, false)
})

test('script command matchers distinguish the runners', () => {
  for (const command of [
    'vp run build',
    'vp run -r build',
    'vp -C apps/web run build',
    'vpr build',
    'echo hi && vp run test',
    '(vpr lint)',
  ])
    assert.equal(commandUsesVitePlus(command), true, command)
  for (const command of ['vp build', 'vp test', 'vite build', 'grep vpr-notes', 'turbo run build'])
    assert.equal(commandUsesVitePlus(command), false, command)
  assert.equal(commandUsesTurbo('turbo run build'), true)
  assert.equal(commandUsesTurbo('vp run build'), false)
})

test('workspace discovery reads package.json and pnpm workspaces with exclusions', (t) => {
  const npm = fsWorkspaceSource(fixture(t, workspace))
  const packages = listWorkspacePackages(npm)
  assert.deepEqual(packages.map((item) => item.name).toSorted(), [
    '@w/core',
    '@w/tools',
    '@w/ui',
    '@w/web',
    'root',
  ])
  assert.deepEqual(packages.find((item) => item.name === '@w/ui')?.dependencies, ['@w/core'])

  const pnpm = fixture(t, {
    'package.json': { private: true },
    'pnpm-workspace.yaml': "packages:\n  - 'libs/*'\n  - '!libs/legacy'\n",
    'libs/a/package.json': pkg('a'),
    'libs/legacy/package.json': pkg('legacy'),
  })
  assert.deepEqual(
    listWorkspacePackages(fsWorkspaceSource(pnpm)).map((item) => item.name),
    ['//', 'a']
  )

  const flow = fixture(t, {
    'package.json': { name: 'r' },
    'pnpm-workspace.yaml': 'packages: [\'apps/*\', "packages/*"]\n',
    'apps/a/package.json': pkg('a'),
    'packages/b/package.json': pkg('b'),
  })
  assert.deepEqual(
    listWorkspacePackages(fsWorkspaceSource(flow))
      .map((item) => item.name)
      .toSorted(),
    ['a', 'b', 'r']
  )
})

const manifest = (workspaces) => ({ name: 'r', workspaces })

test('workspace discovery throws on anything it cannot evaluate faithfully', (t) => {
  /** @param {Record<string, unknown>} files */
  const discover = (files) => listWorkspacePackages(fsWorkspaceSource(fixture(t, files)))
  for (const glob of ['{apps,packages}/*', 'apps/[ab]', 'apps/@(a|b)', 'apps/**x', 'a\\b'])
    assert.throws(
      () => discover({ 'package.json': manifest([glob]), 'apps/a/package.json': pkg('a') }),
      /unsupported workspace glob/,
      glob
    )
  assert.throws(
    () => discover({ 'package.json': manifest({ nested: true }) }),
    /unsupported workspaces declaration/
  )
  assert.throws(() => discover({ 'package.json': manifest([1]) }), /non-string workspace glob/)
  assert.throws(
    () => discover({ 'package.json': { name: 'r' }, 'pnpm-workspace.yaml': 'packages: apps/*\n' }),
    /unsupported packages declaration/
  )
  assert.throws(
    () =>
      discover({
        'package.json': { name: 'r' },
        'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - { weird: true }\n',
      }),
    /unsupported workspace glob/
  )
  assert.throws(() => discover({ 'package.json': '{ not json' }), /malformed package\.json/)
  assert.throws(
    () =>
      discover({ 'package.json': manifest(['packages/*']), 'packages/core/package.json': '{oops' }),
    /malformed manifest packages\/core\/package\.json/
  )
  assert.throws(
    () =>
      discover({
        'package.json': manifest(['packages/*']),
        'packages/core/package.json': { version: '1.0.0' },
      }),
    /has no name/
  )
  assert.throws(
    () =>
      discover({
        'package.json': manifest(['packages/*']),
        'packages/a/package.json': pkg('same'),
        'packages/b/package.json': pkg('same'),
      }),
    /duplicate workspace package name: same/
  )
})

test('affectedFromChangedFiles adds transitive dependents and fails closed on shared files', (t) => {
  const packages = listWorkspacePackages(fsWorkspaceSource(fixture(t, workspace)))
  const select = (...files) => affectedFromChangedFiles([packages], files)

  assert.deepEqual(select('packages/core/src/index.ts'), {
    all: false,
    packages: ['@w/core', '@w/ui', '@w/web'],
    reason: 'git diff and workspace graphs',
  })
  assert.deepEqual(select('packages/tools/src/index.ts').packages, ['@w/tools'])
  assert.deepEqual(select().packages, [])
  // A nested file named like a global file only affects its own package.
  assert.equal(select('packages/tools/package.json').all, false)

  // Nothing is assumed to be a non-build file: a build may read any of these.
  for (const file of [
    'README.md',
    'LICENSE',
    'docs/guide/setup.png',
    'docs/site.mdx',
    'template.txt',
    '.gitignore',
    'NOTICE',
  ])
    assert.equal(select(file).all, true, file)

  // Only explicit consumer configuration (affected_ignore globs) skips unowned files.
  const ignored = (...files) =>
    affectedFromChangedFiles([packages], files, ['README.md', 'docs/**'])
  assert.deepEqual(ignored('README.md', 'docs/guide/a.png').packages, [])
  assert.equal(ignored('README.md', 'docs/guide/a.png').all, false)
  assert.equal(ignored('README.md', 'template.txt').all, true)
  assert.equal(ignored('docs/site.mdx', 'scripts/build.mjs').all, true)
  assert.deepEqual(ignored('README.md', 'packages/tools/src/index.ts').packages, ['@w/tools'])

  // Anything else that no package owns can change any package's output.
  for (const file of [
    'bun.lock',
    'package.json',
    'pnpm-workspace.yaml',
    'turbo.json',
    'vite.config.ts',
    'tsconfig.base.json',
    '.mise.toml',
    'scripts/build.mjs',
    'scripts/build-cloudflare.mjs',
    '.github/workflows/ci.yml',
    'tools/codegen/run.ts',
  ]) {
    const result = select(file)
    assert.equal(result.all, true, file)
    assert.match(result.reason, /shared or unowned file changed/, file)
    assert.equal(result.packages.length, 5, file)
  }
})

test('vite-plus affected selection uses git and the workspace graphs', (t) => {
  const { root, base, head } = workspaceRepo(t, (dir) =>
    write(dir, 'packages/core/src/index.ts', 'export const changed = true\n')
  )
  const result = affectedPackages(root, { base, head, tool: 'vite-plus' })
  assert.equal(result.tool, 'vite-plus')
  assert.equal(result.all, false)
  assert.equal(result.conservative, false)
  assert.equal(result.changedFiles, 1)
  assert.deepEqual(result.packages, ['@w/core', '@w/ui', '@w/web'])
  assert.deepEqual(result.removedPackages, [])
  assert.deepEqual(result.filterArgs, [
    '--filter',
    '@w/core',
    '--filter',
    '@w/ui',
    '--filter',
    '@w/web',
  ])
})

test('vite-plus selection resolves the tool from code-foundry.yml and honors the override', (t) => {
  const { root, base, head } = workspaceRepo(
    t,
    (dir) => write(dir, 'packages/tools/src/index.ts', 'export const x = 1\n'),
    { '.github/code-foundry.yml': 'monorepo_tool: vite-plus\n' }
  )
  assert.deepEqual(affectedPackages(root, { base, head }).packages, ['@w/tools'])
  assert.equal(affectedPackages(root, { base, head, tool: 'auto' }).tool, 'vite-plus')
})

test('vite-plus selection handles global, non-build, and empty changes', (t) => {
  const lock = workspaceRepo(t, (dir) => write(dir, 'bun.lock', 'changed\n'))
  const global = affectedPackages(lock.root, { ...lock, tool: 'vite-plus' })
  assert.equal(global.all, true)
  assert.equal(global.conservative, false)
  assert.deepEqual(global.filterArgs, [])
  assert.equal(global.packages.length, 5)

  // A root file a workspace build may consume is not skipped by default.
  for (const [file, content] of [
    ['docs/site.mdx', '# changed\n'],
    ['template.txt', 'changed\n'],
    ['README.md', 'changed\n'],
  ]) {
    const repo = workspaceRepo(t, (dir) => write(dir, file, content))
    const unowned = affectedPackages(repo.root, { ...repo, tool: 'vite-plus' })
    assert.equal(unowned.all, true, file)
    assert.equal(unowned.conservative, false, file)
    assert.match(unowned.reason, new RegExp(file.replace('.', '\\.')), file)
  }

  // affected_ignore in code-foundry.yml is the explicit opt-out.
  const configured = workspaceRepo(t, (dir) => write(dir, 'docs/site.mdx', '# changed\n'), {
    '.github/code-foundry.yml': 'monorepo_tool: vite-plus\naffected_ignore: README.md, docs/**\n',
  })
  const skipped = affectedPackages(configured.root, { ...configured })
  assert.equal(skipped.all, false)
  assert.deepEqual(skipped.packages, [])
  assert.deepEqual(skipped.filterArgs, [])

  const empty = workspaceRepo(t, () => {})
  const nothing = affectedPackages(empty.root, { ...empty, tool: 'vite-plus' })
  assert.deepEqual(nothing.packages, [])
  assert.equal(nothing.all, false)
})

test('a changed shared root script selects every package', (t) => {
  const { root, base, head } = workspaceRepo(
    t,
    (dir) => write(dir, 'scripts/build.mjs', 'console.log("changed")\n'),
    { 'scripts/build.mjs': 'console.log("base")\n' }
  )
  const result = affectedPackages(root, { base, head, tool: 'vite-plus' })
  assert.equal(result.all, true)
  assert.equal(result.conservative, false)
  assert.match(result.reason, /scripts\/build\.mjs/)
  assert.equal(result.packages.length, 5)
})

test('deleting a package still selects the packages that depended on it', (t) => {
  const { root, base, head } = workspaceRepo(t, (dir) => {
    rmSync(join(dir, 'packages/core'), { recursive: true })
    // web and ui still list the removed package in their manifests.
  })
  const result = affectedPackages(root, { base, head, tool: 'vite-plus' })
  assert.equal(result.all, false)
  assert.deepEqual(result.removedPackages, ['@w/core'])
  assert.deepEqual(result.packages, ['@w/ui', '@w/web'])
  assert.deepEqual(result.filterArgs, ['--filter', '@w/ui', '--filter', '@w/web'])
})

test('renaming a package selects its dependents through the base graph', (t) => {
  const { root, base, head } = workspaceRepo(t, (dir) =>
    write(dir, 'packages/core/package.json', pkg('@w/new-core'))
  )
  const result = affectedPackages(root, { base, head, tool: 'vite-plus' })
  assert.equal(result.all, false)
  assert.deepEqual(result.packages, ['@w/new-core', '@w/ui', '@w/web'])
  assert.deepEqual(result.removedPackages, ['@w/core'])
})

test('moving a package directory selects dependents and the new location', (t) => {
  const { root, base, head } = workspaceRepo(t, (dir) => {
    git(dir, 'mv', 'packages/core', 'packages/kernel')
  })
  const result = affectedPackages(root, { base, head, tool: 'vite-plus' })
  assert.equal(result.all, false)
  assert.deepEqual(result.packages, ['@w/core', '@w/ui', '@w/web'])
})

test('a dependency removed or added in a manifest keeps the old dependents selected', (t) => {
  const removed = workspaceRepo(t, (dir) =>
    write(dir, 'packages/ui/package.json', pkg('@w/ui', {}))
  )
  // ui changed itself, and web depended on ui in both graphs.
  assert.deepEqual(affectedPackages(removed.root, { ...removed, tool: 'vite-plus' }).packages, [
    '@w/ui',
    '@w/web',
  ])
  const added = workspaceRepo(t, (dir) =>
    write(dir, 'packages/tools/package.json', pkg('@w/tools', { '@w/core': 'workspace:*' }))
  )
  assert.deepEqual(affectedPackages(added.root, { ...added, tool: 'vite-plus' }).packages, [
    '@w/tools',
  ])
})

test('divergent branches are compared against their merge-base, not the base tip', (t) => {
  const root = fixture(t, {
    'package.json': { name: 'root', private: true, workspaces: ['packages/*'] },
    'packages/core/package.json': pkg('@w/core'),
    'packages/core/src/index.ts': 'export {}\n',
    'packages/web/package.json': pkg('@w/web', { '@w/core': 'workspace:*' }),
  })
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'ancestor')
  const ancestor = git(root, 'rev-parse', 'HEAD')

  // Base side: rename core and drop web's dependency on it.
  git(root, 'checkout', '-q', '-b', 'base-side')
  write(root, 'packages/core/package.json', pkg('@w/new-core'))
  write(root, 'packages/web/package.json', pkg('@w/web'))
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'rename core')
  const base = git(root, 'rev-parse', 'HEAD')

  // Head side: delete core.
  git(root, 'checkout', '-q', '-b', 'head-side', ancestor)
  rmSync(join(root, 'packages/core'), { recursive: true })
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'delete core')
  const head = git(root, 'rev-parse', 'HEAD')

  const result = affectedPackages(root, { base, head, tool: 'vite-plus' })
  assert.equal(result.mergeBase, ancestor)
  assert.equal(result.conservative, false)
  assert.deepEqual(result.removedPackages, ['@w/core'])
  assert.deepEqual(result.packages, ['@w/web'])
  assert.deepEqual(result.filterArgs, ['--filter', '@w/web'])
})

test('uncertain workspaces fail closed instead of yielding a partial graph', (t) => {
  const braces = workspaceRepo(t, (dir) => write(dir, 'packages/tools/src/index.ts', 'x\n'), {
    'package.json': { name: 'root', workspaces: ['{apps,packages}/*'] },
  })
  const braced = affectedPackages(braces.root, { ...braces, tool: 'vite-plus' })
  assert.equal(braced.all, true)
  assert.equal(braced.conservative, true)
  assert.match(braced.reason, /unsupported workspace glob/)

  const malformed = workspaceRepo(t, (dir) => write(dir, 'packages/core/package.json', '{broken'))
  const broken = affectedPackages(malformed.root, { ...malformed, tool: 'vite-plus' })
  assert.equal(broken.all, true)
  assert.equal(broken.conservative, true)
  assert.match(broken.reason, /malformed manifest packages\/core\/package\.json/)

  // Malformed at the base ref only is just as uncertain.
  const baseBroken = workspaceRepo(
    t,
    (dir) => write(dir, 'packages/core/package.json', pkg('@w/core')),
    { 'packages/core/package.json': '{broken' }
  )
  assert.equal(
    affectedPackages(baseBroken.root, { ...baseBroken, tool: 'vite-plus' }).conservative,
    true
  )

  const flowRepo = workspaceRepo(t, (dir) => write(dir, 'packages/tools/src/index.ts', 'y\n'), {
    'package.json': { name: 'root' },
    'pnpm-workspace.yaml': "packages: ['apps/*', 'packages/*']\n",
  })
  const flow = affectedPackages(flowRepo.root, { ...flowRepo, tool: 'vite-plus' })
  assert.equal(flow.conservative, false)
  assert.deepEqual(flow.packages, ['@w/tools'])
})

test('affected selection is conservative when it cannot prove anything', (t) => {
  const { root, base } = workspaceRepo(t, () => {})
  const badRef = affectedPackages(root, { base, head: 'does-not-exist', tool: 'vite-plus' })
  assert.equal(badRef.all, true)
  assert.equal(badRef.conservative, true)
  assert.match(badRef.reason, /affected selection failed/)

  const injection = affectedPackages(root, {
    base: '--output=/tmp/x',
    head: 'HEAD',
    tool: 'vite-plus',
  })
  assert.equal(injection.conservative, true)
  assert.match(injection.reason, /invalid base ref/)

  // A base commit missing from a shallow clone cannot be compared.
  const missing = affectedPackages(root, { base: 'f'.repeat(40), head: 'HEAD', tool: 'vite-plus' })
  assert.equal(missing.conservative, true)

  const bare = fixture(t, { 'package.json': { name: 'a' } })
  const none = affectedPackages(bare, { base: 'a', head: 'b' })
  assert.equal(none.tool, 'none')
  assert.equal(none.conservative, true)
})

test('unsafe package names are never passed to --filter', (t) => {
  const { root, base, head } = workspaceRepo(
    t,
    (dir) => write(dir, 'packages/evil/src/a.ts', 'x\n'),
    { 'packages/evil/package.json': { name: '--workspace-root' } }
  )
  const result = affectedPackages(root, { base, head, tool: 'vite-plus' })
  assert.equal(result.conservative, true)
  assert.match(result.reason, /unsafe package name/)
})

test('turbo affected selection parses turbo query output and keeps Turbo behavior', (t) => {
  const root = fixture(t, { ...workspace, 'turbo.json': {} })
  /** @type {Array<[string, string[], string]>} */
  const calls = []
  const result = affectedPackages(root, {
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    run(command, args, cwd) {
      calls.push([command, args, cwd])
      return JSON.stringify({
        data: {
          affectedPackages: { items: [{ name: '@w/ui' }, { name: '@w/web' }, { name: '@w/ui' }] },
        },
      })
    },
  })
  assert.equal(result.tool, 'turbo')
  assert.deepEqual(result.packages, ['@w/ui', '@w/web'])
  assert.equal(result.all, false)
  assert.deepEqual(result.filterArgs, [])
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'turbo')
  assert.deepEqual(calls[0][1], [
    'query',
    'affected',
    '--packages',
    `--base=${'a'.repeat(40)}`,
    `--head=${'b'.repeat(40)}`,
    '--no-update-notifier',
  ])

  const taskShape = affectedPackages(root, {
    base: 'main',
    head: 'HEAD',
    run: () =>
      JSON.stringify({ data: { affectedTasks: { items: [{ fullName: '@w/core#build' }] } } }),
  })
  assert.deepEqual(taskShape.packages, ['@w/core'])
})

test('turbo selection never depends on this module parsing the workspace', (t) => {
  // Turbo evaluates its own graph; unsupported globs must not break it.
  const root = fixture(t, {
    'package.json': { name: 'r', workspaces: ['{apps,packages}/*'] },
    'turbo.json': {},
  })
  const result = affectedPackages(root, {
    base: 'main',
    head: 'HEAD',
    run: () => JSON.stringify({ data: { affectedPackages: { items: [{ name: 'x' }] } } }),
  })
  assert.equal(result.conservative, false)
  assert.deepEqual(result.packages, ['x'])
})

test('turbo affected selection fails closed', (t) => {
  const root = fixture(t, { ...workspace, 'turbo.json': {} })
  for (const run of [
    () => {
      throw new Error('turbo: not found')
    },
    () => 'not json',
    () => JSON.stringify({ data: {} }),
  ]) {
    const result = affectedPackages(root, { base: 'main', head: 'HEAD', run })
    assert.equal(result.tool, 'turbo')
    assert.equal(result.all, true)
    assert.equal(result.conservative, true)
  }
})

test('explicit tool override selects Vite+ even when a turbo config exists', (t) => {
  const { root, base, head } = workspaceRepo(
    t,
    (dir) => write(dir, 'packages/tools/src/index.ts', 'y\n'),
    { 'turbo.json': {} }
  )
  assert.equal(
    affectedPackages(root, {
      base,
      head,
      run: () => {
        throw new Error('turbo must not run')
      },
      tool: 'vite-plus',
    }).tool,
    'vite-plus'
  )
})

test('affected command prints JSON and rejects an unsupported tool', (t) => {
  const { root, base, head } = workspaceRepo(t, (dir) =>
    write(dir, 'packages/tools/src/index.ts', 'z\n')
  )
  const ok = spawnSync(
    process.execPath,
    [cli, 'affected', '--target', root, '--base', base, '--head', head, '--tool', 'vite-plus'],
    { encoding: 'utf8' }
  )
  assert.equal(ok.status, 0, ok.stderr)
  assert.deepEqual(JSON.parse(ok.stdout).packages, ['@w/tools'])

  // --head defaults to HEAD for this command.
  const implicit = spawnSync(
    process.execPath,
    [cli, 'affected', '--target', root, '--base', base, '--tool', 'vite-plus'],
    { encoding: 'utf8' }
  )
  assert.equal(JSON.parse(implicit.stdout).head, 'HEAD')

  const bad = spawnSync(process.execPath, [cli, 'affected', '--target', root, '--tool', 'nx'], {
    encoding: 'utf8',
  })
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /unsupported --tool: nx/)

  const wrongCommand = spawnSync(process.execPath, [cli, 'doctor', '--tool', 'turbo'], {
    encoding: 'utf8',
  })
  assert.match(wrongCommand.stderr, /--tool is only supported by the affected command/)
})

test('doctor reports unsatisfied monorepo_tool settings', (t) => {
  const root = fixture(t, {
    'package.json': { name: 'a', version: '1.0.0' },
    '.github/code-foundry.yml': 'monorepo_tool: vite-plus\n',
  })
  const report = spawnSync(process.execPath, [cli, 'doctor', '--target', root], {
    encoding: 'utf8',
  })
  assert.match(report.stderr, /WARN: monorepo_tool: vite-plus but neither a vite-plus dependency/)
  assert.match(report.stdout, /Task runner: vite-plus/)

  const turboRoot = fixture(t, {
    'package.json': { name: 'a', version: '1.0.0' },
    'turbo.json': {},
  })
  const quiet = spawnSync(process.execPath, [cli, 'doctor', '--target', turboRoot], {
    encoding: 'utf8',
  })
  assert.doesNotMatch(quiet.stderr, /monorepo_tool/)
  assert.doesNotMatch(quiet.stdout, /Task runner/)
})

// --- setup action: profile detection, cache steps -------------------------

const setupAction = readFileSync(join(packageRoot, '.github/actions/setup/action.yml'), 'utf8')
const cacheSaveAction = readFileSync(
  join(packageRoot, '.github/actions/cache-save/action.yml'),
  'utf8'
)

/** Extract and run the "Detect project profile" shell exactly as the action does. */
function profileOutputs(root, { task = '' } = {}) {
  const lines = setupAction.split('\n')
  const start = lines.findIndex((line) => line.trim() === '- name: Detect project profile')
  const run = lines.findIndex((line, index) => index > start && line.startsWith('      run: |'))
  const script = []
  for (const line of lines.slice(run + 1)) {
    if (line.startsWith('      env:')) break
    script.push(line.startsWith('        ') ? line.slice(8) : line.trimStart())
  }
  writeFileSync(join(root, '.profile.sh'), script.join('\n'))
  const output = join(root, '.github-output')
  writeFileSync(output, '')
  const result = spawnSync('bash', [join(root, '.profile.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GITHUB_OUTPUT: output,
      REPO_FOUNDRY_TASK: task,
      REPO_FOUNDRY_MISE_SCOPE: 'auto',
      REPO_FOUNDRY_CACHE_PACKAGES: 'auto',
    },
  })
  assert.equal(result.status, 0, result.stderr)
  return Object.fromEntries(
    readFileSync(output, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/=(.*)/s).slice(0, 2))
  )
}

function profileRepo(t, files) {
  const root = fixture(t, files)
  git(root, 'init', '-q')
  git(root, 'add', '-A')
  return root
}

test('setup profile keeps Turbo detection byte-for-byte for existing repositories', (t) => {
  const root = profileRepo(t, {
    'package.json': { name: 'a', scripts: { build: 'turbo run build' } },
    'turbo.json': {},
  })
  const all = profileOutputs(root)
  assert.equal(all.turbo, 'true')
  assert.equal(all.turbo_task, 'true')
  assert.equal(all.vite_plus, 'false')
  assert.equal(all.vite_plus_task, 'false')
  const build = profileOutputs(root, { task: 'build' })
  assert.equal(build.turbo_task, 'true')
  assert.equal(build.vite_plus_task, 'false')
  assert.equal(profileOutputs(root, { task: 'lint' }).turbo_task, 'false')
})

test('setup profile ignores a vite-plus dependency without the explicit opt-in', (t) => {
  const root = profileRepo(t, {
    'package.json': {
      name: 'a',
      devDependencies: { 'vite-plus': '^1.3.0' },
      scripts: { build: 'vp run -r build' },
    },
    '.github/code-foundry.yml': 'monorepo_tool: auto\n',
  })
  const outputs = profileOutputs(root, { task: 'build' })
  assert.equal(outputs.vite_plus, 'false')
  assert.equal(outputs.vite_plus_task, 'false')
  assert.equal(outputs.turbo, 'false')
})

test('setup profile opts into Vite+ and turns the Turbo cache off', (t) => {
  for (const line of [
    'monorepo_tool: vite-plus',
    'monorepo_tool: "vite-plus"',
    "monorepo_tool: 'vite-plus' # opt in",
  ]) {
    const root = profileRepo(t, {
      'package.json': { name: 'a', scripts: { build: 'vp run -r build', lint: 'oxlint' } },
      'turbo.json': {},
      '.github/code-foundry.yml': `${line}\n`,
    })
    const all = profileOutputs(root)
    assert.equal(all.vite_plus, 'true', line)
    assert.equal(all.vite_plus_task, 'true', line)
    assert.equal(all.turbo, 'false', line)
    assert.equal(profileOutputs(root, { task: 'build' }).vite_plus_task, 'true', line)
    // A task whose script does not run through vp does not need the task cache.
    assert.equal(profileOutputs(root, { task: 'lint' }).vite_plus_task, 'false', line)
  }
})

/** The shell of a named action step, dedented as the runner would see it. */
function actionStepScript(action, name) {
  const lines = action.split('\n')
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`)
  assert.notEqual(start, -1, `step ${name} exists`)
  const run = lines.findIndex((line, index) => index > start && line.startsWith('      run: |'))
  const script = []
  for (const line of lines.slice(run + 1)) {
    if (/^ {4}- name:/.test(line) || /^ {6}(?:env|shell|if|with|uses|id):/.test(line)) break
    script.push(line.startsWith('        ') ? line.slice(8) : line.trimStart())
  }
  return script.join('\n')
}

function stepScript(name) {
  return actionStepScript(setupAction, name)
}

/** Parse a GITHUB_OUTPUT file, including `name<<DELIMITER` multi-line values. */
function parseOutputs(text) {
  const outputs = {}
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const heredoc = lines[index].match(/^([^=<]+)<<(.+)$/)
    if (heredoc) {
      const value = []
      index += 1
      while (index < lines.length && lines[index] !== heredoc[2]) value.push(lines[index++])
      outputs[heredoc[1]] = value.join('\n')
    } else if (lines[index].includes('=')) {
      const [name, ...rest] = lines[index].split('=')
      outputs[name] = rest.join('=')
    }
  }
  return outputs
}

function toolchainOutputs(root, env = {}) {
  writeFileSync(join(root, '.toolchain.mjs.sh'), stepScript('Detect Vite+ toolchain'))
  const output = join(root, '.github-output')
  const envFile = join(root, '.github-env')
  writeFileSync(output, '')
  writeFileSync(envFile, '')
  const result = spawnSync('bash', [join(root, '.toolchain.mjs.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GITHUB_OUTPUT: output,
      GITHUB_ENV: envFile,
      REPO_FOUNDRY_RUNNER_OS: 'Linux',
      REPO_FOUNDRY_RUNNER_ARCH: 'X64',
      ...env,
    },
  })
  assert.equal(result.status, 0, result.stderr)
  return {
    ...parseOutputs(readFileSync(output, 'utf8')),
    exported: parseOutputs(readFileSync(envFile, 'utf8')),
  }
}

test('the Vite+ cache namespace isolates OS, architecture, runtime, and Vite+ version', (t) => {
  const root = fixture(t, {
    'package.json': { name: 'a' },
    'node_modules/vite-plus/package.json': { name: 'vite-plus', version: '9.9.9' },
  })
  const linux = toolchainOutputs(root)
  assert.match(linux.namespace, /^vite-plus-v1-Linux-X64-node/)
  assert.ok(linux.namespace.includes(`node${process.version}`), linux.namespace)
  assert.match(linux.namespace, /-bun[^-]*-vp9\.9\.9$/)

  const arm = toolchainOutputs(root, { REPO_FOUNDRY_RUNNER_ARCH: 'ARM64' })
  assert.notEqual(arm.namespace, linux.namespace)
  assert.match(arm.namespace, /-Linux-ARM64-/)
  const mac = toolchainOutputs(root, { REPO_FOUNDRY_RUNNER_OS: 'macOS' })
  assert.notEqual(mac.namespace, linux.namespace)

  // A different Vite+ release, or none resolvable, lands in a different namespace.
  write(root, 'node_modules/vite-plus/package.json', { name: 'vite-plus', version: '9.9.10' })
  assert.match(toolchainOutputs(root).namespace, /-vp9\.9\.10$/)
  assert.equal(toolchainOutputs(root).cacheable, 'true')
  // An unresolvable version cannot isolate releases, so caching is skipped.
  rmSync(join(root, 'node_modules'), { recursive: true })
  const unknown = toolchainOutputs(root)
  assert.match(unknown.namespace, /-vpunknown$/)
  assert.equal(unknown.cacheable, 'false')

  // Namespaces are cache-key safe.
  assert.match(linux.namespace, /^[A-Za-z0-9._-]+$/)
})

function viteCacheContract(root, { customPath = '', save = 'true', previousSave = 'false' } = {}) {
  const output = join(root, '.vite-cache-contract-output')
  const envFile = join(root, '.vite-cache-contract-env')
  const script = join(root, '.vite-cache-contract.sh')
  writeFileSync(script, actionStepScript(setupAction, 'Publish Vite+ cache contract'))
  writeFileSync(output, '')
  writeFileSync(envFile, '')
  const result = spawnSync('bash', [script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GITHUB_OUTPUT: output,
      GITHUB_ENV: envFile,
      VITE_PLUS_CUSTOM_CACHE_PATH_B64: Buffer.from(customPath).toString('base64'),
      VITE_PLUS_CACHE_KEY: 'vite-plus-v1-Linux-X64-node24-bun1-vp9.9.9-ci-unit-lock-vite-42-1',
      VITE_PLUS_CACHE_RESTORE_KEYS: [
        'vite-plus-v1-Linux-X64-node24-bun1-vp9.9.9-ci-unit-lock-',
        'vite-plus-v1-Linux-X64-node24-bun1-vp9.9.9-ci-unit-',
        'vite-plus-v1-Linux-X64-node24-bun1-vp9.9.9-',
      ].join('\n'),
      VITE_PLUS_CACHE_SAVE: save,
      CODE_FOUNDRY_VITE_CACHE_SAVE: previousSave,
    },
  })
  assert.equal(result.status, 0, result.stderr)
  return {
    outputs: parseOutputs(readFileSync(output, 'utf8')),
    environment: parseOutputs(readFileSync(envFile, 'utf8')),
  }
}

test('Vite+ cache setup publishes an explicit restore and save contract', (t) => {
  const root = fixture(t, {
    'package.json': { name: 'a' },
    'node_modules/vite-plus/package.json': { name: 'vite-plus', version: '9.9.9' },
  })
  const custom = join(tmpdir(), 'foundry-custom-vite-cache')
  const detected = toolchainOutputs(root, { VITE_CACHE_PATH: custom })
  assert.equal(detected.cacheable, 'true')
  assert.equal(Buffer.from(detected.custom_path_b64, 'base64').toString(), custom)

  // The action step process sees inherited runner env, including relative overrides.
  const relative = toolchainOutputs(root, { VITE_CACHE_PATH: 'relative/cache' })
  assert.equal(
    Buffer.from(relative.custom_path_b64, 'base64').toString(),
    resolve(realpathSync(root), 'relative/cache')
  )
  assert.equal(Buffer.from(toolchainOutputs(root).custom_path_b64, 'base64').toString(), '')

  const contract = viteCacheContract(root, { customPath: custom, save: 'true' })
  assert.equal(contract.outputs.cacheable, 'true')
  assert.equal(contract.outputs.save, 'true')
  assert.match(contract.outputs.key, /^vite-plus-v1-Linux-X64-node24-bun1-vp9\.9\.9-/)
  assert.deepEqual(contract.outputs.path.split('\n'), [
    'node_modules/.vite/task-cache',
    '**/node_modules/.vite/task-cache',
    custom,
  ])
  assert.match(
    contract.outputs['restore-keys'],
    /^vite-plus-v1-Linux-X64-node24-bun1-vp9\.9\.9-ci-unit-lock-/
  )
  assert.equal(contract.environment.CODE_FOUNDRY_VITE_CACHE_KEY, contract.outputs.key)
  assert.equal(contract.environment.CODE_FOUNDRY_VITE_CACHE_PATHS, contract.outputs.path)
  assert.equal(contract.environment.CODE_FOUNDRY_VITE_CACHE_SAVE, 'true')
})

test('Vite+ save intent is preserved across multiple setup calls in one job', (t) => {
  const root = fixture(t)
  assert.equal(
    viteCacheContract(root, { save: 'false', previousSave: 'true' }).outputs.save,
    'true'
  )
  assert.equal(
    viteCacheContract(root, { save: 'false', previousSave: 'false' }).outputs.save,
    'false'
  )
})

test('the Vite+ cache restores last and saves through an explicit push-only action', () => {
  const names = [...setupAction.matchAll(/^ {4}- name: (.+)$/gm)].map((match) => match[1])
  const cache = names.indexOf('Cache Vite+ tasks')
  assert.equal(names[cache - 1], 'Publish Vite+ cache contract')
  assert.equal(names[cache - 2], 'Detect Vite+ toolchain')
  assert.ok(cache > names.indexOf('Install'), 'restored after Install')
  for (const [index, name] of names.entries())
    if (name.startsWith('Save ')) assert.ok(cache > index, `restored after "${name}"`)
  // Nothing follows the cache steps, so later steps cannot replace node_modules.
  assert.equal(cache, names.length - 1)

  const restore = setupAction.slice(setupAction.indexOf('- name: Cache Vite+ tasks'))
  assert.match(restore, /uses: actions\/cache\/restore@v5/)
  assert.doesNotMatch(restore, /uses: \.\/\.github\/actions\/cache/)
  assert.match(restore, /steps\.vite-plus-cache-contract\.outputs\.(?:path|key|restore-keys)/)
  assert.match(cacheSaveAction, /uses: actions\/cache\/save@v5/)
  assert.match(cacheSaveAction, /github\.event_name == 'push'/)
  assert.match(cacheSaveAction, /inputs\.path \|\| env\.CODE_FOUNDRY_VITE_CACHE_PATHS/)
  assert.match(cacheSaveAction, /inputs\.key \|\| env\.CODE_FOUNDRY_VITE_CACHE_KEY/)

  const workflows = [
    ['.github/workflows/ci.yml', ['format', 'lint', 'type-check', 'build']],
    ['.github/workflows/test.yml', ['unit', 'performance', 'integration', 'e2e', 'smoke']],
    ['.github/workflows/eval.yml', ['eval']],
    [
      '.github/workflows/validation-billing.yml',
      ['fast-lanes', 'lint', 'type-check', 'unit', 'e2e'],
    ],
  ]
  for (const [file, jobs] of workflows) {
    const source = readFileSync(join(packageRoot, file), 'utf8')
    const lines = source.split('\n')
    for (const job of jobs) {
      const start = lines.findIndex((line) => line === `  ${job}:`)
      assert.notEqual(start, -1, `${file} contains ${job}`)
      let end = lines.findIndex((line, index) => index > start && /^  [A-Za-z0-9_-]+:$/.test(line))
      if (end === -1) end = lines.length
      const block = lines
        .slice(start, end)
        .filter((line) => !line.startsWith('  #'))
        .join('\n')
        .trimEnd()
      assert.ok(
        block.endsWith('uses: ./.github/actions/cache-save'),
        `${file} ${job} ends with the explicit cache save action`
      )
    }
  }
})

test('repository caches restore only and save through the explicit cache-save action', () => {
  const cacheAction = readFileSync(join(packageRoot, '.github/actions/cache/action.yml'), 'utf8')
  // A nested actions/cache post hook loses the composite inputs and never saves.
  assert.doesNotMatch(cacheAction, /uses: actions\/cache@/)
  assert.match(cacheAction, /uses: actions\/cache\/restore@v5/)
  assert.match(
    cacheAction,
    /if: inputs\.save == 'true' && github\.event_name == 'push' && steps\.restore\.outputs\.cache-hit != 'true'/
  )
  const sources = [
    setupAction,
    ...['test.yml', 'validation-billing.yml'].map((file) =>
      readFileSync(join(packageRoot, '.github/workflows', file), 'utf8')
    ),
  ]
  const ids = new Set()
  for (const source of sources) {
    for (const match of source.matchAll(
      /uses: \.\/\.github\/actions\/cache\n\s+with:\n\s+id: ([a-z0-9-]+)\n/g
    ))
      ids.add(match[1])
    assert.equal(
      [...source.matchAll(/uses: \.\/\.github\/actions\/cache\n/g)].length,
      [...source.matchAll(/uses: \.\/\.github\/actions\/cache\n\s+with:\n\s+id: /g)].length,
      'every repository cache names its save slot first'
    )
  }
  assert.ok(ids.size >= 14)
  const slots = new Set(
    [...cacheSaveAction.matchAll(/env\.CODE_FOUNDRY_CACHE_([A-Z0-9_]+)_KEY != ''/g)].map(
      (match) => match[1]
    )
  )
  for (const id of ids) {
    const name = id.toUpperCase().replaceAll('-', '_')
    assert.ok(slots.has(name), `cache-save saves the ${id} slot`)
    assert.match(
      cacheSaveAction,
      new RegExp(`path: \\$\\{\\{ env\\.CODE_FOUNDRY_CACHE_${name}_PATH \\}\\}`)
    )
  }
  assert.equal(slots.size, ids.size, 'cache-save has no unused slots')
})

test('the Vite+ cache key rolls per run and never crosses a compatibility namespace', () => {
  const step = setupAction.slice(setupAction.indexOf('- name: Publish Vite+ cache contract'))
  const detect = setupAction.slice(
    setupAction.indexOf('- name: Detect Vite+ toolchain'),
    setupAction.indexOf('- name: Publish Vite+ cache contract')
  )
  const namespace = '${{ steps.vite-plus-toolchain.outputs.namespace }}'
  // Detection carries the opt-in gates; the cache step runs only for a resolvable version.
  assert.match(detect, /inputs\.cache-vite-plus != 'false'/)
  assert.match(detect, /steps\.profile\.outputs\.vite_plus == 'true'/)
  assert.match(detect, /steps\.profile\.outputs\.vite_plus_task == 'true'/)
  assert.match(step, /if: steps\.vite-plus-toolchain\.outputs\.cacheable == 'true'/)
  assert.match(step, /inputs\.cache-save/)
  assert.doesNotMatch(step, /turbo/i)

  const key = step.match(/^ {8}VITE_PLUS_CACHE_KEY: (.+)$/m)?.[1] ?? ''
  assert.ok(key.startsWith(namespace), 'key starts with the namespace')
  assert.match(key, /github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}$/)
  const restoreKeys =
    step
      .match(/^ {8}VITE_PLUS_CACHE_RESTORE_KEYS: \|\n((?: {10}.+\n?)+)/m)?.[1]
      ?.trim()
      .split('\n') ?? []
  assert.ok(restoreKeys.length >= 2)
  for (const restoreKey of restoreKeys)
    assert.ok(
      restoreKey.trim().startsWith(namespace),
      `restore key stays in namespace: ${restoreKey}`
    )

  // The generic build archive excludes the directory so it is not saved twice.
  assert.match(
    setupAction,
    /\*\*\/node_modules\/\.vite\n\s+!\*\*\/node_modules\/\.vite\/task-cache/
  )
  // The Turbo cache step is unchanged and still keyed on the Turbo profile.
  assert.match(
    setupAction,
    /- name: Cache Turborepo\n\s+if: >-\n\s+inputs\.install == 'true' &&\n\s+inputs\.install-javascript == 'true' &&\n\s+inputs\.cache-turbo != 'false' &&\n\s+steps\.profile\.outputs\.turbo == 'true'/
  )
})

// --- real Vite+ runtime: task-cache restore -------------------------------
//
// Needs a directory containing an installed vite-plus (node_modules/.bin/vp),
// e.g. `bun add -d vite-plus@1.3.0` in a scratch folder. It is not a dependency
// of this repository, so the suite skips these tests when it is not provided.

const vitePlusDir = process.env.CODE_FOUNDRY_VITE_PLUS_DIR
const needsVitePlus = vitePlusDir
  ? false
  : 'set CODE_FOUNDRY_VITE_PLUS_DIR to run against real Vite+'

/** A two-package workspace whose build scripts read their own source file. */
function vitePlusWorkspace(t) {
  const root = fixture(t, {
    'package.json': { name: 'root', private: true, workspaces: ['packages/*'] },
    'packages/core/package.json': {
      name: '@w/core',
      version: '1.0.0',
      scripts: { build: 'node build.mjs' },
    },
    'packages/ui/package.json': {
      name: '@w/ui',
      version: '1.0.0',
      dependencies: { '@w/core': 'workspace:*' },
      scripts: { build: 'node build.mjs' },
    },
    'packages/core/src/index.ts': 'export const core = 1\n',
    'packages/ui/src/index.ts': 'export const ui = 1\n',
    'packages/core/build.mjs':
      'import {readFileSync} from "node:fs"\nconsole.log("built", readFileSync("src/index.ts", "utf8").trim())\n',
    'packages/ui/build.mjs':
      'import {readFileSync} from "node:fs"\nconsole.log("built", readFileSync("src/index.ts", "utf8").trim())\n',
  })
  install(root)
  return root
}

/** Simulate the Install step: node_modules is replaced from scratch. */
function install(root) {
  rmSync(join(root, 'node_modules'), { recursive: true, force: true })
  mkdirSync(join(root, 'node_modules'))
  for (const entry of readdirSync(join(vitePlusDir, 'node_modules'))) {
    if (entry === '.vite') continue
    symlinkSync(join(vitePlusDir, 'node_modules', entry), join(root, 'node_modules', entry))
  }
}

function vp(root, args, env = {}) {
  const result = spawnSync(join(root, 'node_modules/.bin/vp'), ['run', '--cache', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  return result.stdout
}

const taskCache = (root) => join(root, 'node_modules/.vite/task-cache')

test(
  'real Vite+: a task cache restored after Install replays, one restored before does not',
  {
    skip: needsVitePlus,
  },
  (t) => {
    const root = vitePlusWorkspace(t)
    const store = mkdtempSync(join(tmpdir(), 'foundry-cache-store-'))
    t.after(() => rmSync(store, { recursive: true, force: true }))

    assert.match(vp(root, ['-r', 'build']), /0\/2 cache hit/)
    assert.match(vp(root, ['-r', 'build']), /2\/2 cache hit/)
    cpSync(taskCache(root), join(store, 'task-cache'), { recursive: true })

    // Restoring first and letting Install replace node_modules loses the cache.
    install(root)
    mkdirSync(join(root, 'node_modules/.vite'), { recursive: true })
    cpSync(join(store, 'task-cache'), taskCache(root), { recursive: true })
    install(root)
    assert.equal(existsSync(taskCache(root)), false)
    assert.match(vp(root, ['-r', 'build']), /0\/2 cache hit/)

    // Restoring after Install replays every task.
    install(root)
    mkdirSync(join(root, 'node_modules/.vite'), { recursive: true })
    cpSync(join(store, 'task-cache'), taskCache(root), { recursive: true })
    assert.match(vp(root, ['-r', 'build']), /2\/2 cache hit/)

    // A changed input re-runs only the affected task.
    write(root, 'packages/core/src/index.ts', 'export const core = 2\n')
    const partial = vp(root, ['-r', 'build'])
    assert.match(partial, /cache miss/)
    assert.match(partial, /1\/2 cache hit/)
  }
)

test(
  'real Vite+: VITE_CACHE_PATH moves the cache and it restores on another path',
  {
    skip: needsVitePlus,
  },
  (t) => {
    const root = vitePlusWorkspace(t)
    const first = mkdtempSync(join(tmpdir(), 'foundry-vite-cache-a-'))
    const second = mkdtempSync(join(tmpdir(), 'foundry-vite-cache-b-'))
    t.after(() => {
      rmSync(first, { recursive: true, force: true })
      rmSync(second, { recursive: true, force: true })
    })

    assert.match(vp(root, ['-r', 'build'], { VITE_CACHE_PATH: first }), /0\/2 cache hit/)
    assert.equal(existsSync(taskCache(root)), false, 'default location is untouched')
    assert.ok(readdirSync(first).length > 0, 'cache written to VITE_CACHE_PATH')

    // node_modules replacement cannot affect a cache outside it.
    install(root)
    assert.match(vp(root, ['-r', 'build'], { VITE_CACHE_PATH: first }), /2\/2 cache hit/)

    // Restore into a different directory, as a new runner would.
    cpSync(first, second, { recursive: true })
    install(root)
    assert.match(vp(root, ['-r', 'build'], { VITE_CACHE_PATH: second }), /2\/2 cache hit/)
  }
)

test(
  'real Vite+: the namespace step reports the installed Vite+ version',
  { skip: needsVitePlus },
  (t) => {
    const root = vitePlusWorkspace(t)
    const { namespace } = toolchainOutputs(root)
    const version = JSON.parse(
      readFileSync(join(vitePlusDir, 'node_modules/vite-plus/package.json'), 'utf8')
    ).version
    assert.ok(namespace.endsWith(`-vp${version}`), namespace)
  }
)

test('new repositories receive the monorepo_tool default and stay on auto', (t) => {
  const root = fixture(t, { 'package.json': { name: 'a', version: '1.0.0' } })
  const init = spawnSync(process.execPath, [cli, 'init', '--target', root], { encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  assert.match(
    readFileSync(join(root, '.github/code-foundry.yml'), 'utf8'),
    /^monorepo_tool: auto$/m
  )
})

// --- Cloudflare workflows: the Turbo-only affected check ------------------

/** Run a Cloudflare workflow's "Resolve Turbo package" script for real. */
function resolveTurboPackage(t, workflowFile, files) {
  const text = readFileSync(join(packageRoot, '.github/workflows', workflowFile), 'utf8')
  const stepStart = text.indexOf('- name: Resolve Turbo package')
  const open = text.indexOf("<<'NODE'\n", stepStart)
  const close = text.indexOf('\n          NODE\n', open)
  const script = text
    .slice(open + "<<'NODE'\n".length, close)
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n')
  const root = fixture(t, files)
  const output = join(root, 'out')
  writeFileSync(output, '')
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GITHUB_OUTPUT: output,
      TURBO_FILTER: 'auto',
      WORKSPACE: root,
      WORKING_DIRECTORY: '.',
    },
  })
  assert.equal(result.status, 0, result.stderr)
  return parseOutputs(readFileSync(output, 'utf8'))
}

for (const workflow of ['cloudflare-deploy.yml', 'cloudflare-delivery.yml']) {
  test(`${workflow} skips its Turbo-only check for Vite+ repositories`, (t) => {
    const files = { 'package.json': { name: 'app' }, 'turbo.json': {} }
    const turbo = resolveTurboPackage(t, workflow, files)
    assert.equal(turbo.turbo_enabled, 'true')
    assert.equal(turbo.turbo_package, 'app')

    for (const line of ['monorepo_tool: vite-plus', 'monorepo_tool: "vite-plus" # opt in']) {
      const vitePlus = resolveTurboPackage(t, workflow, {
        ...files,
        '.github/code-foundry.yml': `${line}\n`,
      })
      assert.equal(vitePlus.turbo_enabled, 'false', line)
      assert.equal(vitePlus.should_deploy, 'true', line)
    }
    const auto = resolveTurboPackage(t, workflow, {
      ...files,
      '.github/code-foundry.yml': 'monorepo_tool: auto\n',
    })
    assert.equal(auto.turbo_enabled, 'true')
  })
}
