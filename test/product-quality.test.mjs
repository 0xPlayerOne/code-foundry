import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  browserFiles,
  checkPackage,
  checkStaticSite,
  checkWorker,
  ownedPath,
  readTags,
  runProductQuality,
  runQualityCommand,
  validateBrowserReport,
} from '../src/lib/product-quality.mjs'

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'product-quality-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
function put(root, name, text) {
  mkdirSync(join(root, name, '..'), { recursive: true })
  writeFileSync(join(root, name), text)
}
function site(t) {
  const root = temp(t)
  const html = (path, body) =>
    `<!doctype html><html><head><title>Page</title><meta content="Text > other" name="description"><link href="https://example.test${path}" rel="canonical"></head><body>${body}</body></html>`
  put(
    root,
    'dist/index.html',
    html(
      '/',
      '<a href="about/#section">About</a><script src="/app.js"></script><img src="/a.png"><img srcset="/a.png 1x, /b.png 2x">'
    )
  )
  put(
    root,
    'dist/about/index.html',
    html('/about/', '<h1 id="section">About</h1><a href="../">Home</a>')
  )
  put(root, 'dist/app.js', 'export const value = 1')
  put(root, 'dist/chunk.js', 'export const other = 2')
  put(root, 'dist/a.png', 'image-one')
  put(root, 'dist/b.png', 'image-two')
  put(
    root,
    'dist/sitemap.xml',
    '<urlset><url><loc>https://example.test/</loc></url><url><loc>https://example.test/about/</loc></url></urlset>'
  )
  put(
    root,
    'dist/robots.txt',
    'User-agent: *\nAllow: /\nSitemap: https://example.test/sitemap.xml\n'
  )
  put(root, 'dist/_redirects', '/old /about/ 301\n')
  const profile = {
    id: 'site',
    type: 'static-site',
    origin: 'https://example.test',
    dist: 'dist',
    routes: [
      { path: '/', html: 'index.html', javascriptAssets: ['/chunk.js'] },
      { path: '/about/', html: 'about/index.html' },
    ],
    budgets: { htmlBytes: 2000, javascriptBytes: 100, imageBytes: 100 },
    sitemap: 'sitemap.xml',
    redirects: { file: '_redirects', rules: [{ from: '/old', to: '/about/', status: 301 }] },
  }
  return { root, profile }
}
function replace(root, name, from, to) {
  const file = join(root, name)
  writeFileSync(file, readFileSync(file, 'utf8').replace(from, to))
}

test('generated HTML ignores comment and raw-script fake metadata and preserves quoted >', () => {
  const { tags } = readTags(
    '<!-- <meta name="fake"> --><script>const text = "<meta name=\'fake\'>"</script><meta name="description" content="a > b &amp; c">'
  )
  assert.equal(tags.filter((x) => x.name === 'meta').length, 1)
  assert.equal(tags.at(-1).attrs.content, 'a > b & c')
  assert.throws(() => readTags('<meta name="one" NAME="two">'), /Duplicate/)
})

test('malformed comments cannot expose fake tags', () => {
  const { tags, clean } = readTags('<!-- <meta name="fake">')
  assert.equal(
    tags.some((tag) => tag.name === 'meta'),
    false
  )
  assert.doesNotMatch(clean, /<!--/)

  const bangComment = readTags('<!-- <meta name="fake"> --!><meta name="real">')
  assert.deepEqual(
    bangComment.tags.filter((tag) => tag.name === 'meta').map((tag) => tag.attrs.name),
    ['real']
  )
})

test('comment markers inside scripts stay script data', () => {
  const { tags } = readTags(
    '<script>const marker = "<!--";</script><meta name="real" content="value">'
  )
  assert.deepEqual(
    tags.filter((tag) => tag.name === 'meta').map((tag) => tag.attrs.name),
    ['real']
  )
})

test('malformed title markup is removed conservatively', () => {
  const { clean } = readTags('<title><script</title>')
  assert.doesNotMatch(clean, /<script/)
})

test('inline script budgets recognize forgiving script end tags', (t) => {
  const root = temp(t)
  const malformedEnd = `</script${String.fromCharCode(9, 10)} bar>`
  put(
    root,
    'dist/index.html',
    '<!doctype html><html><head><title>Page</title><meta name="description" content="Text"><link rel="canonical" href="https://example.test/"></head><body><script>const payload = "this must be counted"' +
      malformedEnd +
      '</body></html>'
  )
  const profile = {
    id: 'site',
    type: 'static-site',
    origin: 'https://example.test',
    dist: 'dist',
    routes: [{ path: '/', html: 'index.html' }],
    budgets: { htmlBytes: 2000, javascriptBytes: 0, imageBytes: 0 },
  }
  assert.throws(() => checkStaticSite(root, profile), /resource budget exceeded/)
})

test('sitemap comments cannot provide route locations', (t) => {
  const { root, profile } = site(t)
  put(
    root,
    'dist/sitemap.xml',
    '<urlset><!-- <url><loc>https://example.test/</loc></url><url><loc>https://example.test/about/</loc></url>'
  )
  assert.throws(() => checkStaticSite(root, profile), /absent from sitemap/)
})

