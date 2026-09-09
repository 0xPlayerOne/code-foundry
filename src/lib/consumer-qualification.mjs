// @ts-check
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @param {string} file */
export function digest(file) {
  if (!lstatSync(file).isFile()) throw new Error(`Expected a regular file: ${file}`)
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Snapshot consumer-owned bytes, never Git metadata or dependency directories.
 * @param {string} root @param {string} [prefix]
 * @returns {Record<string, string>}
 */
export function snapshot(root, prefix = '') {
  /** @type {Record<string, string>} */
  const result = {}
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(entry.name)) continue
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`Unexpected fixture symlink: ${name}`)
    if (entry.isDirectory()) Object.assign(result, snapshot(root, name))
    else if (entry.isFile()) result[name] = digest(join(root, name))
  }
  return result
}

/** @param {string} command @param {string[]} args @param {string} cwd */
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CI: 'true', npm_config_update_notifier: 'false' },
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status ?? result.error?.message})\n${result.stderr}\n${result.stdout}`
    )
  }
  return result.stdout
}

export const FIXTURES = [
  { name: 'npm-direct', manager: 'npm', lock: 'package-lock.json', topology: 'direct' },
  { name: 'pnpm-direct', manager: 'pnpm', lock: 'pnpm-lock.yaml', topology: 'direct' },
  { name: 'yarn-staging', manager: 'yarn', lock: 'yarn.lock', topology: 'staging-release' },
  { name: 'bun-mise', manager: 'bun', lock: 'bun.lock', topology: 'direct' },
  { name: 'nested-rust', manager: '', lock: '', topology: 'direct' },
  { name: 'nested-python', manager: '', lock: '', topology: 'direct' },
]

/** @param {string} root @param {(typeof FIXTURES)[number]} fixture */
export function seedFixture(root, fixture) {
  mkdirSync(join(root, '.github/workflows'), { recursive: true })
  const authored = '# Consumer-owned instructions\n\nPreserve this paragraph exactly.\n'
  writeFileSync(join(root, 'AGENTS.md'), authored)
  writeFileSync(
    join(root, '.github/workflows/custom.yml'),
    'name: Custom\non: workflow_dispatch\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preserved\n'
  )
  writeFileSync(join(root, 'LICENSE'), 'Consumer-owned license\n')
  if (fixture.manager) {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify(
        {
          name: `qualification-${fixture.name}`,
          version: '0.0.0',
          private: true,
          scripts: { 'test:unit': 'node -e "process.exit(0)"' },
        },
        null,
        2
      ) + '\n'
    )
    const locks = {
      npm: '{"name":"fixture","lockfileVersion":3,"packages":{}}\n',
      pnpm: "lockfileVersion: '9.0'\nimporters: {}\n",
      yarn: '# yarn lockfile v1\n',
      bun: '{"lockfileVersion":1,"workspaces":{},"packages":{}}\n',
    }
    writeFileSync(
      join(root, fixture.lock),
      locks[/** @type {keyof typeof locks} */ (fixture.manager)]
    )
  } else if (fixture.name === 'nested-rust') {
    mkdirSync(join(root, 'native/core/src'), { recursive: true })
    writeFileSync(
      join(root, 'native/core/Cargo.toml'),
      '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n'
    )
    writeFileSync(join(root, 'native/core/src/lib.rs'), 'pub fn value() -> u8 { 1 }\n')
  } else {
    mkdirSync(join(root, 'services/api'), { recursive: true })
    writeFileSync(
      join(root, 'services/api/pyproject.toml'),
      '[project]\nname = "fixture"\nversion = "0.1.0"\n'
    )
    writeFileSync(join(root, 'services/api/app.py'), 'VALUE = 1\n')
  }
  if (fixture.name === 'bun-mise') writeFileSync(join(root, '.mise.toml'), '[tools]\nnode = "22"\n')
  // Explicit topology only; init must still detect languages and lockfiles.
  writeFileSync(
    join(root, '.github/code-foundry.yml'),
    `git_workflow: ${fixture.topology}\nmerge_strategy: ${fixture.topology === 'direct' ? 'squash' : 'rebase'}\nrelease_merge_strategy: ${fixture.topology === 'direct' ? 'squash' : 'rebase'}\n`
  )
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Localize only this candidate's remote workflow calls for Actionlint's local
 * caller/callee contract checks. Production files are never rewritten.
 * @param {string} text @param {string} repository @param {string} ref
 */
export function localizeCalls(text, repository, ref) {
  const pattern = new RegExp(
    `(uses:\\s*)${escapeRegExp(repository)}/\\.github/workflows/([A-Za-z0-9_.-]+)@${escapeRegExp(ref)}(?=\\s|$)`,
    'g'
  )
  return text.replace(pattern, '$1./.github/workflows/$2')
}

/** @param {string} consumer @param {string} candidate @param {string} destination @param {string} actionlint @param {string} version */
function lintContracts(consumer, candidate, destination, actionlint, version) {
  mkdirSync(join(destination, '.github/workflows'), { recursive: true })
  run('git', ['init', '-q'], destination)
  cpSync(join(candidate, '.github'), join(destination, '.github'), { recursive: true })
  // Event callers in the candidate are not reusable-workflow dependencies.
  for (const name of readdirSync(join(destination, '.github/workflows'))) {
    if (name.includes('_self-ci')) rmSync(join(destination, '.github/workflows', name))
  }
  const paths = []
  for (const name of readdirSync(join(consumer, '.github/workflows'))) {
    if (!/\.ya?ml$/.test(name)) continue
    const target = join(destination, '.github/workflows', `consumer-${name}`)
    const text = readFileSync(join(consumer, '.github/workflows', name), 'utf8')
    writeFileSync(target, localizeCalls(text, '0xPlayerOne/code-foundry', `v${version}`))
    paths.push(target)
  }
  // Check all candidate callees as well as rendered callers, without executing them.
  const workflows = readdirSync(join(destination, '.github/workflows')).filter((name) =>
    /\.ya?ml$/.test(name)
  )
  run(
    actionlint,
    [
      '-shellcheck=',
      '-pyflakes=',
      ...workflows.map((name) => join(destination, '.github/workflows', name)),
    ],
    destination
  )
  return paths.length
}

/** @param {{ packageFile: string, sourceSha: string, reportPath: string, actionlint?: string }} options */
export function qualifyCandidate(options) {
  if (!/^[a-f0-9]{40}$/.test(options.sourceSha))
    throw new Error('An exact 40-character source SHA is required')
  const packageFile = resolve(options.packageFile)
  const before = digest(packageFile)
  const temporary = mkdtempSync(join(tmpdir(), 'code-foundry-qualification-'))
  const report = {
    schema_version: 1,
    source_sha: options.sourceSha,
    artifact_sha256: before,
    node: process.version,
    complete: false,
    actionlint: Boolean(options.actionlint),
    /** @type {Array<{ name: string, status: string }>} */ fixtures: [],
  }
  try {
    const host = join(temporary, 'host')
    mkdirSync(host)
    writeFileSync(join(host, 'package.json'), '{"private":true}\n')
    run(
      'npm',
      [
        'install',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        packageFile,
      ],
      host
    )
    const candidate = join(host, 'node_modules/code-foundry')
    const manifest = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'))
    assert.equal(manifest.name, 'code-foundry')
    assert.equal(manifest.bin?.['code-foundry'], 'src/cli.mjs')
    const cli = join(candidate, 'src/cli.mjs')
    assert.match(run(process.execPath, [cli, '--help'], host), /code-foundry/)
    for (const fixture of FIXTURES) {
      const root = join(temporary, fixture.name)
      seedFixture(root, fixture)
      run('git', ['init', '-q'], root)
      const original = snapshot(root)
      run(process.execPath, [cli, 'init', '--target', root], root)
      assert.ok(
        readFileSync(join(root, 'AGENTS.md'), 'utf8').startsWith(
          '# Consumer-owned instructions\n\nPreserve this paragraph exactly.\n'
        )
      )
      const initialized = snapshot(root)
      for (const [name, hash] of Object.entries(original)) {
        if (name === 'AGENTS.md' || name === '.github/code-foundry.yml') continue
        assert.equal(initialized[name], hash, `${fixture.name}: authored ${name} was changed`)
      }
      if (fixture.manager)
        assert.match(
          readFileSync(join(root, '.github/code-foundry.yml'), 'utf8'),
          new RegExp(`^package_manager: ${fixture.manager}$`, 'm')
        )
      for (let pass = 0; pass < 2; pass++) {
        run(process.execPath, [cli, 'sync', '--target', root], root)
        assert.deepEqual(snapshot(root), initialized, `${fixture.name}: sync is not idempotent`)
      }
      if (options.actionlint)
        lintContracts(
          root,
          candidate,
          join(temporary, `lint-${fixture.name}`),
          options.actionlint,
          manifest.version
        )
      report.fixtures.push({ name: fixture.name, status: 'passed' })
    }
    assert.equal(digest(packageFile), before, 'Candidate archive changed during qualification')
    report.complete = true
    return report
  } finally {
    mkdirSync(dirname(resolve(options.reportPath)), { recursive: true })
    writeFileSync(options.reportPath, JSON.stringify(report, null, 2) + '\n')
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [packageFile, sourceSha, reportPath, actionlint, ...extra] = process.argv.slice(2)
    if (!packageFile || !sourceSha || !reportPath || extra.length)
      throw new Error(
        'Usage: node consumer-qualification.mjs PACKAGE.tgz SOURCE_SHA REPORT.json [ACTIONLINT]'
      )
    console.log(
      JSON.stringify(qualifyCandidate({ packageFile, sourceSha, reportPath, actionlint }))
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
