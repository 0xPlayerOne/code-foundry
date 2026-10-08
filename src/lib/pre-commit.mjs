// @ts-check

/**
 * Change-aware planning for the local commit gate.
 *
 * The gate runs once per commit and blocks every agent or developer sharing a
 * checkout, so it only does work the staged change can affect: format and lint
 * the staged files, type-check only when a typed source or compiler config is
 * staged, and leave the build to CI unless a repository opts back in with
 * `pre_commit_build: true`. Repository-wide runs happen only when a staged file
 * changes the tool's own configuration, because that can affect every file.
 */

/** Files Oxfmt formats; anything else is left out of the staged file list. */
const FORMATTABLE =
  /\.(?:[cm]?[jt]sx?|json[c5]?|mdx?|ya?ml|toml|css|scss|less|html?|vue|svelte|astro|graphql|gql|hbs|handlebars)$/i
/** Files Oxlint lints. */
const LINTABLE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i
/** Typed sources and compiler configuration: the type-check trigger. */
const TYPED = /\.(?:ts|tsx|mts|cts)$|(?:^|\/)tsconfig[^/]*\.json$/i
/** JavaScript sources, type-checked only when the repository opts in with a root jsconfig. */
const JAVASCRIPT = /\.(?:js|jsx|mjs|cjs)$|(?:^|\/)jsconfig[^/]*\.json$/i
const FORMAT_CONFIG = /^(?:\.oxfmtrc\.jsonc?|oxfmt\.config\.[^/]+|\.prettierignore)$/
const LINT_CONFIG = /^(?:\.oxlintrc\.json|oxlint\.config\.[^/]+)$/
const PYTHON = /\.pyi?$/i
const PYTHON_CONFIG =
  /^(?:pyproject\.toml|ruff\.toml|\.ruff\.toml)$|(?:^|\/)requirements[^/]*\.txt$/
const RUST = /\.rs$|(?:^|\/)Cargo\.toml$/

/**
 * @typedef {object} PreCommitPlan
 * @property {boolean} formatAll A formatter configuration file is staged.
 * @property {string[]} formatFiles Staged files the formatter should check.
 * @property {boolean} lintAll A linter configuration file is staged.
 * @property {string[]} lintFiles Staged files the linter should check.
 * @property {boolean} typeCheck Run the project's type-check command.
 * @property {boolean} pythonAll A Python tool configuration file is staged.
 * @property {string[]} pythonFiles Staged Python files.
 * @property {boolean} rust Rust sources or manifests are staged.
 * @property {boolean} build Run the project's build command.
 */

/**
 * @param {string[]} staged Repository-relative paths of staged files that still exist.
 * @param {{checkJs?: boolean, build?: boolean}} [options]
 * @returns {PreCommitPlan}
 */
export function planPreCommit(staged, options = {}) {
  const formatAll = staged.some((file) => FORMAT_CONFIG.test(file))
  const lintAll = staged.some((file) => LINT_CONFIG.test(file))
  const pythonAll = staged.some((file) => PYTHON_CONFIG.test(file))
  const formatFiles = staged.filter((file) => FORMATTABLE.test(file))
  const lintFiles = staged.filter((file) => LINTABLE.test(file))
  const pythonFiles = staged.filter((file) => PYTHON.test(file))
  const typeCheck = staged.some(
    (file) => TYPED.test(file) || (options.checkJs === true && JAVASCRIPT.test(file))
  )
  const rust = staged.some((file) => RUST.test(file))
  const code =
    typeCheck ||
    lintFiles.length > 0 ||
    pythonFiles.length > 0 ||
    rust ||
    staged.some((file) => /(?:^|\/)package\.json$/.test(file))
  return {
    formatAll,
    formatFiles,
    lintAll,
    lintFiles,
    typeCheck,
    pythonAll,
    pythonFiles,
    rust,
    build: options.build === true && code,
  }
}

/**
 * Parse `git diff --cached --name-only -z` output.
 * @param {string} output
 * @returns {string[]}
 */
export function parseStagedFiles(output) {
  return output.split('\0').filter(Boolean)
}

/**
 * Resolve the `pre_commit_build` configuration value. Building at commit time
 * is opt-in: it serializes parallel work on a shared checkout and CI rebuilds
 * every change anyway.
 * @param {string|undefined} value
 * @returns {boolean}
 */
export function preCommitBuildEnabled(value) {
  const resolved = value === undefined || value === '' ? 'false' : value
  if (resolved !== 'true' && resolved !== 'false')
    throw new Error(`Unsupported pre_commit_build: ${resolved}; use true or false.`)
  return resolved === 'true'
}

/**
 * The one-line explanation printed when lint or type-check fails while the
 * commit-time build is disabled. CI builds before those tasks, so a fresh
 * clone can fail the gate against an unmodified tree — a bare ENOENT trains
 * `--no-verify` unless the gate names the actual problem.
 *
 * @param {{ build: boolean, buildScript: boolean, packageManager: string | null }} options
 * @returns {string | undefined} The hint, or undefined when it cannot apply.
 */
export function freshCloneBuildHint({ build, buildScript, packageManager }) {
  if (build || !buildScript) return undefined
  const runner = packageManager ?? 'npm'
  return (
    `note: these checks may be reading missing build output on a fresh clone; ` +
    `run "${runner} run build" once, or set pre_commit_build: true in ` +
    `.github/code-foundry.yml to build before lint and type-check`
  )
}

/**
 * Split a file list so one tool invocation never exceeds the platform's
 * argument-length limit on very large commits.
 * @param {string[]} files
 * @param {number} [size]
 * @returns {string[][]}
 */
export function chunkFiles(files, size = 200) {
  /** @type {string[][]} */
  const chunks = []
  for (let index = 0; index < files.length; index += size)
    chunks.push(files.slice(index, index + size))
  return chunks
}
