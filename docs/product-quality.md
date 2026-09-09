# Product Quality Profiles

Opt-in acceptance checks for built sites, interactive applications, Workers, and packages.

**Status:** Additive runner; existing repositories are not opted in automatically.
**Evidence:** Fresh per-run reports under `.code-foundry/quality/`.

## Activation

Commit a version-1 JSON manifest and use the installed, pinned Foundry runtime:

```json
{
  "scripts": {
    "quality:build": "node node_modules/code-foundry/src/quality.mjs .github/product-quality.json build",
    "quality:browser": "node node_modules/code-foundry/src/quality.mjs .github/product-quality.json browser"
  }
}
```

Wire these scripts into the consumer's existing validation entrypoints. The
Foundry runtime discovers only `performance:check`/`perf:check` and
`test:e2e`/`e2e`; if those names do not already exist, they can run
`bun run quality:build` and `bun run quality:browser`. If they do exist, preserve their current
commands and compose the quality command after them rather than replacing the
existing performance or E2E checks. The standalone entrypoint deliberately avoids
changing the public CLI dispatch being introduced in the separate agent-validation
PR. Install the reviewed Foundry version in the consumer's existing dependency
manager and lockfile, not an unpinned network invocation. Add `.code-foundry/` to
Git/package ignores and retain selected evidence through the consumer workflow's
artifact uploader. Reports and browser traces may contain application data; review
retention and never upload authenticated traces publicly without sanitization.

```json
{
  "schema_version": 1,
  "prepare": { "build": [["bun", "run", "build"]] },
  "profiles": [
    {
      "id": "marketing",
      "type": "static-site",
      "dist": "dist",
      "origin": "https://example.com",
      "routes": [{ "path": "/", "html": "index.html", "javascriptAssets": [] }],
      "budgets": { "htmlBytes": 100000, "javascriptBytes": 80000, "imageBytes": 600000 },
      "sitemap": "sitemap.xml",
      "robots": "robots.txt",
      "redirects": { "file": "_redirects", "rules": [{ "from": "/old", "to": "/", "status": 301 }] }
    }
  ]
}
```

Example numbers are not fleet defaults. Measure and review thresholds in the
consumer repository. `prepare` runs once per selected phase, so several profiles
can share one build without repeating it. A phase with no applicable profiles
fails instead of pretending to validate something. Available phases are `build`,
`browser`, and `deployed`; assign a profile's `phase` explicitly to override its
default (`browser` for web-app, `build` for the others).

## Static sites

The static profile checks explicit rendered routes for titles, descriptions,
canonical identity, accidental noindex, local links/anchors, directly referenced
resources, declared additional JavaScript chunks, sitemap inclusion, robots
sitemap declaration, and exact simple `_redirects` rules. All responsive image
candidates count toward the asset budget. Budgets measure build bytes, not an
estimate of browser transfer size or Core Web Vitals. `javascriptAssets` must
include transitive chunks selected from the consumer's bundler manifest; this
runner does not invent a framework dependency graph. External resources fail
closed rather than being treated as zero-byte dependencies.

This conservative generated-HTML parser is not a browser DOM or a complete HTML
conformance validator. Complex base-element routing, sitemap indexes, wildcard or
conditional redirects, client-only metadata, and CDN behavior need repository-owned
or deployed tests. All generated/public routes should be declared (or the manifest
generated from the framework's route output) to avoid untested routes. Redirect
checks prove the artifact declaration, not production routing behavior.

## Interactive applications

```json
{
  "id": "application",
  "type": "web-app",
  "baseURL": "http://127.0.0.1:4321",
  "webServerCommand": "bun run preview --host 127.0.0.1",
  "journeys": "tests/quality-journeys.mjs",
  "snapshots": "tests/quality-snapshots",
  "routes": [{ "id": "home", "path": "/", "readySelector": "main h1", "visual": true }]
}
```

`baseURL` must be an HTTP(S) origin without a path, query, or fragment; routes
are root-relative paths on that origin. Use the repository's locked
`@playwright/test`, `@axe-core/playwright`, and matching Chromium installation.
No browser tooling is silently downloaded. The runner
imports the consumer's journey module and requires at least one additional real
passing test beyond its generated route tests. Skips, flakes, expected-failure
annotations, incomplete results, and missing routes fail the evidence check.
Each generated route validates navigation, waits for the declared readiness
selector, checks page runtime errors, and performs axe WCAG 2/2.1 A/AA checks.
Automation does not establish complete accessibility compliance.

Selected visual routes compare repository-owned baselines with
`updateSnapshots: none`. Missing baselines fail; this runner never approves them.
Create and review baselines separately in the same browser/OS/font environment.
The generated configuration fixes Chromium, viewport, retries, and screenshot
animation handling; specialized device/authentication fixtures remain in the
consumer's journey tests. Remote base URLs require explicit `allowRemote: true`;
that is consent to network testing, not isolation. Secrets, account fixtures, and
production-safe test behavior remain the consumer's responsibility.

## Cloudflare Workers

```json
{
  "id": "worker",
  "type": "worker",
  "buildCommand": ["bun", "run", "worker:bundle", "{output}"],
  "files": ["worker.js"],
  "budgets": { "rawBytes": 1000000, "gzipBytes": 250000 },
  "runtimeCommand": ["bun", "run", "worker:compatibility", "{output}"]
}
```

The build command must emit selected bundles into the fresh output directory.
`{output}` arguments and `CODE_FOUNDRY_QUALITY_OUTPUT_DIR` expose that directory.
Raw bytes and the sum of individually gzipped files are measured; they are not
claimed to equal Cloudflare's uploaded aggregate size or startup limits. Use
locked Wrangler/workerd to test compatibility dates, flags, and bindings in the
mandatory native runtime command. Production smoke probes belong in the verified
delivery workflow, not a hidden dependency of the deterministic build phase.
No Worker, Durable Object, binding, migration, or production resource is created.

## Published packages

```json
{
  "id": "package",
  "type": "package",
  "imports": ["my-package", "my-package/feature"],
  "runtimes": ["node"],
  "offline": true
}
```

The package profile packs once without lifecycle scripts, installs that archive
into an isolated temporary consumer, and exercises declared package exports using
Node and/or Bun already installed on the runner. Run build/test preparation
explicitly first. Both install scripts and package lifecycle hooks are disabled;
packages requiring installation hooks need a separately reviewed specialized
consumer suite. Runtime dependencies must be cached for the default offline mode;
`offline: false` explicitly permits normal registry resolution. Temporary package
installations are removed. Evidence is rejected if it leaks into the package.

## Evidence and trust

Each summary has a unique run ID, manifest hash, phase, source commit/dirty status
when available, per-profile metrics or failure reasons, and final status. A new
output directory prevents old reports from becoming current evidence. The source
fields are descriptive, not a signed dirty-worktree snapshot. Commands are argv
arrays without shell expansion; repository-owned commands still have the normal
permissions of the executing process and are not sandboxed. Playwright's optional
web-server command is its native shell-command interface and must be reviewed.

The runner does not replace Lighthouse CI, native application tests, manual
accessibility testing, real consumer canaries, or release provenance. Existing
Lighthouse assertions can remain in repository-owned scripts/preparation; no
Lighthouse score or threshold is silently introduced by this feature.

References: [Playwright accessibility](https://playwright.dev/docs/accessibility-testing),
[Playwright snapshot configuration](https://playwright.dev/docs/api/class-testconfig#test-config-update-snapshots).
