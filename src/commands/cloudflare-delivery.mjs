#!/usr/bin/env node
// @ts-check

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  bindingPolicy,
  deploymentVersions,
  digestBuild,
  httpsUrl,
  inspectBindings,
  parseArgv,
  parseUpload,
  pinnedWrangler,
  validateRollback,
  versionId,
} from '../lib/cloudflare-delivery.mjs'

/** @param {NodeJS.ProcessEnv} env @param {string} key */
function required(env, key) {
  const value = env[key]
  if (!value || /[\r\n\0]/.test(value)) throw new Error(`Missing or invalid ${key}`)
  return value
}

/** @param {NodeJS.ProcessEnv} env @param {string} name @param {unknown} value */
function output(env, name, value) {
  const text = String(value)
  if (/[\r\n\0]/.test(text)) throw new Error(`Invalid output ${name}`)
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${text}\n`)
}

/** @param {string} url @param {string} token @param {unknown} [body] @param {typeof fetch} [request] */
export async function requestJson(url, token, body, request = fetch) {
  const response = await request(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'code-foundry',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`Deployment API request failed (${response.status})`)
  const json = /** @type {any} */ (await response.json())
  if (json.success === false) throw new Error('Cloudflare rejected the deployment API request')
  return json
}

/** @param {NodeJS.ProcessEnv} env @param {string} suffix @param {unknown} [body] */
async function cloudflare(env, suffix, body) {
  const account = encodeURIComponent(required(env, 'CLOUDFLARE_ACCOUNT_ID'))
  const worker = encodeURIComponent(required(env, 'FOUNDRY_WORKER'))
  const response = await requestJson(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/${suffix}`,
    required(env, 'CLOUDFLARE_API_TOKEN'),
    body
  )
  if (response.success !== true || !Object.hasOwn(response, 'result'))
    throw new Error('Invalid Cloudflare API envelope')
  return response.result
}

/** @param {NodeJS.ProcessEnv} env @param {string} suffix @param {unknown} [body] */
async function github(env, suffix, body) {
  const repository = required(env, 'GITHUB_REPOSITORY')
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid GitHub repository')
  return requestJson(
    `https://api.github.com/repos/${repository}/${suffix}`,
    required(env, 'GH_TOKEN'),
    body
  )
}

/** @param {any} result */
export function latestDeployment(result) {
  if (!Array.isArray(result?.deployments)) throw new Error('Invalid deployments response')
  if (!result.deployments.length) return null
  const deployments = [...result.deployments]
  if (deployments.some((item) => !Number.isFinite(Date.parse(item.created_on))))
    throw new Error('Deployment timestamp is missing')
  // Sorting this copy leaves API input untouched.
  // oxlint-disable-next-line unicorn/no-array-sort
  deployments.sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))
  return deployments[0]
}

/** @param {NodeJS.ProcessEnv} env @param {any} state */
async function assertCurrent(env, state) {
  const branch = required(env, 'FOUNDRY_DEFAULT_BRANCH')
  if (env.GITHUB_REF !== `refs/heads/${branch}`)
    throw new Error('Production delivery requires the default branch')
  const latest = await github(env, `git/ref/heads/${encodeURIComponent(branch)}`)
  if (latest?.object?.sha !== state.sourceSha)
    throw new Error('A newer source commit exists; refusing stale deployment')
}

/** @param {NodeJS.ProcessEnv} env @param {any} state @param {number} percentage */
async function activate(env, state, percentage) {
  if (state.candidateVerified !== true || !state.bindingInspection)
    throw new Error('Candidate verification is required before promotion')
  const version = await cloudflare(env, `versions/${versionId(state.versionId)}`)
  if (version.id !== state.versionId) throw new Error('Candidate version identity changed')
  state.bindingInspection = inspectBindings(
    version,
    bindingPolicy(process.cwd(), env.BINDING_POLICY_FILE ?? ''),
    'production'
  )
  const current = latestDeployment(await cloudflare(env, 'deployments'))
  if (!Object.hasOwn(state, 'previous')) state.previous = current?.versions ?? []
  else if (state.cloudflareDeploymentId && current?.id !== state.cloudflareDeploymentId)
    throw new Error('Another deployment replaced this rollout; refusing to overwrite it')
  const versions = deploymentVersions(state.versionId, percentage, state.previous)
  const result = await cloudflare(env, 'deployments', {
    strategy: 'percentage',
    versions,
    annotations: { 'workers/message': `Code Foundry ${state.sourceSha} (${percentage}%)` },
  })
  state.cloudflareDeploymentId = versionId(result.id, 'deployment ID')
  state.percentage = percentage
  output(env, 'cloudflare-deployment-id', state.cloudflareDeploymentId)
}

