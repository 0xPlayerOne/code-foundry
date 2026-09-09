// @ts-check
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'

/** @typedef {Record<string, any>} Profile */
/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

/** Refuse traversal and symlinks, including symlinked parents. @param {string} root @param {string} path */
export function ownedPath(root, path) {
  requireValue(typeof path === 'string' && path.length > 0 && !isAbsolute(path), 'Expected a relative repository path')
  const base = realpathSync(root)
  const destination = resolve(base, path)
  const rel = relative(base, destination)
  requireValue(rel !== '' && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel), 'Path escapes its root')
  let current = base
  for (const part of rel.split(/[\\/]/)) {
    current = join(current, part)
    let entry
    try { entry = lstatSync(current) } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
    }
    requireValue(!entry?.isSymbolicLink(), 'Symlinks are not accepted in quality inputs or outputs')
  }
  return destination
}

/** @param {unknown} value @param {string} name */
function budget(value, name) {
  requireValue(typeof value === 'number' && Number.isFinite(value) && value >= 0, `${name} must be a finite nonnegative budget`)
  return value
}

/** @param {string} value */
function decode(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_, entity) => {
    if (entity[0] === '#') return String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)))
    return /** @type {Record<string,string>} */ ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[entity.toLowerCase()]
  })
}

/** Conservative generated-HTML tag reader, not a DOM implementation.
 * Raw script/style text and comments cannot create fake metadata or links.
 * @param {string} html
 */
