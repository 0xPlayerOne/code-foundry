// @ts-check

import { spawnSync } from 'node:child_process'

export const CI_BILLING_PAUSED_VARIABLE = 'CI_BILLING_PAUSED'
export const CI_BILLING_BACKUP_VARIABLE = 'CI_BILLING_GATE_BACKUP'
export const CI_BILLING_REQUIRED_CHECK = 'Validation / Gate'

/**
 * Pause, resume, or inspect billable GitHub Actions for a consumer repository.
 * The repository variable stops guarded jobs from allocating runners. While
 * paused, the managed validation check is removed from active branch rulesets
 * so pull requests do not deadlock on a check that cannot run.
 *
 * @param {string} root
 * @param {'pause'|'resume'|'status'} action
 * @returns {Record<string, unknown>}
 */
export function manageCiBilling(root, action) {
  const repository = remoteRepository(root)
  if (!repository) throw new Error('Unable to determine GitHub repository from the origin remote.')
  requireGh()

  const paused = readVariable(repository, CI_BILLING_PAUSED_VARIABLE) === 'true'
  const backupText = readVariable(repository, CI_BILLING_BACKUP_VARIABLE)
  const backup = backupText ? parseBackup(backupText) : null

  if (action === 'status') {
    const result = {
      repository,
      paused,
      requiredCheck: CI_BILLING_REQUIRED_CHECK,
      backupPresent: Boolean(backup),
    }
    console.log(JSON.stringify(result, null, 2))
    return result
  }

  if (action === 'pause') {
    const rulesets = activeBranchRulesets(repository)
    const candidates = rulesets.filter((ruleset) => requiredChecks(ruleset).some(isManagedCheck))
    const inherited = candidates.filter((ruleset) => ruleset.source_type !== 'Repository' || ruleset.source !== repository)
    if (inherited.length) {
      throw new Error(`${CI_BILLING_REQUIRED_CHECK} is enforced by an inherited ruleset that this repository cannot safely edit.`)
    }
    if (!candidates.length) {
      if (paused && backup) {
        const result = { repository, paused: true, changed: false, rulesets: backup.rulesets.map((/** @type {any} */ ruleset) => ruleset.rulesetName) }
        console.log(JSON.stringify(result, null, 2))
        return result
      }
      throw new Error(`No active branch ruleset requires ${CI_BILLING_REQUIRED_CHECK}; refusing to pause without a restorable managed gate.`)
    }
    if (backup && !paused) {
      throw new Error(`${CI_BILLING_BACKUP_VARIABLE} already exists while CI is active; inspect or remove the stale backup before pausing.`)
    }
    if (backup && candidates.some((ruleset) => !backup.rulesets.some((/** @type {any} */ saved) => saved.rulesetId === ruleset.id))) {
      throw new Error(`${CI_BILLING_BACKUP_VARIABLE} does not cover every managed ruleset; refusing to overwrite the recovery state.`)
    }

    const changes = candidates.map(buildPausedRuleset)
    const nextBackup = backup ?? { version: 1, rulesets: changes.map((change) => change.backup) }
    setVariable(repository, CI_BILLING_BACKUP_VARIABLE, JSON.stringify(nextBackup))
    setVariable(repository, CI_BILLING_PAUSED_VARIABLE, 'true')
    for (const change of changes) updateRuleset(repository, change.ruleset)
    const result = { repository, paused: true, changed: true, rulesets: changes.map((change) => change.ruleset.name) }
    console.log(JSON.stringify(result, null, 2))
    return result
  }

  if (!backup) {
    if (!paused) {
      const result = { repository, paused: false, changed: false }
      console.log(JSON.stringify(result, null, 2))
      return result
    }
    throw new Error(`${CI_BILLING_PAUSED_VARIABLE} is true but ${CI_BILLING_BACKUP_VARIABLE} is missing; refusing an unsafe resume.`)
  }

  let changed = paused
  for (const saved of backup.rulesets) {
    const current = apiJson(repository, `repos/${repository}/rulesets/${saved.rulesetId}`)
    if (!current || current.name !== saved.rulesetName) {
      throw new Error(`The backed-up ruleset ${saved.rulesetName} (${saved.rulesetId}) is unavailable; refusing an unsafe resume.`)
    }
    const restored = buildResumedRuleset(current, saved)
    if (restored.changed) updateRuleset(repository, restored.ruleset)
    changed ||= restored.changed
  }
  setVariable(repository, CI_BILLING_PAUSED_VARIABLE, 'false')
  deleteVariable(repository, CI_BILLING_BACKUP_VARIABLE)
  const result = { repository, paused: false, changed, rulesets: backup.rulesets.map((/** @type {any} */ ruleset) => ruleset.rulesetName) }
  console.log(JSON.stringify(result, null, 2))
  return result
}