test('static routes validate metadata, relative links, anchors, assets, sitemap and redirects', (t) => {
  const { root, profile } = site(t)
  const result = checkStaticSite(root, profile)
  assert.equal(result.length, 2)
  assert.equal(result[0].javascriptBytes, 44)
  assert.equal(result[0].imageBytes, 18)
})

test('static metadata inside raw-text elements is not accepted', (t) => {
  const { root, profile } = site(t)
  put(
    root,
    'dist/index.html',
    '<!doctype html><html><head></head><body><textarea><title>Page</title><meta name="description" content="fake"><link rel="canonical" href="https://example.test/"></textarea></body></html>'
  )
  assert.throws(() => checkStaticSite(root, profile), /title/)
})

test('static route metadata follows normalized route paths', (t) => {
  const { root, profile } = site(t)
  profile.routes[0].path = '/./'
  profile.budgets.javascriptBytes = 30
  assert.throws(() => checkStaticSite(root, profile), /resource budget exceeded/)
})

for (const [name, from, to, error] of [
  ['canonical', 'https://example.test/"', 'https://wrong.test/"', /canonical/],
  ['description', 'name="description"', 'name="other"', /description/],
  ['title', '<title>Page</title>', '<title> </title>', /title/],
  ['relative link', 'about/#section', 'missing/', /broken internal link/],
  ['anchor', 'about/#section', 'about/#missing', /missing anchor/],
  ['noindex', '</head>', '<meta name="robots" content="noindex"></head>', /noindex/],
  ['external script', '/app.js', 'https://cdn.test/app.js', /external resource/],
  ['base', '</head>', '<base href="https://other.test/"></head>', /base elements/],
])
  test(`static profile rejects ${name} regression`, (t) => {
    const { root, profile } = site(t)
    replace(root, 'dist/index.html', from, to)
    assert.throws(() => checkStaticSite(root, profile), error)
  })

test('zero budgets and missing mandatory budgets fail closed', (t) => {
  const { root, profile } = site(t)
  profile.budgets.javascriptBytes = 0
  assert.throws(() => checkStaticSite(root, profile), /budget exceeded/)
  delete profile.budgets.htmlBytes
  assert.throws(() => checkStaticSite(root, profile), /htmlBytes/)
})

test('sitemap, robots, redirects and their duplicates are checked', (t) => {
  const { root, profile } = site(t)
  put(root, 'dist/_redirects', '/old /wrong 301\n')
  assert.throws(() => checkStaticSite(root, profile), /redirect/)
  delete profile.redirects
  put(root, 'dist/robots.txt', 'Disallow: /\nSitemap: https://example.test/sitemap.xml\n')
  assert.throws(() => checkStaticSite(root, profile), /blocks/)
  put(root, 'dist/sitemap.xml', '<urlset/>')
  assert.throws(() => checkStaticSite(root, profile), /sitemap/)
  put(
    root,
    'dist/sitemap.xml',
    '<urlset><!-- <url><loc>https://example.test/</loc></url> --></urlset>'
  )
  assert.throws(() => checkStaticSite(root, profile), /absent from sitemap/)
})

test('owned paths reject traversal, normal and dangling symlinks', (t) => {
  const root = temp(t)
  put(root, 'file', 'a')
  assert.throws(() => ownedPath(root, '../other'), /escapes/)
  assert.throws(() => ownedPath(root, root), /relative/)
  symlinkSync('file', join(root, 'link'))
  symlinkSync('missing', join(root, 'dangling'))
  assert.throws(() => ownedPath(root, 'link'), /Symlinks/)
  assert.throws(() => ownedPath(root, 'dangling/nested'), /Symlinks/)
})

function worker() {
  return {
    files: ['worker.js'],
    buildCommand: [
      process.execPath,
      '-e',
      'require("node:fs").writeFileSync(process.env.CODE_FOUNDRY_QUALITY_OUTPUT_DIR + "/worker.js", "export default {}")',
    ],
    runtimeCommand: [process.execPath, '-e', 'process.exit(0)'],
    budgets: { rawBytes: 100, gzipBytes: 100 },
  }
}
test('Worker profile checks a newly produced bundle and executes native runtime check', (t) => {
  const root = temp(t)
  assert.equal(checkWorker(root, worker(), root).rawBytes, 17)
})
test('Worker limits, missing outputs and runtime failures reject candidates', (t) => {
  const root = temp(t)
  const profile = worker()
  profile.budgets.rawBytes = 0
  assert.throws(() => checkWorker(root, profile, root), /budget exceeded/)
  profile.budgets.rawBytes = 100
  profile.runtimeCommand = [process.execPath, '-e', 'process.exit(3)']
  assert.throws(() => checkWorker(root, profile, root), /Quality command failed/)
  profile.files = ['missing.js']
  assert.throws(() => checkWorker(root, profile, root), /ENOENT/)
})

