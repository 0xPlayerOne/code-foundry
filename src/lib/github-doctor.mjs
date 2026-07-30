// @ts-check

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/** @param {string} root @returns {{ errors: string[], warnings: string[], details: Record<string, unknown> }} */
export function doctorGithub(root) {
  const repository = process.env.GITHUB_REPOSITORY || remoteRepository(root)
  if (!repository) throw new Error('Unable to determine GitHub repository; set GITHUB_REPOSITORY.')
  if (!commandExists('gh')) throw new Error('GitHub-aware doctor requires the `gh` CLI.')
  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []
  /** @type {Record<string, any>} */
  const details = { repository }
  const protection = ghJson(['api', `repos/${repository}/branches/main/protection`])
  if (!protection) warnings.push('main branch protection is not readable or is not configured.')
  else {
    const required = requiredContexts(protection)
    details.requiredChecks = required
    const duplicateNames = required.filter((name) => /\b([^/]+) \/ \1\b/i.test(name))
    if (duplicateNames.length) errors.push(`required checks contain duplicate workflow prefixes: ${duplicateNames.join(', ')}`)
    if (!protection.required_status_checks) warnings.push('main protection has no required status checks.')
  }

  const sha = String(ghJson(['api', `repos/${repository}/git/ref/heads/main`])?.object?.sha ?? '')
  const checks = sha ? ghJson(['api', `repos/${repository}/commits/${sha}/check-runs?per_page=100`])?.check_runs ?? [] : []
  const observed = checks.map(/** @param {any} check */ (check) => check.name).filter(Boolean)
  details.observedChecks = observed
  if (!observed.length) warnings.push('no check runs were observed on the current main commit; exact check validation is deferred until CI runs.')
  if (protection?.required_status_checks) {
    const required = requiredContexts(protection)
    const missing = required.filter((name) => observed.length && !observed.includes(name))
    if (missing.length) warnings.push(`required checks not observed on current main: ${missing.join(', ')}`)
  }

  const workflowIssues = inspectWorkflows(root)
  errors.push(...workflowIssues.errors)
  warnings.push(...workflowIssues.warnings)

  const secrets = ghJson(['secret', 'list', '--repo', repository, '--json', 'name'])
  const secretNames = Array.isArray(secrets) ? secrets.map(/** @param {any} secret */ (secret) => secret.name) : []
  details.secrets = { releasePleaseTokenPresent: secretNames.includes('RELEASE_PLEASE_TOKEN') }
  if (!details.secrets.releasePleaseTokenPresent) warnings.push('RELEASE_PLEASE_TOKEN is not configured; Release Please auto-merge and direct post-release dispatch are unavailable.')

  const config = readConfig(root)
  if (['workflow-dispatch', 'dispatch'].includes(config.post_release_mode) && config.post_release !== 'false' && !details.secrets.releasePleaseTokenPresent) {
    errors.push('post-release workflow-dispatch mode requires RELEASE_PLEASE_TOKEN to be present.')
  }
  const credentialChecks = {
    npmTokenPresent: secretNames.includes('NPM_TOKEN'),
    turboTokenPresent: secretNames.includes('TURBO_TOKEN'),
    turboTeamPresent: Boolean(ghJson(['variable', 'list', '--repo', repository, '--json', 'name'])?.some(/** @param {{ name?: string }} variable */ (variable) => variable.name === 'TURBO_TEAM')),
    opencodeApiKeyPresent: secretNames.includes('OPENCODE_API_KEY'),
  }
  details.credentials = credentialChecks
  if (config.npm_publish === 'true' && !credentialChecks.npmTokenPresent) warnings.push('npm_publish is enabled but NPM_TOKEN is not configured; npm trusted publishing must be configured for tokenless publication.')
  if (['true', 'auto'].includes(config.turbo_remote ?? 'false') && (!credentialChecks.turboTokenPresent || !credentialChecks.turboTeamPresent)) warnings.push('turbo_remote is enabled but TURBO_TOKEN and/or TURBO_TEAM is not configured; remote caching will be skipped.')
  if (['true', 'auto'].includes(config.opencode_security ?? 'false') && !credentialChecks.opencodeApiKeyPresent) warnings.push('opencode_security is enabled but OPENCODE_API_KEY is not configured; the optional scan will be skipped.')

  const prs = ghJson(['pr', 'list', '--repo', repository, '--state', 'open', '--base', 'main', '--json', 'number,title,headRefName'])
  const openPrs = Array.isArray(prs) ? prs : []
  details.openPromotionPrs = openPrs.filter(/** @param {any} pr */ (pr) => pr.headRefName === 'staging' || /promote staging/i.test(pr.title))
  details.openReleasePrs = openPrs.filter(/** @param {any} pr */ (pr) => String(pr.headRefName).startsWith('release-please--') || /^chore\(main\): release /.test(pr.title))
  if (details.openPromotionPrs.length > 1) errors.push('multiple staging promotion PRs are open.')
  if (details.openReleasePrs.length > 1) errors.push('multiple Release Please PRs are open.')
  return { errors, warnings, details }
}

/** @param {any} protection @returns {string[]} */
function requiredContexts(protection) {
  return [...new Set([
    ...(protection.required_status_checks?.contexts ?? []),
    ...(protection.required_status_checks?.checks ?? []).map(/** @param {any} check */ (check) => check.context),
  ].filter(Boolean))]
}

/** @param {string} root @returns {{ errors: string[], warnings: string[] }} */
function inspectWorkflows(root) {
  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []
  const directory = join(root, '.github/workflows')
  /** @type {string[]} */
  let files = []
  try { files = readdirSync(directory).filter((file) => file.endsWith('.yml') || file.endsWith('.yaml')) }
  catch { return { errors: ['.github/workflows is missing.'], warnings } }
  for (const file of files) {
    const content = readFileSync(join(directory, file), 'utf8')
    if (!/^permissions:\s*$/m.test(content) && /uses:.*\.github\/workflows\//.test(content)) warnings.push(`${file} does not declare top-level permissions.`)
    if (file === 'release.yml' && /contents:\s+write/.test(content) && !/pull-requests:\s+write/.test(content)) errors.push('release.yml needs pull-requests: write for guarded Release Please PR handling.')
  }
  return { errors, warnings }
}

/** @param {string} root @returns {string} */
function remoteRepository(root) {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' })
  const value = result.status === 0 ? result.stdout.trim() : ''
  return value.replace(/^git@github\.com:/, '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')
}

/** @param {string[]} args @returns {any} */
function ghJson(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' })
  if (result.status !== 0) return null
  try { return JSON.parse(result.stdout) }
  catch { return null }
}

/** @param {string} command */
function commandExists(command) { return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0 }

/** @param {string} root @returns {Record<string, string>} */
function readConfig(root) {
  const file = join(root, '.github/code-foundry.yml')
  try {
    return Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/)
      return match ? [[match[1], match[2].replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '')]] : []
    }))
  } catch { return {} }
}
