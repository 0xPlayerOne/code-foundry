#!/usr/bin/env node
// @ts-check

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { detectPackageManager, resolveProfile } from './lib/profile.mjs'
import { configured, readConfig } from './lib/config.mjs'
import { classifyTestFiles } from './lib/test-discovery.mjs'
import { classifyValidationMode, evaluateValidationGate } from './lib/validation-policy.mjs'
import { readReleaseConfig, validateGeneratedReleaseDiff } from './lib/release-policy.mjs'
import { runNodePackagePerformance } from './lib/node-package-performance.mjs'

const root = process.cwd()
const config = readConfig(resolve(root, '.github/code-foundry.yml'))
const repoProfile = resolveProfile(root)
/** @type {string[]} */
const languages = configured(config.languages, repoProfile.languages).split(',').filter(Boolean)
const packageManager = configured(config.package_manager, detectPackageManager(root))
const output = process.env.GITHUB_OUTPUT

/** @param {string} language */
function hasLanguage(language) {
  return languages.includes(language) || languages.includes('all')
}

function hasRootJavascriptProject() {
  return Boolean(readPackage()) && packageManager !== 'none'
}

function hasRootPythonProject() {
  return (
    existsSync(resolve(root, 'pyproject.toml')) ||
    existsSync(resolve(root, 'uv.lock')) ||
    capture('git', ['ls-files', '*requirements*.txt']) !== ''
  )
}

function hasRootRustProject() {
  return existsSync(resolve(root, 'Cargo.toml'))
}

/** @param {string} name */
function hasScript(name) {
  return readPackage()?.scripts?.[name] !== undefined
}

