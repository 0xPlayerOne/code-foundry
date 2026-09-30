import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const workflow = readFileSync(
  new URL('../.github/workflows/cloudflare-deploy.yml', import.meta.url),
  'utf8'
)
const configuration = readFileSync(new URL('../docs/CONFIGURATION.md', import.meta.url), 'utf8')

const indentOf = (line) => line.length - line.trimStart().length

/**
 * The two mode branches of the `deploy-tool: cf` path.
 *
 * Matches trimmed whole lines *and* indentation. Matching text alone picks the
 * wrong block as soon as a branch nests its own `if`/`else`/`fi` — which the
 * production branch now does to surface deploy failures. Matching substrings
 * alone is worse: `fi` appears inside the word "first" and silently truncates
 * the branch it is meant to bound.
 */
function cfModeBranches() {
  const lines = workflow.split('\n')
  const at = (trimmed, from, indent) =>
    lines.findIndex(
      (line, index) => index >= from && line.trim() === trimmed && indentOf(line) === indent
    )

  const openAt = lines.findIndex((line) => line.trim() === 'if [ "$DEPLOY_TOOL" = cf ]; then')
  assert.notEqual(openAt, -1, 'expected a deploy-tool cf branch')
  const branchIndent = indentOf(lines[openAt])
  const body = branchIndent + 2

  const production = at('if [ "$MODE" = production ]; then', openAt, body)
  assert.notEqual(production, -1, 'expected a production branch in the cf deploy path')

  const split = at('else', production, body)
  assert.notEqual(split, -1, 'expected a preview branch in the cf deploy path')

  const close = at('fi', split, body)
  assert.notEqual(close, -1, 'expected the cf deploy path to be closed')

  return {
    production: lines.slice(production, split),
    preview: lines.slice(split, close),
  }
}

/** Offset of the first line containing `fragment`, or -1. */
function lineIndexOf(lines, fragment) {
  return lines.findIndex((line) => line.includes(fragment))
}

describe('cf deploy path packages a Build Output before every prebuilt deploy', () => {
  // `cf deploy --prebuilt` uploads the Build Output Specification and builds
  // nothing. The only step that produces one is the project's own
  // `cf-wrangler build` delegate, so both modes must run it or the deploy dies
  // with "Build Output Specification: no root config found". Production lost
  // that call while the preview path was repaired twice (#660, then again for
  // the prebuilt preview deploy), so every cf consumer's production deploy was
  // red — and both repairs shipped without a test asserting the invariant.
  it('builds production mode before the prebuilt production deploy', () => {
    const { production } = cfModeBranches()

    const build = lineIndexOf(production, 'cf-wrangler build')
    const deploy = lineIndexOf(production, 'cf deploy --prebuilt')
    assert.notEqual(build, -1, 'production must package a Build Output before deploying')
    assert.notEqual(deploy, -1, 'production must deploy the prebuilt Build Output')
    assert.ok(build < deploy, 'the Build Output must be packaged before the deploy consumes it')
    // Production is the delegate's default mode; only previews pass flags, so
    // the production build must be a bare `cf-wrangler build` line.
    assert.ok(
      production.some((line) => line.trim() === 'cf-wrangler build'),
      'production must build without preview flags'
    )
  })

  it('builds preview mode before the prebuilt preview deploy', () => {
    const { preview } = cfModeBranches()

    const build = lineIndexOf(preview, 'cf-wrangler build --mode preview')
    const deploy = lineIndexOf(preview, 'cf previews deploy --prebuilt')
    assert.notEqual(build, -1, 'previews must package a preview Build Output before deploying')
    assert.notEqual(deploy, -1, 'previews must deploy the prebuilt Build Output')
    assert.ok(build < deploy, 'the preview Build Output must exist before the deploy consumes it')
  })

  it('surfaces the deploy error instead of discarding it on stdout', () => {
    // cf reports failures on stdout. Capturing it in `out="$(cf deploy)"`
    // under `set -e` discarded the only diagnostic, so a failing deploy left
    // the log with a bare "exit code 1" and no cause. Both modes must
    // re-emit the captured output when the command fails.
    const { production, preview } = cfModeBranches()
    const productionBody = production.join('\n')
    const previewBody = preview.join('\n')

    assert.ok(
      productionBody.includes('if out="$(cf deploy --prebuilt)"; then'),
      'production must guard the capture so a failure can be reported'
    )
    assert.ok(
      productionBody.includes(`printf '%s\\n' "$out" >&2`),
      'production must re-emit the captured output when the deploy fails'
    )
    assert.ok(
      productionBody.includes('exit "$status"'),
      'production must preserve the deploy exit status'
    )

    assert.ok(
      previewBody.includes('if ! cf previews deploy --prebuilt "$PREVIEW_NAME"'),
      'previews must guard the capture so a failure can be reported'
    )
    assert.ok(
      previewBody.includes('cat "$RUNNER_TEMP/cf-preview.json" >&2'),
      'previews must re-emit the captured output when the deploy fails'
    )
  })

  it('documents the production packaging the workflow performs', () => {
    // docs/CONFIGURATION.md has promised `cf-wrangler build` plus
    // `cf deploy --prebuilt` for production since the cf path landed, so the
    // missing call was a code bug rather than a doc or design gap. Pin the
    // claim to the implementation so the two cannot drift apart again.
    const prose = configuration.replace(/\s+/g, ' ')
    assert.match(
      prose,
      /production runs `cf-wrangler build` plus `cf deploy --prebuilt` \(consuming the project's cf Build Output\)/
    )
  })
})