/** @param {any} ruleset */
export function buildPausedRuleset(ruleset) {
  const requiredRuleIndexes = (ruleset.rules ?? []).flatMap((/** @type {any} */ rule, /** @type {number} */ index) =>
    rule?.type === 'required_status_checks' && (rule.parameters?.required_status_checks ?? []).some(isManagedCheck) ? [index] : [],
  )
  if (requiredRuleIndexes.length > 1) throw new Error(`${CI_BILLING_REQUIRED_CHECK} appears in multiple rules; refusing an ambiguous pause.`)
  const requiredRuleIndex = requiredRuleIndexes[0]
  const requiredRule = ruleset.rules?.[requiredRuleIndex]
  const matches = (requiredRule?.parameters?.required_status_checks ?? []).filter(isManagedCheck)
  if (!matches.length) throw new Error(`${CI_BILLING_REQUIRED_CHECK} is not present in the selected ruleset.`)
  const remaining = (requiredRule.parameters?.required_status_checks ?? []).filter((/** @type {any} */ check) => !isManagedCheck(check))
  const rules = (ruleset.rules ?? []).flatMap((/** @type {any} */ rule, /** @type {number} */ index) => {
    if (index !== requiredRuleIndex) return [rule]
    if (!remaining.length) return []
    return [{ ...rule, parameters: { ...rule.parameters, required_status_checks: remaining } }]
  })
  return {
    ruleset: { ...ruleset, rules },
    backup: {
      rulesetId: ruleset.id,
      rulesetName: ruleset.name,
      checks: matches,
      parameters: {
        strict_required_status_checks_policy: Boolean(requiredRule?.parameters?.strict_required_status_checks_policy),
        do_not_enforce_on_create: Boolean(requiredRule?.parameters?.do_not_enforce_on_create),
      },
    },
  }
}

/** @param {any} ruleset @param {any} backup */
export function buildResumedRuleset(ruleset, backup) {
  if (requiredChecks(ruleset).some(isManagedCheck)) return { ruleset, changed: false }
  const rules = [...(ruleset.rules ?? [])]
  const index = rules.findIndex((rule) => rule?.type === 'required_status_checks')
  if (index === -1) {
    rules.push({
      type: 'required_status_checks',
      parameters: { ...backup.parameters, required_status_checks: backup.checks },
    })
  } else {
    const rule = rules[index]
    rules[index] = {
      ...rule,
      parameters: {
        ...rule.parameters,
        required_status_checks: [...requiredChecks({ rules: [rule] }), ...backup.checks],
      },
    }
  }
  return { ruleset: { ...ruleset, rules }, changed: true }
}

/** @param {any} backup */
function validateBackup(backup) {
  return backup?.version === 1 &&
    Array.isArray(backup.rulesets) &&
    backup.rulesets.length > 0 &&
    backup.rulesets.every((/** @type {any} */ ruleset) =>
      Number.isInteger(ruleset?.rulesetId) &&
      typeof ruleset.rulesetName === 'string' &&
      Array.isArray(ruleset.checks) &&
      ruleset.checks.length > 0 &&
      ruleset.checks.every(isManagedCheck) &&
      ruleset.parameters && typeof ruleset.parameters === 'object',
    )
}