function readPackage() {
  try {
    return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

function performanceEnabled() {
  return configured(config.performance, 'auto') !== 'false'
}

function performanceCommands() {
  const raw = configured(config.performance_command, '').trim()
  if (!raw) return []
  let command
  try {
    command = JSON.parse(raw)
  } catch {
    throw new Error('performance_command must be a JSON argv array or an array of argv arrays.')
  }
  if (!Array.isArray(command) || command.length === 0)
    throw new Error('performance_command must be a non-empty JSON array.')
  const commands = command.every((argument) => typeof argument === 'string') ? [command] : command
  if (
    !commands.every(
      (argv) =>
        Array.isArray(argv) &&
        argv.length > 0 &&
        argv.every((argument) => typeof argument === 'string' && argument.length > 0)
    )
  )
    throw new Error(
      'performance_command must contain one argv array or only non-empty argv arrays of non-empty strings.'
    )
  return /** @type {string[][]} */ (commands)
}

function performanceProfile() {
  const profile = configured(config.performance_profile, '').trim()
  if (!profile) return ''
  if (profile !== 'node-package')
    throw new Error(`Unsupported performance_profile: ${profile}. Expected node-package.`)
  return profile
}

const performanceResultsDirectory = 'performance-results'

/** @returns {{source: string, argv: string[]}[]} */
function selectedPerformanceCommands() {
  const name = ['performance:check', 'perf:check'].find((candidate) => hasScript(candidate))
  if (name) {
    const [manager, args] = packageCommand(['run', name])
    return manager ? [{ source: `package-script:${name}`, argv: [manager, ...args] }] : []
  }
  return performanceCommands().map((argv) => ({ source: 'configuration', argv }))
}

/** @param {string} startedAt @param {'passed'|'failed'} status @param {{source: string, argv: string[], status: number}[]} commands @param {string[]} artifacts @param {string|null} error */
function writePerformanceSummary(startedAt, status, commands, artifacts, error = null) {
  const directory = resolve(root, performanceResultsDirectory)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    resolve(directory, 'summary.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: 'code-foundry-performance-summary',
        status,
        startedAt,
        completedAt: new Date().toISOString(),
        commands,
        profile: performanceProfile() || null,
        artifacts,
        error,
      },
      null,
      2
    )}\n`
  )
}

function runPerformance() {
  if (!performanceEnabled()) return
  const startedAt = new Date().toISOString()
  /** @type {{source: string, argv: string[], status: number}[]} */
  const records = []
  /** @type {string[]} */
  const artifacts = []
  try {
    for (const command of selectedPerformanceCommands()) {
      const result = spawnSync(command.argv[0], command.argv.slice(1), {
        cwd: root,
        stdio: 'inherit',
        env: process.env,
      })
      if (result.error) throw result.error
      const status = result.status ?? 1
      records.push({ ...command, status })
      if (status !== 0) {
        writePerformanceSummary(startedAt, 'failed', records, artifacts, `command exited ${status}`)
        process.exitCode = status
        return
      }
    }
    if (performanceProfile() === 'node-package') {
      const result = runNodePackagePerformance(
        root,
        configured(config.performance_budget_file, 'performance-package-budgets.json'),
        performanceResultsDirectory
      )
      artifacts.push(`${performanceResultsDirectory}/node-package.json`)
      if (!result.passed) {
        writePerformanceSummary(startedAt, 'failed', records, artifacts, result.failures.join('; '))
        process.exitCode = 1
        return
      }
    }
    writePerformanceSummary(startedAt, 'passed', records, artifacts)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writePerformanceSummary(startedAt, 'failed', records, artifacts, message)
    throw error
  }
}

/** @param {string} task */
function validation(task) {
  if (task === 'mode') {
    writeOutput(
      'mode',
      classifyValidationMode({
        eventName: process.env.FOUNDRY_EVENT_NAME ?? '',
        baseRef: process.env.FOUNDRY_BASE_REF ?? '',
        headRef: process.env.FOUNDRY_HEAD_REF ?? '',
        stagingMode: config.staging_validation_mode,
      })
    )
    return
  }
  if (task === 'gate') {
    const mode = process.env.FOUNDRY_MODE ?? ''
    const gate = evaluateValidationGate({
      mode,
      results: {
        ci: process.env.FOUNDRY_CI,
        test: process.env.FOUNDRY_TEST,
        security: process.env.FOUNDRY_SECURITY,
        codeql: process.env.FOUNDRY_CODEQL,
      },
    })
    if (gate.valid) {
      console.log(`Validation gate passed for ${mode} mode.`)
      return
    }
    for (const failure of gate.failures) console.error(`::error::${failure.job}: ${failure.result}`)
    process.exitCode = 1
    return
  }
  if (task === 'release_diff') {
    const baseSha = process.env.FOUNDRY_BASE_SHA ?? ''
    const changedPaths = baseSha
      ? capture('git', ['diff', '--name-only', `${baseSha}...HEAD`]).split(/\r?\n/)
      : []
    const result = validateGeneratedReleaseDiff({
      headRef: process.env.FOUNDRY_HEAD_REF ?? '',
      headRepo: process.env.FOUNDRY_HEAD_REPO ?? '',
      repository: process.env.FOUNDRY_REPOSITORY ?? '',
      changedPaths,
      config: readReleaseConfig(root),
      root,
    })
    if (!result.valid) {
      for (const error of result.errors) console.error(`::error::${error}`)
      process.exitCode = 1
      return
    }
    console.log(`Release policy passed: ${result.changedPaths.length} approved changed path(s).`)
    return
  }
  throw new Error(`Unknown validation task: ${task || '(missing)'}`)
}

/** @param {string} key @param {unknown} value */
function writeOutput(key, value) {
  const line = `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}\n`
  if (output) requireWrite(output, line)
  else console.log(line.trimEnd())
}

/** @param {string} file @param {string} content */
function requireWrite(file, content) {
  appendFileSync(file, content)
}

/** @param {string} command */
function commandExists(command) {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0
}

/** @param {string} command @param {string[]} [args] @param {Record<string, unknown>} [options] */
function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

/** @param {string} command @param {string[]} [args] */
function capture(command, args = []) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: process.env })
  return result.status === 0 ? result.stdout.trim() : ''
}

/** @returns {string[]} */
function repositoryTestFiles() {
  return capture('git', ['ls-files'])
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean)
}

/** @param {'unit'|'integration'|'e2e'|'smoke'} task */
function taskTestFiles(task) {
  return classifyTestFiles(repositoryTestFiles(), task)
}

/** @param {string[]} args @returns {[string|null, string[]]} */
function packageCommand(args) {
  switch (packageManager) {
    case 'bun':
      return ['bun', args]
    case 'pnpm':
      return ['pnpm', args]
    case 'yarn':
      return ['yarn', args]
    case 'npm':
      return ['npm', args]
    default:
      return [null, args]
  }
}

/** @param {string[]} names */
function runScript(names) {
  const name = names.find((candidate) => hasScript(candidate))
  if (!name) return false
  const [manager, args] = packageCommand(['run', name])
  if (!manager) return false
  run(manager, args)
  return true
}

/** @param {string} tool @param {string[]} [args] */
function runTool(tool, args = []) {
  if (['ruff', 'pytest', 'pylint'].includes(tool)) {
    const venvTool = resolve(root, `.venv/bin/${tool}`)
    if (existsSync(venvTool)) return run(venvTool, args)
  }
  const [manager] = packageCommand([])
  if (manager === 'bun') return run('bunx', ['--no-install', tool, ...args])
  if (manager === 'pnpm') return run('pnpm', ['exec', tool, ...args])
  if (manager === 'yarn') return run('yarn', ['exec', tool, ...args])
  if (manager === 'npm') return run('npx', ['--no-install', tool, ...args])
  return run(tool, args)
}

function install() {
  if (existsSync(resolve(root, 'package.json'))) {
    const lock = ['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'].find(
      (file) => existsSync(resolve(root, file))
    )
    if (lock) {
      /** @type {Record<string, [string, string[]]>} */
      const commands = {
        bun: [
          'bun',
          [
            'install',
            '--frozen-lockfile',
            '--ignore-scripts',
            ...(readPackage()?.workspaces ? ['--force', '--linker=hoisted'] : []),
          ],
        ],
        pnpm: ['pnpm', ['install', '--frozen-lockfile', '--prefer-offline']],
        yarn: ['yarn', ['install', '--immutable']],
        npm: ['npm', ['ci', '--prefer-offline', '--no-audit', '--fund=false']],
      }
      const command = commands[packageManager]
      if (command) run(command[0], command[1])
      if (packageManager === 'bun') runScript(['prepare', 'postinstall'])
    }
  }
  if (
    hasLanguage('python') &&
    (existsSync(resolve(root, 'pyproject.toml')) || existsSync(resolve(root, 'requirements.txt')))
  ) {
    if (commandExists('uv') && existsSync(resolve(root, 'uv.lock'))) run('uv', ['sync', '--frozen'])
    else {
      if (!existsSync(resolve(root, '.venv'))) run('python', ['-m', 'venv', '.venv'])
      const python = resolve(root, '.venv/bin/python')
      if (spawnSync(python, ['-m', 'pip', '--version'], { stdio: 'ignore' }).status !== 0) {
        run(python, ['-m', 'ensurepip', '--upgrade'])
      }
      if (existsSync(resolve(root, 'requirements.txt')))
        run(python, [
          '-m',
          'pip',
          'install',
          '--disable-pip-version-check',
          '-r',
          'requirements.txt',
        ])
      if (existsSync(resolve(root, 'requirements-dev.txt')))
        run(python, [
          '-m',
          'pip',
          'install',
          '--disable-pip-version-check',
          '-r',
          'requirements-dev.txt',
        ])
    }
  }
  if (hasLanguage('rust') && existsSync(resolve(root, 'Cargo.toml'))) run('cargo', ['fetch'])
}

/** @param {string} task */
function relevant(task) {
  const js = hasLanguage('typescript') || hasLanguage('javascript')
  const python = hasLanguage('python')
  const rust = hasLanguage('rust')
  const scripted = {
    format: ['format:check', 'format', 'fmt'],
    lint: ['lint'],
    type_check: ['type-check', 'typecheck', 'type:check'],
    build: ['build'],
    unit: ['test:unit', 'test:coverage', 'test'],
    integration: ['test:integration'],
    e2e: ['test:e2e', 'e2e'],
    smoke: ['test:smoke', 'smoke'],
    performance: ['performance:check', 'perf:check'],
  }[task]
  if (task === 'performance') {
    if (!performanceEnabled()) return false
    return Boolean(
      (scripted && scripted.some((candidate) => hasScript(candidate))) ||
      performanceCommands().length > 0 ||
      performanceProfile()
    )
  }
  if (scripted && scripted.some((candidate) => hasScript(candidate)))
    return packageManager !== 'none'
  if (task === 'format' || task === 'lint' || task === 'type_check' || task === 'build') {
    return (
      (js && hasRootJavascriptProject()) ||
      (python && hasRootPythonProject()) ||
      (rust && hasRootRustProject())
    )
  }
  if (['unit', 'integration', 'e2e', 'smoke'].includes(task)) {
    if (taskTestFiles(/** @type {'unit'|'integration'|'e2e'|'smoke'} */ (task)).length > 0)
      return true
    // A project with inline Rust/Python/JavaScript unit tests is still a unit
    // test target even when it has no conventional test file path. Other
    // categories must have an explicit script or discoverable test files so
    // their workflow jobs become skipped instead of successful no-ops.
    if (task === 'unit') {
      return (
        (js && hasRootJavascriptProject()) ||
        (python && hasRootPythonProject()) ||
        (rust && hasRootRustProject()) ||
        (hasLanguage('solidity') && hasRootJavascriptProject())
      )
    }
    return false
  }
  return true
}

/** @param {string} ecosystem */
function hasDependencyManifest(ecosystem) {
  if (ecosystem === 'javascript') {
    const packageJson = readPackage()
    return (
      ['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'].some((file) =>
        existsSync(resolve(root, file))
      ) ||
      Boolean(
        packageJson &&
        ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some(
          (group) => Object.keys(packageJson[group] ?? {}).length
        )
      )
    )
  }
  if (ecosystem === 'rust') return existsSync(resolve(root, 'Cargo.toml'))
  if (ecosystem === 'python')
    return (
      existsSync(resolve(root, 'pyproject.toml')) ||
      existsSync(resolve(root, 'uv.lock')) ||
      capture('git', ['ls-files', '*requirements*.txt']) !== ''
    )
  return false
}

/**
 * Detect repository-owned Oxlint setup: an oxlint dependency (or script
 * reference) or a tracked `.oxlintrc.json` / `oxlint.config.*` file. Oxlint
 * is the baseline's preferred JavaScript linter; repositories without one
 * fall back to their own `lint` script if defined.
 * @returns {boolean}
 */
function hasOxlintSetup() {
  const pkg = readPackage() ?? {}
  const scripts = pkg.scripts ?? {}
  const dependencies = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.optionalDependencies,
    ...pkg.peerDependencies,
  }
  if (dependencies.oxlint) return true
  if (Object.values(scripts).some((value) => /\boxlint\b/.test(String(value)))) return true
  return repositoryTestFiles().some((file) =>
    /(^|\/)(\.oxlintrc\.json|oxlint\.config\.[^/]*)$/.test(file)
  )
}

/**
 * Detect repository-owned Oxfmt setup: an oxfmt dependency (or script
 * reference) or a tracked `.oxfmtrc.json` / `oxfmt.config.*` file. Oxfmt is
 * the baseline's formatter; repositories using a different formatter opt out
 * through their own `format`/`fmt` scripts, which the script fallback honors.
 * @returns {boolean}
 */
function hasOxfmtSetup() {
  const pkg = readPackage() ?? {}
  const scripts = pkg.scripts ?? {}
  const dependencies = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.optionalDependencies,
    ...pkg.peerDependencies,
  }
  if (dependencies.oxfmt) return true
  if (Object.values(scripts).some((value) => /\boxfmt\b/.test(String(value)))) return true
  return repositoryTestFiles().some((file) =>
    /(^|\/)(\.oxfmtrc\.json|oxfmt\.config\.[^/]*)$/.test(file)
  )
}

/** @param {string} task */
function ci(task) {
  if (task === 'install') return install()
  if (task === 'should_run' || task === 'task_profile') {
    const selected = process.argv[4]
    writeOutput('applicable', relevant(selected) ? 'true' : 'false')
    writeOutput(
      'javascript',
      hasLanguage('typescript') || hasLanguage('javascript') ? 'true' : 'false'
    )
    writeOutput('python', hasLanguage('python') ? 'true' : 'false')
    writeOutput('rust', hasLanguage('rust') ? 'true' : 'false')
    return
  }
  if (task === 'format') {
    const scripted = runScript(['format:check', 'format', 'fmt'])
    if (
      !scripted &&
      (hasLanguage('typescript') || hasLanguage('javascript')) &&
      hasRootJavascriptProject() &&
      hasOxfmtSetup()
    ) {
      // Oxfmt is the baseline's formatter. Repositories that use a different
      // formatter keep full control through their own `format`/`fmt` scripts,
      // which the runScript fallback above already honors.
      runTool('oxfmt', ['--check', '.'])
    }
    if (hasLanguage('python') && hasRootPythonProject()) runTool('ruff', ['format', '--check', '.'])
    if (hasLanguage('rust') && hasRootRustProject()) run('cargo', ['fmt', '--check'])
    return
  }
  if (task === 'lint') {
    const scripted = runScript(['lint'])
    if (
      !scripted &&
      (hasLanguage('typescript') || hasLanguage('javascript')) &&
      hasRootJavascriptProject() &&
      hasOxlintSetup()
    ) {
      // Oxlint is the baseline's linter. Repositories that use a different
      // linter keep full control through their own `lint` script, which the
      // runScript fallback above already honors.
      runTool('oxlint', [])
    }
    if (hasLanguage('python') && hasRootPythonProject()) runTool('ruff', ['check', '.'])
    if (hasLanguage('rust') && hasRootRustProject())
      run('cargo', ['clippy', '--all-targets', '--', '-D', 'warnings'])
    return
  }
  if (task === 'type_check') {
    const scripted = runScript(['type-check', 'typecheck', 'type:check'])
    if (!scripted && existsSync(resolve(root, 'tsconfig.json'))) runTool('tsc', ['--noEmit'])
    if (hasLanguage('rust') && hasRootRustProject()) run('cargo', ['check', '--all-targets'])
    return
  }
  if (task === 'build') {
    const scripted = runScript(['build'])
    if (!scripted && hasLanguage('rust') && hasRootRustProject())
      run('cargo', ['build', '--all-targets'])
    return
  }
  if (task === 'performance') {
    return runPerformance()
  }
  /** @type {Record<string, string[]>} */
  const scriptsByTask = {
    unit: ['test:unit', 'test:coverage', 'test'],
    integration: ['test:integration'],
    e2e: ['test:e2e', 'e2e'],
    smoke: ['test:smoke', 'smoke'],
  }
  const scripts = scriptsByTask[task]
  const scripted = scripts ? runScript(scripts) : false
  const testFiles = taskTestFiles(/** @type {'unit'|'integration'|'e2e'|'smoke'} */ (task))
  const javascriptTests = testFiles.filter((file) => /\.(?:[cm]?[jt]sx?)$/i.test(file))
  const pythonTests = testFiles.filter((file) => /\.py$/i.test(file))
  const rustTests = testFiles.filter((file) => /\.rs$/i.test(file))

  // A repository script is authoritative for that package. When it is absent,
  // use Bun's native runner with only the discovered files for the requested
  // category; this prevents smoke/integration files from being re-run as unit
  // tests and avoids no-op category jobs.
  if (
    !scripted &&
    (hasLanguage('typescript') || hasLanguage('javascript') || hasLanguage('solidity')) &&
    hasRootJavascriptProject()
  ) {
    if (javascriptTests.length > 0 || task === 'unit') run('bun', ['test', ...javascriptTests])
  }

  if (hasLanguage('python') && hasRootPythonProject()) {
    const python = existsSync(resolve(root, '.venv/bin/python'))
      ? resolve(root, '.venv/bin/python')
      : 'python'
    if (pythonTests.length > 0 || task === 'unit') run(python, ['-m', 'pytest', ...pythonTests])
  }

  if (hasLanguage('rust') && hasRootRustProject()) {
    if (task === 'unit') {
      // One Cargo graph lets independent target compilation use Cargo's
      // jobserver. Keep the exact prior targets and default-target fallback.
      const args = ['test']
      if (existsSync(resolve(root, 'src/lib.rs'))) args.push('--lib')
      if (existsSync(resolve(root, 'src/main.rs'))) args.push('--bin', packageName())
      run('cargo', args)
    } else {
      // Repeated --test selectors batch compilation without broadening to
      // --tests (which also runs unit targets) or racing Cargo target locks.
      const targets = rustTests.flatMap((file) => {
        const match = file.match(/^tests\/(.+)\.rs$/)
        return match && !match[1].includes('/') ? ['--test', match[1]] : []
      })
      if (targets.length > 0) run('cargo', ['test', ...targets])
    }
  }
}

function packageName() {
  const cargo = readFileSafe(resolve(root, 'Cargo.toml'))
  return cargo?.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? 'app'
}

/** @param {string} file */
function readFileSafe(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** @param {string} task @param {string} ecosystem */
function security(task, ecosystem) {
  if (task === 'profile') {
    writeOutput('javascript', hasDependencyManifest('javascript') ? 'true' : 'false')
    writeOutput('rust', hasDependencyManifest('rust') ? 'true' : 'false')
    writeOutput('python', hasDependencyManifest('python') ? 'true' : 'false')
    const requirements = capture('git', ['ls-files', '*requirements*.txt'])
      .split('\n')
      .filter(Boolean)
    writeOutput(
      'python_requirements',
      hasDependencyManifest('python')
        ? requirements.length
          ? requirements
          : ['project']
        : ['none']
    )
    writeOutput('dependency_review', featureEnabled('dependency_review') ? 'true' : 'false')
    return
  }
  if (task === 'should_run') {
    writeOutput('applicable', hasDependencyManifest(ecosystem) ? 'true' : 'false')
    return
  }
  if (ecosystem === 'javascript' && existsSync(resolve(root, 'package.json'))) {
    const ignores = existsSync(resolve(root, '.github/security-audit-allowlist.txt'))
      ? readFileSync(resolve(root, '.github/security-audit-allowlist.txt'), 'utf8')
          .split(/\r?\n/)
          .filter((line) => line && !line.startsWith('#'))
      : []
    /** @type {Record<string, [string, string[]]>} */
    const commands = {
      bun: [
        'bun',
        ['audit', '--audit-level=high', ...ignores.flatMap((advisory) => ['--ignore', advisory])],
      ],
      pnpm: ['pnpm', ['audit', '--audit-level', 'high']],
      yarn: ['yarn', ['npm', 'audit', '--all', '--recursive']],
      npm: ['npm', ['audit', '--audit-level=high']],
    }
    const command = commands[packageManager]
    if (command) run(command[0], command[1])
  } else if (ecosystem === 'rust' && existsSync(resolve(root, 'Cargo.toml'))) {
    if (!commandExists('cargo-audit'))
      run('cargo', ['install', 'cargo-audit', '--locked', '--quiet'])
    run('cargo', ['audit'])
  } else if (ecosystem === 'python' && hasDependencyManifest('python')) {
    const requirement = process.env.REPO_FOUNDRY_PYTHON_REQUIREMENT
    const auditArgs =
      requirement && !['project', 'none'].includes(requirement) ? ['-r', requirement] : []
    if (commandExists('uv'))
      run('uv', ['tool', 'run', '--from', 'pip-audit==2.10.1', 'pip-audit', ...auditArgs])
    else {
      run('python', ['-m', 'pip', 'install', '--quiet', 'pip-audit==2.10.1'])
      run('python', ['-m', 'pip_audit', ...auditArgs])
    }
  }
}

/** @param {string} key */
function featureEnabled(key) {
  const policy = config[key] ?? 'auto'
  if (policy === 'false') return false
  if (policy === 'true') return true
  return isPublicRepository()
}

function isPublicRepository() {
  const visibility = process.env.REPO_FOUNDRY_VISIBILITY
  return visibility ? visibility === 'public' : process.env.REPO_FOUNDRY_PRIVATE !== 'true'
}

function codeql() {
  const enabled =
    featureEnabled('codeql') &&
    (isPublicRepository() || process.env.REPO_FOUNDRY_CODE_SECURITY === 'enabled')
  writeOutput('enabled', enabled ? 'true' : 'false')
  if (!enabled) {
    writeOutput('languages', [])
    for (const language of ['actions', 'javascript', 'python', 'rust']) {
      writeOutput(`${language}_available`, 'false')
      writeOutput(`${language}_changed`, 'false')
      writeOutput(`${language}_build_mode`, 'none')
    }
    return
  }
  const available = []
  if (existsSync(resolve(root, '.github/workflows'))) available.push('actions')
  if (hasLanguage('typescript') || hasLanguage('javascript'))
    available.push('javascript-typescript')
  if (hasLanguage('python')) available.push('python')
  if (hasLanguage('rust')) available.push('rust')
  // Upload every configured language on every analysis run so GitHub can
  // compare pull requests against the base branch's code-scanning config.
  const languagesJson = available.map((language) => ({
    language,
    name:
      language === 'javascript-typescript'
        ? 'TypeScript'
        : language[0].toUpperCase() + language.slice(1),
    'build-mode': 'none',
    changed: true,
  }))
  writeOutput('languages', languagesJson)
  for (const language of ['actions', 'javascript-typescript', 'python', 'rust']) {
    const entry = languagesJson.find((item) => item.language === language)
    const prefix = language === 'javascript-typescript' ? 'javascript' : language
    writeOutput(`${prefix}_available`, entry ? 'true' : 'false')
    writeOutput(`${prefix}_changed`, entry?.changed ? 'true' : 'false')
    writeOutput(`${prefix}_build_mode`, entry?.['build-mode'] ?? 'none')
  }
}

/** @param {string} command */
function printProfile(command) {
  if (command === 'get') {
    const key = process.argv[4]
    console.log(
      config[key] ??
        (key === 'languages'
          ? languages.join(',')
          : key === 'package_manager'
            ? packageManager
            : '')
    )
    return
  }
  writeOutput('languages', languages.join(','))
  writeOutput('package_manager', packageManager)
  writeOutput('release_type', config.release_type ?? 'auto')
  writeOutput('npm_publish', config.npm_publish ?? 'false')
}

function preCommit() {
  const changed = capture('git', ['diff', '--cached', '--name-only'])
  if (!changed) return
  const check = spawnSync('git', ['diff', '--cached', '--check'], { cwd: root, stdio: 'inherit' })
  if (check.status !== 0) process.exit(check.status ?? 1)
  if (/\.(js|jsx|ts|tsx|json|md|mdx|yml|yaml)$/.test(changed)) {
    ci('format')
    ci('lint')
  }
  if (/\.rs$|(^|\/)Cargo\.toml$/.test(changed)) {
    run('cargo', ['fmt', '--check'])
    run('cargo', ['clippy', '--all-targets', '--', '-D', 'warnings'])
  }
  if (/\.py$|(^|\/)(pyproject\.toml|requirements[^/]*\.txt)$/.test(changed)) {
    runTool('ruff', ['format', '--check', '.'])
    runTool('ruff', ['check', '.'])
  }
}

const [area, task, ecosystem] = process.argv.slice(2)
try {
  if (area === 'ci') ci(task)
  else if (area === 'security') security(task, ecosystem)
  else if (area === 'codeql') codeql()
  else if (area === 'profile') printProfile(task)
  else if (area === 'validation') validation(task)
  else if (area === 'pre-commit') preCommit()
  else throw new Error(`Unknown runtime command: ${area || '(missing)'}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
