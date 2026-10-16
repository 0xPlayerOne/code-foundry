import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
  const npm = fixture(t, workspace)
  assert.deepEqual(
    listWorkspacePackages(npm)
      .map((item) => item.name)
      .toSorted(),
    ['root', '@w/core', '@w/tools', '@w/ui', '@w/web'].toSorted()
  )
  const ui = listWorkspacePackages(npm).find((item) => item.name === '@w/ui')
  assert.deepEqual(ui?.dependencies, ['@w/core'])

  const pnpm = fixture(t, {
    'package.json': { private: true },
    'pnpm-workspace.yaml': "packages:\n  - 'libs/*'\n  - '!libs/legacy'\n",
    'libs/a/package.json': pkg('a'),
    'libs/legacy/package.json': pkg('legacy'),
  })
  assert.deepEqual(
    listWorkspacePackages(pnpm).map((item) => item.name),
    ['//', 'a']
  )
})

test('affectedFromChangedFiles adds transitive dependents only', (t) => {
  const packages = listWorkspacePackages(fixture(t, workspace))
  assert.deepEqual(affectedFromChangedFiles(packages, ['packages/core/src/index.ts']), {
    all: false,
    packages: ['@w/core', '@w/ui', '@w/web'],
  })
  assert.deepEqual(affectedFromChangedFiles(packages, ['packages/tools/src/index.ts']), {
    all: false,
    packages: ['@w/tools'],
  })
  assert.deepEqual(affectedFromChangedFiles(packages, ['README.md']), {
    all: false,
    packages: ['root'],
  })
  assert.deepEqual(affectedFromChangedFiles(packages, []), { all: false, packages: [] })
  for (const file of [
    'bun.lock',
    'package.json',
    'pnpm-workspace.yaml',
    'turbo.json',
    'vite.config.ts',
    'tsconfig.base.json',
    '.mise.toml',
  ])
    assert.equal(affectedFromChangedFiles(packages, [file]).all, true, file)
  // A nested file named like a global file only affects its own package.
  assert.equal(affectedFromChangedFiles(packages, ['packages/tools/package.json']).all, false)
})

test('vite-plus affected selection uses git and the workspace graph', (t) => {
  const { root, base, head } = workspaceRepo(t, (dir) =>
    write(dir, 'packages/core/src/index.ts', 'export const changed = true\n')
  )
  const result = affectedPackages(root, { base, head, tool: 'vite-plus' })
  assert.equal(result.tool, 'vite-plus')
  assert.equal(result.all, false)
  assert.equal(result.conservative, false)
  assert.equal(result.changedFiles, 1)
  assert.deepEqual(result.packages, ['@w/core', '@w/ui', '@w/web'])
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

test('vite-plus selection handles global, root-only, and empty changes', (t) => {
  const lock = workspaceRepo(t, (dir) => write(dir, 'bun.lock', 'changed\n'))
  const global = affectedPackages(lock.root, { ...lock, tool: 'vite-plus' })
  assert.equal(global.all, true)
  assert.equal(global.conservative, false)
  assert.deepEqual(global.filterArgs, [])
  assert.equal(global.packages.length, 5)

  const readme = workspaceRepo(t, (dir) => write(dir, 'README.md', 'changed\n'))
  const rootOnly = affectedPackages(readme.root, { ...readme, tool: 'vite-plus' })
  assert.deepEqual(rootOnly.packages, ['root'])
  assert.deepEqual(rootOnly.filterArgs, ['-w'])

  const empty = workspaceRepo(t, () => {})
  const nothing = affectedPackages(empty.root, { ...empty, tool: 'vite-plus' })
  assert.deepEqual(nothing.packages, [])
  assert.deepEqual(nothing.filterArgs, [])
  assert.equal(nothing.all, false)
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

test('setup action stores the Vite+ task cache once and gates it on the opt-in', () => {
  const step = setupAction.slice(
    setupAction.indexOf('- name: Cache Vite+ tasks'),
    setupAction.indexOf('- name: Configure remote Turbo')
  )
  assert.match(step, /inputs\.cache-vite-plus != 'false'/)
  assert.match(step, /steps\.profile\.outputs\.vite_plus == 'true'/)
  assert.match(step, /steps\.profile\.outputs\.vite_plus_task == 'true'/)
  assert.match(step, /node_modules\/\.vite\/task-cache/)
  assert.match(step, /save: \$\{\{ inputs\.cache-save \}\}/)
  assert.doesNotMatch(step, /turbo/i)
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

test('new repositories receive the monorepo_tool default and stay on auto', (t) => {
  const root = fixture(t, { 'package.json': { name: 'a', version: '1.0.0' } })
  const init = spawnSync(process.execPath, [cli, 'init', '--target', root], { encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  assert.match(
    readFileSync(join(root, '.github/code-foundry.yml'), 'utf8'),
    /^monorepo_tool: auto$/m
  )
})
