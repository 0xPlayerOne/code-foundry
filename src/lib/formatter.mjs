// @ts-check

/** Explicit formatter choices. An absent key preserves repository-script precedence. */
export const FORMATTERS = Object.freeze(['oxfmt', 'prettier', 'bun'])

/** @param {string|undefined} value */
export function formatterChoice(value) {
  const choice = value || 'oxfmt'
  if (!FORMATTERS.includes(choice))
    throw new Error(`Unsupported formatter: ${choice}; use oxfmt, prettier, or bun.`)
  return choice
}

/** @param {string|undefined} value @param {{check?: boolean, staged?: boolean, changed?: string, files?: string[]}} [options] */
export function formatterCommand(value, options = {}) {
  const choice = formatterChoice(value)
  const { check = true, staged = false, changed, files = ['.'] } = options
  if (staged && changed !== undefined) throw new Error('--staged and --changed are exclusive')
  if ((staged || changed !== undefined) && choice !== 'bun')
    throw new Error('--staged and --changed require formatter: bun')
  if (changed !== undefined && (!changed.trim() || changed.startsWith('-')))
    throw new Error('--changed requires a Git branch or commit')
  if (choice === 'bun')
    return [
      'bun',
      'fmt',
      '--no-script',
      ...(check ? ['--check'] : []),
      ...(staged ? ['--staged'] : changed !== undefined ? [`--changed=${changed}`] : files),
    ]
  return [choice, ...(check ? ['--check'] : ['--write']), ...files]
}