/** @param {string} value */
function parseBackup(value) {
  let backup
  try { backup = JSON.parse(value) }
  catch { throw new Error(`${CI_BILLING_BACKUP_VARIABLE} is not valid JSON; refusing to change CI state.`) }
  if (!validateBackup(backup)) throw new Error(`${CI_BILLING_BACKUP_VARIABLE} is invalid; refusing to change CI state.`)
  return backup
}

/** @param {any} check */
function isManagedCheck(check) { return check?.context === CI_BILLING_REQUIRED_CHECK }

/** @param {any} ruleset @returns {any[]} */
function requiredChecks(ruleset) {
  return (ruleset?.rules ?? []).flatMap((/** @type {any} */ rule) => rule?.type === 'required_status_checks' ? rule.parameters?.required_status_checks ?? [] : [])
}

/** @param {string} repository @returns {any[]} */
function activeBranchRulesets(repository) {
  const summaries = apiJson(repository, `repos/${repository}/rulesets`)
  if (!Array.isArray(summaries)) throw new Error('Unable to read repository rulesets.')
  return summaries
    .map((ruleset) => apiJson(repository, `repos/${repository}/rulesets/${ruleset.id}`))
    .filter((/** @type {any} */ ruleset) => ruleset && ruleset.enforcement === 'active' && ruleset.target === 'branch')
}

/** @param {string} repository @param {any} ruleset */
function updateRuleset(repository, ruleset) {
  const payload = {
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    bypass_actors: ruleset.bypass_actors ?? [],
    conditions: ruleset.conditions,
    rules: ruleset.rules,
  }
  const result = spawnSync('gh', ['api', '--method', 'PUT', `repos/${repository}/rulesets/${ruleset.id}`, '--input', '-'], {
    encoding: 'utf8',
    input: JSON.stringify(payload),
  })
  if (result.status !== 0) throw new Error(`Unable to update ruleset ${ruleset.name}: ${result.stderr.trim() || 'GitHub API request failed'}`)
}

/** @param {string} repository @param {string} name @returns {string|null} */
function readVariable(repository, name) {
  const result = spawnSync('gh', ['api', `repos/${repository}/actions/variables/${name}`], { encoding: 'utf8' })
  if (result.status !== 0) {
    if (/404|not found/i.test(result.stderr)) return null
    throw new Error(`Unable to read repository variable ${name}: ${result.stderr.trim() || 'GitHub API request failed'}`)
  }
  try { return JSON.parse(result.stdout)?.value ?? null }
  catch { throw new Error(`GitHub returned invalid JSON for repository variable ${name}.`) }
}

/** @param {string} repository @param {string} name @param {string} value */
function setVariable(repository, name, value) {
  const result = spawnSync('gh', ['variable', 'set', name, '--repo', repository, '--body', value], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Unable to set repository variable ${name}: ${result.stderr.trim() || 'GitHub CLI request failed'}`)
}

/** @param {string} repository @param {string} name */
function deleteVariable(repository, name) {
  const result = spawnSync('gh', ['variable', 'delete', name, '--repo', repository], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Unable to delete repository variable ${name}: ${result.stderr.trim() || 'GitHub CLI request failed'}`)
}

/** @param {string} repository @param {string} endpoint @returns {any} */
function apiJson(repository, endpoint) {
  const result = spawnSync('gh', ['api', endpoint], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Unable to read ${endpoint} for ${repository}: ${result.stderr.trim() || 'GitHub API request failed'}`)
  try { return JSON.parse(result.stdout) }
  catch { throw new Error(`GitHub returned invalid JSON for ${endpoint}.`) }
}

/** @param {string} root @returns {string} */
function remoteRepository(root) {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' })
  const value = result.status === 0 ? result.stdout.trim() : ''
  return value.replace(/^git@github\.com:/, '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')
}

function requireGh() {
  if (spawnSync('gh', ['--version'], { stdio: 'ignore' }).status !== 0) throw new Error('CI billing controls require the `gh` CLI.')
}