/** @param {NodeJS.ProcessEnv} env @param {any} state */
async function rollback(env, state) {
  if (env.AUTO_ROLLBACK !== 'true')
    throw new Error(
      'Automatic rollback is disabled; use the recorded prior versions for manual recovery'
    )
  if (state.bindingInspection?.rollbackSafe !== true)
    throw new Error('Automatic rollback is restricted to stateless Workers')
  if (!state.cloudflareDeploymentId) throw new Error('This run has not activated a deployment')
  const current = latestDeployment(await cloudflare(env, 'deployments'))
  if (current?.id !== state.cloudflareDeploymentId)
    throw new Error('Current deployment changed; refusing to roll back another rollout')
  const versions = validateRollback(state.previous)
  for (const previous of versions) {
    const version = await cloudflare(env, `versions/${previous.version_id}`)
    const inspection = inspectBindings(
      version,
      bindingPolicy(process.cwd(), env.BINDING_POLICY_FILE ?? ''),
      'production'
    )
    if (!inspection.stateless)
      throw new Error('The previous version is stateful; automatic rollback is unsafe')
  }
  const result = await cloudflare(env, 'deployments', {
    strategy: 'percentage',
    versions,
    annotations: {
      'workers/message': `Code Foundry rollback after failed verification of ${state.sourceSha}`,
    },
  })
  state.rollbackDeploymentId = versionId(result.id, 'rollback deployment ID')
  state.rolledBack = true
}

/** @param {NodeJS.ProcessEnv} env @param {any} state */
async function verify(env, state) {
  if (!Array.isArray(state.bindingInspection?.bindings))
    throw new Error('Binding inspection is required before verification')
  const phase = env.FOUNDRY_PHASE ?? 'candidate'
  if (!['candidate', 'canary', 'production'].includes(phase))
    throw new Error('Invalid verification phase')
  const url = httpsUrl(phase === 'candidate' ? state.url : required(env, 'PRODUCTION_URL'))
  const argv = parseArgv(required(env, 'VERIFY_COMMAND'), 'verify-command')
  const smokePath = env.SMOKE_PATH ?? '/'
  if (!smokePath.startsWith('/') || smokePath.startsWith('//'))
    throw new Error('smoke-path must be an origin-relative path')
  const target = new URL(smokePath, url)
  if (target.origin !== new URL(url).origin)
    throw new Error('smoke-path must remain on the deployment origin')
  let healthy = false
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(target, {
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
      })
      await response.body?.cancel()
      healthy = response.ok
    } catch {
      healthy = false
    }
    if (healthy) break
    if (attempt < 2) await new Promise((done) => setTimeout(done, 2000))
  }
  if (!healthy) throw new Error(`${phase} HTTP smoke check failed`)
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = {
    ...env,
    BASE_URL: url,
    FOUNDRY_DEPLOYMENT_PHASE: phase,
    FOUNDRY_EXPECTED_VERSION_ID: state.versionId,
    FOUNDRY_DEPLOYMENT_ID: state.cloudflareDeploymentId ?? '',
    FOUNDRY_CANARY_PERCENTAGE: phase === 'canary' ? String(state.percentage ?? '') : '',
  }
  delete childEnv.CLOUDFLARE_API_TOKEN
  delete childEnv.GH_TOKEN
  delete childEnv.GITHUB_TOKEN
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: childEnv,
    timeout: 600000,
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`${phase} verification command failed (${result.status ?? result.signal})`)
  state.verifications ??= []
  state.verifications.push({ phase, status: 'passed', completedAt: new Date().toISOString() })
  if (phase === 'candidate') {
    state.candidateVerified = true
    output(env, 'verified', 'true')
  }
}