test('quality commands do not shell-expand arguments and propagate failures', (t) => {
  const root = temp(t)
  assert.match(
    runQualityCommand(
      [process.execPath, '-e', 'console.log(process.argv[1])', '$HOME; echo injected'],
      root,
      root
    ),
    /\$HOME; echo injected/
  )
  assert.throws(() => runQualityCommand('echo hi', root, root), /argv/)
  assert.throws(
    () => runQualityCommand([process.execPath, '-e', 'process.exit(2)'], root, root),
    /failed/
  )
})

test('package profile installs and imports the actual tarball offline without lifecycle scripts', (t) => {
  const root = temp(t)
  put(
    root,
    'package.json',
    JSON.stringify({
      name: 'foundry-fixture-package',
      version: '1.0.0',
      type: 'module',
      exports: './index.mjs',
      files: ['index.mjs'],
      scripts: { prepack: 'exit 88', postinstall: 'exit 88' },
    })
  )
  put(root, 'index.mjs', 'export const value = 1\n')
  const result = checkPackage(root, { imports: ['foundry-fixture-package'] }, root)
  assert.match(result.archiveSha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(result.runtimes, ['node'])
  assert.throws(
    () => checkPackage(root, { imports: ['node:fs'] }, root),
    /candidate package exports/
  )
  assert.throws(
    () => checkPackage(root, { imports: ['foundry-fixture-package'], runtimes: [] }, root),
    /nonempty/
  )
})

test('browser profiles retain reviewed baselines and require real journey modules', (t) => {
  const root = temp(t)
  put(root, 'journeys.mjs', 'export {}\n')
  const profile = {
    baseURL: 'http://localhost:4321',
    journeys: 'journeys.mjs',
    routes: [{ id: 'home', path: '/', readySelector: 'h1', visual: true }],
  }
  const { spec, config } = browserFiles(root, profile, root)
  assert.equal(config.updateSnapshots, 'none')
  assert.equal(config.retries, 0)
  assert.match(spec, /@axe-core\/playwright/)
  assert.match(spec, /journeys.mjs/)
  assert.match(spec, /pageerror/)
  assert.equal(config.use.trace, 'retain-on-failure')
  assert.throws(
    () => browserFiles(root, { ...profile, baseURL: 'https://example.test' }, root),
    /allowRemote/
  )
  assert.throws(
    () =>
      browserFiles(
        root,
        { ...profile, routes: [{ ...profile.routes[0], path: '//example.test/' }] },
        root
      ),
    /selected origin/
  )
  assert.throws(
    () => browserFiles(root, { ...profile, routes: [...profile.routes, ...profile.routes] }, root),
    /Duplicate/
  )
  assert.throws(
    () => browserFiles(root, { ...profile, baseURL: 'http://localhost:4321/app/' }, root),
    /baseURL/
  )
  assert.throws(
    () => browserFiles(root, { ...profile, webServerCommand: [] }, root),
    /webServerCommand/
  )
})

test('manifest runner creates fresh failure evidence and does not treat inapplicable work as success', (t) => {
  const { root, profile } = site(t)
  const config = { schema_version: 1, profiles: [profile] }
  const result = runProductQuality(root, config)
  assert.equal(result.status, 'passed')
  assert.match(result.config_sha256, /^[a-f0-9]{64}$/)
  profile.budgets.javascriptBytes = 0
  assert.throws(() => runProductQuality(root, config), /budget exceeded/)
  const runs = readdirSync(join(root, '.code-foundry/quality'))
  assert.equal(runs.length, 2)
  const reports = runs.map((name) =>
    JSON.parse(readFileSync(join(root, '.code-foundry/quality', name, 'summary.json')))
  )
  const failed = reports.find((x) => x.status === 'failed')
  assert.equal(failed.profiles[0].status, 'failed')
  assert.match(failed.profiles[0].reason, /budget exceeded/)
  assert.throws(() => runProductQuality(root, config, 'browser'), /No profiles/)
  assert.throws(
    () =>
      runProductQuality(root, { schema_version: 1, profiles: [{ id: 'bad', type: 'unknown' }] }),
    /Unknown quality/
  )
})

test('browser evidence rejects absent routes, expected failures and empty results', () => {
  const spec = (title) => ({
    title,
    ok: true,
    tests: [{ expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed' }] }],
  })
  const report = {
    stats: { unexpected: 0, flaky: 0, skipped: 0, expected: 2 },
    suites: [{ specs: [spec('quality: home'), spec('real checkout journey')] }],
  }
  validateBrowserReport(report, ['quality: home'])
  assert.throws(() => validateBrowserReport(report, ['quality: missing']), /Missing/)
  report.suites[0].specs[1].tests[0].expectedStatus = 'failed'
  assert.throws(() => validateBrowserReport(report, ['quality: home']), /Expected failures/)
  report.suites[0].specs[1].tests[0].expectedStatus = 'passed'
  report.suites[0].specs[1].tests[0].results = []
  assert.throws(() => validateBrowserReport(report, ['quality: home']), /incomplete/)
})