export function readTags(html) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/(<(script|style)\b(?:"[^"]*"|'[^']*'|[^'">])*>)[\s\S]*?<\/\2\s*>/gi, '$1')
  /** @type {Array<{ name: string, attrs: Record<string,string> }>} */
  const tags = []
  for (const match of clean.matchAll(/<([a-z][a-z0-9:-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)) {
    /** @type {Record<string,string>} */
    const attrs = Object.create(null)
    for (const attr of match[2].matchAll(/([a-z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi)) {
      const key = attr[1].toLowerCase()
      requireValue(!(key in attrs), `Duplicate HTML attribute: ${key}`)
      attrs[key] = decode(attr[2] ?? attr[3] ?? attr[4] ?? '')
    }
    tags.push({ name: match[1].toLowerCase(), attrs })
  }
  return { clean, tags }
}

/** @param {string} root @param {Profile} profile */
export function checkStaticSite(root, profile) {
  const dist = ownedPath(root, profile.dist)
  requireValue(statSync(dist).isDirectory(), 'Static dist must be a directory')
  const origin = new URL(profile.origin)
  requireValue(['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash, 'origin must be an HTTP(S) origin without credentials or a path')
  requireValue(Array.isArray(profile.routes) && profile.routes.length > 0, 'Static routes must be nonempty')
  const limits = profile.budgets ?? {}
  const htmlBudget = budget(limits.htmlBytes, 'htmlBytes')
  const scriptBudget = budget(limits.javascriptBytes, 'javascriptBytes')
  const imageBudget = budget(limits.imageBytes, 'imageBytes')
  /** @type {Map<string, { file: string, clean: string, tags: ReturnType<typeof readTags>['tags'] }>} */
  const routes = new Map()
  for (const route of profile.routes) {
    requireValue(typeof route.path === 'string' && route.path.startsWith('/') && !route.path.startsWith('//'), 'Routes must be origin-relative paths')
    const url = new URL(route.path, origin)
    requireValue(url.origin === origin.origin && !url.search && !url.hash && !routes.has(url.pathname), 'Duplicate or invalid static route')
    const file = ownedPath(dist, route.html)
    const html = readFileSync(file, 'utf8')
    routes.set(url.pathname, { file, ...readTags(html) })
  }
  /** @type {Array<{ route: string, htmlBytes: number, javascriptBytes: number, imageBytes: number }>} */
  const metrics = []
  for (const [path, page] of routes) {
    const canonical = new URL(path, origin).href
    requireValue(!page.tags.some((tag) => tag.name === 'base'), `${path}: base elements require a repository-owned checker`)
    const title = page.clean.match(/<title(?:\s[^>]*)?>([^<]*)<\/title\s*>/i)?.[1]?.trim()
    requireValue(title, `${path}: missing or empty title`)
    const descriptions = page.tags.filter((tag) => tag.name === 'meta' && tag.attrs.name?.toLowerCase() === 'description')
    requireValue(descriptions.length === 1 && descriptions[0].attrs.content?.trim(), `${path}: expected one nonempty meta description`)
    const canonicals = page.tags.filter((tag) => tag.name === 'link' && tag.attrs.rel?.toLowerCase().split(/\s+/).includes('canonical'))
    requireValue(canonicals.length === 1 && canonicals[0].attrs.href === canonical, `${path}: canonical URL mismatch`)
    requireValue(!page.tags.some((tag) => tag.name === 'meta' && ['robots', 'googlebot'].includes(tag.attrs.name?.toLowerCase()) && /(?:^|[,\s])noindex(?:$|[,\s])/i.test(tag.attrs.content ?? '')), `${path}: unexpected noindex`)
    const scripts = new Set(/** @type {string[]} */ (profile.routes.find((/** @type {Profile} */ route) => route.path === path)?.javascriptAssets ?? []))
    const images = new Set()
    for (const tag of page.tags) {
      if (tag.name === 'script' && tag.attrs.src) scripts.add(tag.attrs.src)
      if (tag.name === 'img' && tag.attrs.src && !tag.attrs.src.startsWith('data:')) images.add(tag.attrs.src)
      if (['img', 'source'].includes(tag.name) && tag.attrs.srcset) {
        requireValue(!tag.attrs.srcset.includes('data:'), 'Data-URL srcsets require a repository-owned checker')
        for (const candidate of tag.attrs.srcset.split(',')) images.add(candidate.trim().split(/\s+/)[0])
      }
      if (tag.name !== 'a' || !tag.attrs.href) continue
      const target = new URL(tag.attrs.href, canonical)
      if (!['http:', 'https:'].includes(target.protocol) || target.origin !== origin.origin) continue
      const targetPage = routes.get(target.pathname)
      if (targetPage) {
        if (target.hash) {
          const id = decodeURIComponent(target.hash.slice(1))
          requireValue(targetPage.tags.some((entry) => entry.attrs.id === id || (entry.name === 'a' && entry.attrs.name === id)), `${path}: missing anchor ${target.hash}`)
        }
      } else {
        const asset = ownedPath(dist, decodeURIComponent(target.pathname).replace(/^\//, ''))
        requireValue(existsSync(asset) && lstatSync(asset).isFile(), `${path}: broken internal link ${target.pathname}`)
      }
    }
    const assetBytes = (/** @type {Set<string>} */ assets) => [...assets].reduce((sum, resource) => {
      const url = new URL(resource, canonical)
      requireValue(url.origin === origin.origin, `${path}: external resource needs a measured repository-owned budget: ${url.origin}`)
      const file = ownedPath(dist, decodeURIComponent(url.pathname).replace(/^\//, ''))
      requireValue(lstatSync(file).isFile(), 'Budget assets must be regular files')
      return sum + statSync(file).size
    }, 0)
    const inlineBytes = [...readFileSync(page.file, 'utf8').replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b(?:"[^"]*"|'[^']*'|[^'">])*?>([\s\S]*?)<\/script\s*>/gi)].reduce((sum, match) => sum + Buffer.byteLength(match[1]), 0)
    const result = { route: path, htmlBytes: statSync(page.file).size, javascriptBytes: assetBytes(scripts) + inlineBytes, imageBytes: assetBytes(images) }
    requireValue(result.htmlBytes <= htmlBudget && result.javascriptBytes <= scriptBudget && result.imageBytes <= imageBudget, `${path}: resource budget exceeded`)
    metrics.push(result)
  }
  if (profile.sitemap) {
    const sitemap = readFileSync(ownedPath(dist, profile.sitemap), 'utf8')
    requireValue(!/<!DOCTYPE|<!ENTITY/i.test(sitemap), 'Sitemap entities are not supported')
    const locations = new Set([...sitemap.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/g)].map((match) => decode(match[1].trim())))
    for (const path of routes.keys()) requireValue(locations.has(new URL(path, origin).href), `${path}: absent from sitemap`)
    const robots = readFileSync(ownedPath(dist, profile.robots ?? 'robots.txt'), 'utf8')
    requireValue(robots.split(/\r?\n/).some((line) => line.trim() === `Sitemap: ${new URL(profile.sitemap, origin).href}`), 'robots.txt must reference the checked sitemap')
    requireValue(!/^Disallow:\s*\/\s*$/mi.test(robots), 'robots.txt blocks the entire site')
  }
  if (profile.redirects) {
    requireValue(Array.isArray(profile.redirects.rules) && profile.redirects.rules.length > 0, 'Redirect expectations must be nonempty')
    const lines = readFileSync(ownedPath(dist, profile.redirects.file), 'utf8').split(/\r?\n/)
      .map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
    for (const rule of profile.redirects.rules) {
      requireValue(typeof rule.from === 'string' && rule.from.startsWith('/') && typeof rule.to === 'string' && [301, 302, 303, 307, 308].includes(rule.status), 'Invalid redirect expectation')
      // Exact simple Cloudflare/Netlify-style _redirects lines only; this is not a deployed routing probe.
      const matches = lines.filter((line) => line.split(/\s+/)[0] === rule.from)
      requireValue(matches.length === 1 && matches[0].split(/\s+/).join(' ') === `${rule.from} ${rule.to} ${rule.status}`, `Missing or ambiguous redirect: ${rule.from}`)
    }
  }
  return metrics
}

/** @param {unknown} argv @param {string} root @param {string} output @param {number} timeout */
export function runQualityCommand(argv, root, output, timeout = 120_000) {
  requireValue(Array.isArray(argv) && argv.length > 0 && argv.every((value) => typeof value === 'string' && value.length > 0), 'Commands must be nonempty argv arrays')
  const args = /** @type {string[]} */ (argv).map((value) => value.replaceAll('{output}', output))
  const result = spawnSync(args[0], args.slice(1), { cwd: root, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CI: 'true', CODE_FOUNDRY_QUALITY_OUTPUT_DIR: output } })
  if (result.stdout) process.stderr.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  requireValue(!result.error && result.status === 0, `Quality command failed: ${args[0]} (${result.status ?? result.error?.message})`)
  return result.stdout
}

/** @param {string} root @param {Profile} profile @param {string} output */
export function checkWorker(root, profile, output) {
  requireValue(Array.isArray(profile.files) && profile.files.length > 0, 'Worker bundle files are required')
  runQualityCommand(profile.buildCommand, root, output)
  let rawBytes = 0
  let gzipBytes = 0
  for (const name of new Set(/** @type {string[]} */ (profile.files))) {
    const file = ownedPath(output, name)
    requireValue(lstatSync(file).isFile(), 'Worker bundle must be a regular file')
    const data = readFileSync(file)
    rawBytes += data.length
    gzipBytes += gzipSync(data).length
  }
  requireValue(rawBytes > 0, 'Worker bundle is empty')
  requireValue(rawBytes <= budget(profile.budgets?.rawBytes, 'rawBytes'), 'Worker raw-byte budget exceeded')
  requireValue(gzipBytes <= budget(profile.budgets?.gzipBytes, 'gzipBytes'), 'Worker gzip budget exceeded')
  runQualityCommand(profile.runtimeCommand, root, output)
  return { rawBytes, gzipBytes }
}

/** @param {string} root @param {Profile} profile @param {string} output */
export function checkPackage(root, profile, output) {
  const manifest = JSON.parse(readFileSync(ownedPath(root, 'package.json'), 'utf8'))
  requireValue(typeof manifest.name === 'string' && typeof manifest.version === 'string', 'Package identity is required')
  requireValue(Array.isArray(profile.imports) && profile.imports.length > 0 && profile.imports.every((/** @type {unknown} */ value) => typeof value === 'string' && (value === manifest.name || value.startsWith(`${manifest.name}/`))), 'Imports must exercise the candidate package exports')
  const runtimes = profile.runtimes ?? ['node']
  requireValue(Array.isArray(runtimes) && runtimes.length > 0 && runtimes.every((/** @type {unknown} */ value) => ['node', 'bun'].includes(/** @type {string} */ (value))), 'Package runtimes must be a nonempty node/bun list')
  // Pack outside the consumer repository so test installations cannot become package input.
  const temporary = mkdtempSync(join(tmpdir(), 'foundry-package-quality-'))
  try {
    const pack = JSON.parse(runQualityCommand(['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary], root, output))
    requireValue(Array.isArray(pack) && pack.length === 1 && /^[A-Za-z0-9._-]+\.tgz$/.test(pack[0].filename), 'Expected one package archive')
    requireValue(pack[0].files.every((/** @type {{path:string}} */ file) => !/^\.code-foundry(?:\/|$)/.test(file.path)), 'Exclude .code-foundry quality evidence from the published package')
    const archive = ownedPath(temporary, pack[0].filename)
    const archiveSha256 = createHash('sha256').update(readFileSync(archive)).digest('hex')
    const consumer = join(temporary, 'consumer')
    mkdirSync(consumer)
    writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n')
    const args = ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false']
    if (profile.offline !== false) args.push('--offline')
    args.push(archive)
    runQualityCommand(args, consumer, output)
    const script = `for (const name of ${JSON.stringify(profile.imports)}) await import(name)\n`
    writeFileSync(join(consumer, 'smoke.mjs'), script)
    for (const runtime of runtimes) runQualityCommand([runtime === 'node' ? process.execPath : 'bun', 'smoke.mjs'], consumer, output)
    requireValue(createHash('sha256').update(readFileSync(archive)).digest('hex') === archiveSha256, 'Package archive changed during compatibility testing')
    return { name: manifest.name, version: manifest.version, archiveSha256, node: process.version, runtimes }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

/** Native Playwright tests retain repo-owned journeys and screenshot baselines.
 * @param {string} root @param {Profile} profile @param {string} output
 */
export function browserFiles(root, profile, output) {
  requireValue(Array.isArray(profile.routes) && profile.routes.length > 0, 'Browser routes are required')
  const url = new URL(profile.baseURL)
  requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'Invalid browser baseURL')
  requireValue(profile.allowRemote === true || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Remote browser checks require allowRemote: true')
  const journeys = ownedPath(root, profile.journeys)
  requireValue(lstatSync(journeys).isFile(), 'A repository-owned journey suite is required')
  const snapshots = ownedPath(root, profile.snapshots ?? '.github/quality-snapshots')
  const routes = profile.routes.map((/** @type {Profile} */ route) => {
    requireValue(typeof route.id === 'string' && /^[a-z0-9-]+$/.test(route.id), 'Route IDs must be safe snapshot names')
    requireValue(typeof route.path === 'string' && route.path.startsWith('/') && new URL(route.path, url).origin === url.origin, 'Browser routes must stay on the selected origin')
    requireValue(typeof route.readySelector === 'string' && route.readySelector.length > 0, 'A readySelector is required for each browser route')
    return route
  })
  requireValue(new Set(routes.map((/** @type {Profile} */ route) => route.id)).size === routes.length, 'Duplicate browser route IDs')
  const spec = `import { createRequire } from 'node:module'\nconst require = createRequire(${JSON.stringify(join(root, 'package.json'))})\nconst { test, expect } = require('@playwright/test')\nconst AxeBuilder = require('@axe-core/playwright').default\nawait import(${JSON.stringify(pathToFileURL(journeys).href)})\nfor (const route of ${JSON.stringify(routes)}) {\n  test('quality: ' + route.id, async ({ page }) => {\n    const errors = []\n    page.on('pageerror', error => errors.push(error.message))\n    const response = await page.goto(route.path)\n    expect(response?.ok()).toBeTruthy()\n    await expect(page.locator(route.readySelector)).toBeVisible()\n    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()\n    expect(accessibility.violations).toEqual([])\n    if (route.visual === true) await expect(page).toHaveScreenshot(route.id + '.png', { animations: 'disabled' })\n    expect(errors).toEqual([])\n  })\n}\n`
  const config = {
    testDir: output, testMatch: 'quality.spec.mjs', outputDir: join(output, 'results'),
    workers: 1, retries: 0, updateSnapshots: 'none', ignoreSnapshots: false, reporter: [['json', { outputFile: join(output, 'playwright.json') }]],
    snapshotPathTemplate: `${snapshots}/{arg}{ext}`,
    use: { baseURL: profile.baseURL, browserName: 'chromium', viewport: { width: 1280, height: 720 }, trace: 'retain-on-failure' },
    ...(profile.webServerCommand ? { webServer: { command: profile.webServerCommand, cwd: root, url: profile.baseURL, reuseExistingServer: false, timeout: 120_000 } } : {}),
  }
  return { spec, config }
}

/** @param {string} root @param {Profile} profile @param {string} output */
export function checkBrowser(root, profile, output) {
  const require = createRequire(join(root, 'package.json'))
  const cli = join(dirname(require.resolve('@playwright/test/package.json')), 'cli.js')
  require.resolve('@axe-core/playwright')
  const { spec, config } = browserFiles(root, profile, output)
  writeFileSync(join(output, 'quality.spec.mjs'), spec)
  writeFileSync(join(output, 'playwright.config.mjs'), `export default ${JSON.stringify(config, null, 2)}\n`)
  runQualityCommand([process.execPath, cli, 'test', '--config', join(output, 'playwright.config.mjs')], root, output, 600_000)
  const report = JSON.parse(readFileSync(join(output, 'playwright.json'), 'utf8'))
  validateBrowserReport(report, profile.routes.map((/** @type {Profile} */ route) => `quality: ${route.id}`))
  return { tests: report.stats.expected, report: join(output, 'playwright.json') }
}

/** Reject expected-failure annotations as well as skips and incomplete reports.
 * @param {Profile} report @param {string[]} expectedRoutes
 */
export function validateBrowserReport(report, expectedRoutes) {
  /** @type {Profile[]} */
  const specs = []
  const visit = (/** @type {Profile} */ suite) => {
    specs.push(...(suite.specs ?? []))
    for (const child of suite.suites ?? []) visit(child)
  }
  for (const suite of report.suites ?? []) visit(suite)
  requireValue(report.stats?.unexpected === 0 && report.stats?.flaky === 0 && report.stats?.skipped === 0 && report.stats?.expected > expectedRoutes.length, 'Browser checks need passing routes and at least one journey, without skips or flakes')
  requireValue(specs.length > expectedRoutes.length, 'Browser report has no repository-owned journey')
  for (const title of expectedRoutes) requireValue(specs.filter((spec) => spec.title === title).length === 1, `Missing or duplicate browser route: ${title}`)
  for (const spec of specs) {
    requireValue(spec.ok === true && Array.isArray(spec.tests) && spec.tests.length > 0, 'Browser specification did not pass')
    for (const item of spec.tests) requireValue(item.expectedStatus === 'passed' && item.status === 'expected' && Array.isArray(item.results) && item.results.length > 0 && item.results.every((/** @type {Profile} */ value) => value.status === 'passed'), 'Expected failures and incomplete browser results are not accepted')
  }
}

/** @param {string} root @param {Profile} config @param {string} [phase] */
export function runProductQuality(root, config, phase = 'build') {
  requireValue(config.schema_version === 1 && Array.isArray(config.profiles) && config.profiles.length > 0, 'Expected a version-1 quality manifest with profiles')
  requireValue(['build', 'browser', 'deployed'].includes(phase), 'Unknown quality phase')
  const ids = config.profiles.map((/** @type {Profile} */ profile) => profile.id)
  requireValue(ids.every((/** @type {unknown} */ id) => typeof id === 'string' && /^[a-z0-9-]+$/.test(id)) && new Set(ids).size === ids.length, 'Profile IDs must be unique safe names')
  for (const profile of config.profiles) {
    requireValue(['static-site', 'web-app', 'worker', 'package'].includes(profile.type), `Unknown quality profile: ${profile.type}`)
    requireValue(['build', 'browser', 'deployed'].includes(profile.phase ?? (profile.type === 'web-app' ? 'browser' : 'build')), 'Unknown profile phase')
  }
  const profiles = config.profiles.filter((/** @type {Profile} */ profile) => (profile.phase ?? (profile.type === 'web-app' ? 'browser' : 'build')) === phase)
  requireValue(profiles.length > 0, 'No profiles apply to the selected phase')
  const outputRoot = ownedPath(root, '.code-foundry/quality')
  mkdirSync(outputRoot, { recursive: true })
  const output = mkdtempSync(join(outputRoot, `${phase}-`))
  /** @type {Profile[]} */
  const results = []
  const source = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
  const result = {
    schema_version: 1, run_id: randomUUID(), phase, status: 'failed', profiles: results,
    source_sha: source.status === 0 ? source.stdout.trim() : null,
    dirty: dirty.status === 0 ? dirty.stdout.length > 0 : null,
    config_sha256: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
  }
  try {
    for (const command of config.prepare?.[phase] ?? []) runQualityCommand(command, root, output)
    for (const profile of profiles) {
      const directory = join(output, profile.id)
      mkdirSync(directory)
      try {
      let metrics
      if (profile.type === 'static-site') metrics = checkStaticSite(root, profile)
      else if (profile.type === 'worker') metrics = checkWorker(root, profile, directory)
      else if (profile.type === 'package') metrics = checkPackage(root, profile, directory)
      else metrics = checkBrowser(root, profile, directory)
      result.profiles.push({ id: profile.id, type: profile.type, status: 'passed', metrics })
      } catch (error) {
        result.profiles.push({ id: profile.id, type: profile.type, status: 'failed', reason: error instanceof Error ? error.message : String(error) })
        throw error
      }
    }
    result.status = 'passed'
    return result
  } finally {
    writeFileSync(join(output, 'summary.json'), JSON.stringify(result, null, 2) + '\n')
    console.error(`Quality evidence: ${relative(root, output)}/summary.json`)
  }
}
