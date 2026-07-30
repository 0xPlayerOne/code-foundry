#!/usr/bin/env node
// @ts-check

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { detectPackageManager, resolveProfile } from './lib/profile.mjs'
import { configured, readConfig } from './lib/config.mjs'

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
  return existsSync(resolve(root, 'pyproject.toml')) ||
    existsSync(resolve(root, 'uv.lock')) ||
    capture('git', ['ls-files', '*requirements*.txt']) !== ''
}

function hasRootRustProject() {
  return existsSync(resolve(root, 'Cargo.toml'))
}

/** @param {string} name */
function hasScript(name) {
  return readPackage()?.scripts?.[name] !== undefined
}

function readPackage() {
  try { return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) } catch { return null }
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
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env, ...options })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

/** @param {string} command @param {string[]} [args] */
function capture(command, args = []) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: process.env })
  return result.status === 0 ? result.stdout.trim() : ''
}

/** @param {string[]} args @returns {[string|null, string[]]} */
function packageCommand(args) {
  switch (packageManager) {
    case 'bun': return ['bun', args]
    case 'pnpm': return ['pnpm', args]
    case 'yarn': return ['yarn', args]
    case 'npm': return ['npm', args]
    default: return [null, args]
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
    const lock = ['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'].find((file) => existsSync(resolve(root, file)))
    if (lock) {
      /** @type {Record<string, [string, string[]]>} */
      const commands = {
        bun: ['bun', ['install', '--frozen-lockfile', '--ignore-scripts', ...(readPackage()?.workspaces ? ['--force', '--linker=hoisted'] : [])]],
        pnpm: ['pnpm', ['install', '--frozen-lockfile', '--prefer-offline']],
        yarn: ['yarn', ['install', '--immutable']],
        npm: ['npm', ['ci', '--prefer-offline', '--no-audit', '--fund=false']],
      }
      const command = commands[packageManager]
      if (command) run(command[0], command[1])
      if (packageManager === 'bun') runScript(['prepare', 'postinstall'])
    }
  }
  if (hasLanguage('python') && (existsSync(resolve(root, 'pyproject.toml')) || existsSync(resolve(root, 'requirements.txt')))) {
    if (commandExists('uv') && existsSync(resolve(root, 'uv.lock'))) run('uv', ['sync', '--frozen'])
    else {
      if (!existsSync(resolve(root, '.venv'))) run('python', ['-m', 'venv', '.venv'])
      const python = resolve(root, '.venv/bin/python')
      if (spawnSync(python, ['-m', 'pip', '--version'], { stdio: 'ignore' }).status !== 0) {
        run(python, ['-m', 'ensurepip', '--upgrade'])
      }
      if (existsSync(resolve(root, 'requirements.txt'))) run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', 'requirements.txt'])
      if (existsSync(resolve(root, 'requirements-dev.txt'))) run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', 'requirements-dev.txt'])
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
  }[task]
  if (scripted && scripted.some((candidate) => hasScript(candidate))) return packageManager !== 'none'
  if (task === 'format' || task === 'lint' || task === 'type_check' || task === 'build') {
    return (js && hasRootJavascriptProject()) || (python && hasRootPythonProject()) || (rust && hasRootRustProject())
  }
  if (['unit', 'integration', 'e2e', 'smoke'].includes(task)) {
    return (js && hasRootJavascriptProject()) || (python && hasRootPythonProject()) ||
      (rust && hasRootRustProject()) || (hasLanguage('solidity') && hasRootJavascriptProject())
  }
  return true
}

/** @param {string} ecosystem */
function hasDependencyManifest(ecosystem) {
  if (ecosystem === 'javascript') {
    const packageJson = readPackage()
    return ['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'].some((file) => existsSync(resolve(root, file))) ||
      Boolean(packageJson && ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some((group) => Object.keys(packageJson[group] ?? {}).length))
  }
  if (ecosystem === 'rust') return existsSync(resolve(root, 'Cargo.toml'))
  if (ecosystem === 'python') return existsSync(resolve(root, 'pyproject.toml')) || existsSync(resolve(root, 'uv.lock')) || capture('git', ['ls-files', '*requirements*.txt']) !== ''
  return false
}

/** @param {string} task */
function ci(task) {
  if (task === 'install') return install()
  if (task === 'should_run' || task === 'task_profile') {
    const selected = process.argv[4]
    writeOutput('applicable', relevant(selected) ? 'true' : 'false')
    writeOutput('javascript', (hasLanguage('typescript') || hasLanguage('javascript')) ? 'true' : 'false')
    writeOutput('python', hasLanguage('python') ? 'true' : 'false')
    writeOutput('rust', hasLanguage('rust') ? 'true' : 'false')
    return
  }
  if (task === 'format') {
    const scripted = runScript(['format:check', 'format', 'fmt'])
    if (!scripted && (hasLanguage('typescript') || hasLanguage('javascript')) && hasRootJavascriptProject()) runTool('prettier', ['--check', '.'])
    if (hasLanguage('python') && hasRootPythonProject()) runTool('ruff', ['format', '--check', '.'])
    if (hasLanguage('rust') && hasRootRustProject()) run('cargo', ['fmt', '--check'])
    return
  }
  if (task === 'lint') {
    const scripted = runScript(['lint'])
    if (!scripted && (hasLanguage('typescript') || hasLanguage('javascript')) && hasRootJavascriptProject()) runTool('eslint', ['.'])
    if (hasLanguage('python') && hasRootPythonProject()) runTool('ruff', ['check', '.'])
    if (hasLanguage('rust') && hasRootRustProject()) run('cargo', ['clippy', '--all-targets', '--', '-D', 'warnings'])
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
    if (!scripted && hasLanguage('rust') && hasRootRustProject()) run('cargo', ['build', '--all-targets'])
    return
  }
  /** @type {Record<string, string[]>} */
  const scriptsByTask = {
    unit: ['test:unit', 'test:coverage', 'test'],
    integration: ['test:integration'],
    e2e: ['test:e2e', 'e2e'],
    smoke: ['test:smoke', 'smoke'],
  }
  const scripts = scriptsByTask[task]
  if (scripts) runScript(scripts)
  if (hasLanguage('rust') && hasRootRustProject()) run('cargo', ['test'])
  if (hasLanguage('python') && hasRootPythonProject()) {
    const python = existsSync(resolve(root, '.venv/bin/python')) ? resolve(root, '.venv/bin/python') : 'python'
    const integrationTests = resolve(root, 'tests/integration')
    if (task !== 'integration' || existsSync(integrationTests)) {
      run(python, ['-m', 'pytest', ...(task === 'integration' ? ['tests/integration'] : [])])
    }
  }
}

/** @param {string} task @param {string} ecosystem */
function security(task, ecosystem) {
  if (task === 'profile') {
    writeOutput('javascript', hasDependencyManifest('javascript') ? 'true' : 'false')
    writeOutput('rust', hasDependencyManifest('rust') ? 'true' : 'false')
    writeOutput('python', hasDependencyManifest('python') ? 'true' : 'false')
    const requirements = capture('git', ['ls-files', '*requirements*.txt']).split('\n').filter(Boolean)
    writeOutput('python_requirements', hasDependencyManifest('python') ? (requirements.length ? requirements : ['project']) : ['none'])
    writeOutput('dependency_review', featureEnabled('dependency_review') ? 'true' : 'false')
    return
  }
  if (task === 'should_run') {
    writeOutput('applicable', hasDependencyManifest(ecosystem) ? 'true' : 'false')
    return
  }
  if (ecosystem === 'javascript' && existsSync(resolve(root, 'package.json'))) {
    const ignores = existsSync(resolve(root, '.github/security-audit-allowlist.txt'))
      ? readFileSync(resolve(root, '.github/security-audit-allowlist.txt'), 'utf8').split(/\r?\n/).filter((line) => line && !line.startsWith('#'))
      : []
    /** @type {Record<string, [string, string[]]>} */
    const commands = {
      bun: ['bun', ['audit', '--audit-level=high', ...ignores.flatMap((advisory) => ['--ignore', advisory])]],
      pnpm: ['pnpm', ['audit', '--audit-level', 'high']],
      yarn: ['yarn', ['npm', 'audit', '--all', '--recursive']],
      npm: ['npm', ['audit', '--audit-level=high']],
    }
    const command = commands[packageManager]
    if (command) run(command[0], command[1])
  } else if (ecosystem === 'rust' && existsSync(resolve(root, 'Cargo.toml'))) {
    if (!commandExists('cargo-audit')) run('cargo', ['install', 'cargo-audit', '--locked', '--quiet'])
    run('cargo', ['audit'])
  } else if (ecosystem === 'python' && hasDependencyManifest('python')) {
    const requirement = process.env.REPO_FOUNDRY_PYTHON_REQUIREMENT
    const auditArgs = requirement && !['project', 'none'].includes(requirement) ? ['-r', requirement] : []
    if (commandExists('uv')) run('uv', ['tool', 'run', '--from', 'pip-audit==2.10.1', 'pip-audit', ...auditArgs])
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
  const enabled = featureEnabled('codeql') &&
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
  if (hasLanguage('typescript') || hasLanguage('javascript')) available.push('javascript-typescript')
  if (hasLanguage('python')) available.push('python')
  if (hasLanguage('rust')) available.push('rust')
  // Upload every configured language on every analysis run so GitHub can
  // compare pull requests against the base branch's code-scanning config.
  const languagesJson = available.map((language) => ({ language, name: language === 'javascript-typescript' ? 'TypeScript' : language[0].toUpperCase() + language.slice(1), 'build-mode': 'none', changed: true }))
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
    console.log(config[key] ?? (key === 'languages' ? languages.join(',') : key === 'package_manager' ? packageManager : ''))
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
  if (/\.(js|jsx|ts|tsx|json|md|mdx|yml|yaml)$/.test(changed)) { ci('format'); ci('lint') }
  if (/\.rs$|(^|\/)Cargo\.toml$/.test(changed)) { run('cargo', ['fmt', '--check']); run('cargo', ['clippy', '--all-targets', '--', '-D', 'warnings']) }
  if (/\.py$|(^|\/)(pyproject\.toml|requirements[^/]*\.txt)$/.test(changed)) { runTool('ruff', ['format', '--check', '.']); runTool('ruff', ['check', '.']) }
}

const [area, task, ecosystem] = process.argv.slice(2)
try {
  if (area === 'ci') ci(task)
  else if (area === 'security') security(task, ecosystem)
  else if (area === 'codeql') codeql()
  else if (area === 'profile') printProfile(task)
  else if (area === 'pre-commit') preCommit()
  else throw new Error(`Unknown runtime command: ${area || '(missing)'}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