/** @param {string} command @param {NodeJS.ProcessEnv} [env] */
export async function deliveryCommand(command, env = process.env) {
  const file = required(env, 'FOUNDRY_STATE_FILE')
  /** @type {any} */
  const state = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : {
        schemaVersion: 1,
        kind: 'code-foundry-cloudflare-delivery',
        sourceSha: required(env, 'GITHUB_SHA'),
        worker: required(env, 'FOUNDRY_WORKER'),
      }
  if (
    !/^[0-9a-f]{40}$/i.test(state.sourceSha) ||
    state.sourceSha !== env.GITHUB_SHA ||
    state.worker !== env.FOUNDRY_WORKER
  )
    throw new Error('Delivery state does not match the checked-out source and Worker')
  try {
    if (command === 'init-production') {
      if (env.CANDIDATE_VERIFIED !== 'true')
        throw new Error('Upstream candidate verification did not pass')
      if (env.CANDIDATE_SOURCE_SHA !== state.sourceSha)
        throw new Error('Candidate source SHA mismatch')
      state.versionId = versionId(env.CANDIDATE_VERSION_ID)
      state.url = httpsUrl(required(env, 'CANDIDATE_URL'))
      state.artifactDigest = required(env, 'CANDIDATE_ARTIFACT_DIGEST')
      if (!/^sha256:[0-9a-f]{64}$/.test(state.artifactDigest))
        throw new Error('Invalid build artifact digest')
      state.candidateVerified = true
      state.bindingInspection = {}
    } else if (command === 'upload') {
      if (!['preview', 'production'].includes(env.FOUNDRY_MODE ?? ''))
        throw new Error('Unsupported delivery mode')
      const event = env.GITHUB_EVENT_NAME
      if (event === 'pull_request_target')
        throw new Error('Privileged pull_request_target execution is not supported')
      state.artifactDigest = digestBuild(process.cwd(), required(env, 'ARTIFACT_PATH'))
      const outputFile = `${file}.wrangler.ndjson`
      writeFileSync(outputFile, '')
      const argv = pinnedWrangler(env.WRANGLER_VERSION ?? 'local')
      argv.push('versions', 'upload', '--message', `Code Foundry ${state.sourceSha}`)
      if (env.WRANGLER_ENVIRONMENT) argv.push('--env', env.WRANGLER_ENVIRONMENT)
      if (env.WRANGLER_CONFIG) argv.push('--config', env.WRANGLER_CONFIG)
      const result = spawnSync(argv[0], argv.slice(1), {
        cwd: process.cwd(),
        stdio: 'inherit',
        env: {
          ...env,
          WRANGLER_OUTPUT_FILE_PATH: outputFile,
          WRANGLER_SEND_METRICS: 'false',
          NO_COLOR: '1',
        },
      })
      if (result.error) throw result.error
      if (result.status !== 0)
        throw new Error(`Wrangler upload failed (${result.status ?? result.signal})`)
      if (digestBuild(process.cwd(), required(env, 'ARTIFACT_PATH')) !== state.artifactDigest)
        throw new Error('Build artifacts changed during upload; disable duplicate custom builds')
      Object.assign(state, parseUpload(readFileSync(outputFile, 'utf8'), state.worker))
      output(env, 'url', state.url)
      output(env, 'version-id', state.versionId)
      output(env, 'artifact-digest', state.artifactDigest)
      output(env, 'source-sha', state.sourceSha)
    } else if (command === 'inspect') {
      const version = await cloudflare(env, `versions/${versionId(state.versionId)}`)
      if (version.id !== state.versionId) throw new Error('Version API identity mismatch')
      const mode = env.FOUNDRY_MODE === 'production' ? 'production' : 'preview'
      state.bindingInspection = inspectBindings(
        version,
        bindingPolicy(process.cwd(), env.BINDING_POLICY_FILE ?? ''),
        mode
      )
    } else if (command === 'verify') await verify(env, state)
    else if (command === 'assert-current') await assertCurrent(env, state)
    else if (command === 'activate')
      await activate(env, state, Number(env.DEPLOY_PERCENTAGE ?? '100'))
    else if (command === 'rollback') await rollback(env, state)
    else if (command === 'record-start') {
      const production = env.FOUNDRY_PHASE === 'production'
      const deployment = await github(env, 'deployments', {
        ref: state.sourceSha,
        environment: required(env, 'DEPLOYMENT_ENVIRONMENT'),
        auto_merge: false,
        required_contexts: [],
        production_environment: production,
        transient_environment: !production,
        task: 'code-foundry-delivery',
      })
      if (!Number.isSafeInteger(deployment.id)) throw new Error('GitHub returned no deployment ID')
      state.githubDeploymentId = deployment.id
      output(env, 'github-deployment-id', deployment.id)
      await github(env, `deployments/${deployment.id}/statuses`, {
        state: 'in_progress',
        auto_inactive: false,
      })
    } else if (command === 'record-finish') {
      if (!state.githubDeploymentId) return
      const status = env.DEPLOYMENT_STATUS === 'success' ? 'success' : 'failure'
      state.status = status
      await github(env, `deployments/${state.githubDeploymentId}/statuses`, {
        state: status,
        auto_inactive: false,
        environment_url:
          env.FOUNDRY_PHASE === 'production'
            ? httpsUrl(required(env, 'PRODUCTION_URL'))
            : (state.url ?? ''),
        description: state.rolledBack
          ? 'Verification failed; stateless rollback completed'
          : `Code Foundry delivery ${status}`,
      })
    } else throw new Error(`Unknown Cloudflare delivery command: ${command}`)
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    state.updatedAt = new Date().toISOString()
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`)
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await deliveryCommand(process.argv[2])
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
